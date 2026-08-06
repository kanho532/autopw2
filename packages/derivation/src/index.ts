import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { DiscoveryResult } from "@autopw/discovery";
import { planExecutionInstances, type MatrixProfile, type ExecutionProjection } from "@autopw/planner";

export type Tier = "smoke" | "fast" | "full";
export type CoverageStatus = "PLANNED" | "BLOCKED" | "NOT_APPLICABLE" | "TIER_SKIPPED";
export interface DiffResult { status: "NOOP" | "CHANGED"; changed_files: { status: string; path: string; feature_ids: string[]; new_feature: boolean }[]; affected_features: string[]; new_features: string[]; }
export interface DerivationInput { discovery: DiscoveryResult; tier: Tier; diff?: DiffResult; matrix?: MatrixProfile; mandatory_capabilities?: { id: string; priority: "P0" | "P1" | "P2"; feature_ids: string[]; on_missing: "incomplete" | "warn" }[]; input_versions?: Record<string, string>; }
export interface Skeleton { case_id: string; feature_id: string; scenario: string; priority: "P0" | "P1" | "P2"; effective_tier: Tier; status: CoverageStatus; matrix_cell: string; blocked: boolean; reason?: string; }
export interface DerivationResult { schema_version: "2.1"; skeleton: Skeleton[]; matrix: Record<string, unknown>[]; p0_required_total: number; p0_coverage_pct: number | null; input_versions: Record<string, string>; metrics: { derivation_cpu_ms: number }; projection: ExecutionProjection; cdd: Record<string, unknown>; }

export function deriveCoverage(input: DerivationInput): DerivationResult {
  const started = performance.now();
  const diff = input.diff || { status: "NOOP", changed_files: [], affected_features: [], new_features: [] };
  const mandatory = input.mandatory_capabilities || [];
  const observed = input.discovery.scenario_observations;
  const skeleton: Skeleton[] = observed.map((observation) => {
    const affected = diff.affected_features.includes(observation.feature_id);
    const isNew = diff.new_features.includes(observation.feature_id);
    const effective_tier: Tier = input.tier === "full" ? "full" : input.tier === "smoke" ? "smoke" : affected && !isNew ? "smoke" : "fast";
    const mandatoryCapability = mandatory.find((capability) => capability.feature_ids.includes(observation.feature_id));
    const blocked = !observation.observed || (observation.blocker && !observation.observed) || (mandatoryCapability?.on_missing === "incomplete" && !observation.observed);
    const status: CoverageStatus = blocked ? "BLOCKED" : observation.observed ? "PLANNED" : "NOT_APPLICABLE";
    return { case_id: caseId(observation.feature_id, observation.scenario), feature_id: observation.feature_id, scenario: observation.scenario, priority: observation.priority, effective_tier, status, matrix_cell: observation.feature_id + ":" + effective_tier, blocked, ...(blocked ? { reason: observation.reason || "OBJECTIVE_BLOCKER" } : {}) };
  });
  for (const capability of mandatory) {
    for (const feature_id of capability.feature_ids) {
      if (observed.some((item) => item.feature_id === feature_id)) continue;
      skeleton.push({ case_id: caseId(feature_id, "mandatory_capability"), feature_id, scenario: "normal", priority: capability.priority, effective_tier: input.tier, status: capability.on_missing === "incomplete" ? "BLOCKED" : "PLANNED", matrix_cell: feature_id + ":" + input.tier, blocked: capability.on_missing === "incomplete", ...(capability.on_missing === "incomplete" ? { reason: "MANDATORY_CAPABILITY_NOT_OBSERVED" } : {}) });
    }
  }
  skeleton.sort((a, b) => a.case_id.localeCompare(b.case_id));
  const projection = planExecutionInstances(skeleton.filter((item) => item.status === "PLANNED" || item.status === "BLOCKED"), input.tier, input.matrix);
  const p0 = skeleton.filter((item) => item.priority === "P0" && item.status !== "TIER_SKIPPED" && item.status !== "NOT_APPLICABLE");
  const coveredP0 = p0.filter((item) => item.status === "PLANNED" && !item.blocked).length;
  const p0Blocked = p0.some((item) => item.blocked);
  const p0_coverage_pct = p0.length === 0 ? null : Math.round((coveredP0 / p0.length) * 10000) / 100;
  const input_versions = { engine_version: "2.1.0-m3", schema_version_bundle: "2.1", ...(input.input_versions || {}) };
  const metrics = { derivation_cpu_ms: Math.max(0, Math.round(performance.now() - started)) };
  return { schema_version: "2.1", skeleton, matrix: projection.batches as unknown as Record<string, unknown>[], p0_required_total: p0.length, p0_coverage_pct: p0Blocked ? 0 : p0_coverage_pct, input_versions, metrics, projection, cdd: { title: "Coverage Development Description", scope: skeleton.map((item) => ({ case_id: item.case_id, feature_id: item.feature_id, scenario: item.scenario, effective_tier: item.effective_tier, status: item.status })), blockers: skeleton.filter((item) => item.blocked).map((item) => ({ case_id: item.case_id, reason: item.reason })), candidates: input.discovery.candidates.map((candidate) => ({ id: candidate.id, kind: candidate.kind, feature_id: candidate.feature_id })) } };
}

export function analyzeDiff({ diffRef, root, mappings = [] }: { diffRef?: string; root?: string; mappings?: { file_glob: string; features: string[]; propagate?: boolean }[] }): DiffResult {
  if (!diffRef || diffRef === "NOOP" || diffRef === "empty") return { status: "NOOP", changed_files: [], affected_features: [], new_features: [] };
  let changed: { status: string; path: string }[] = [];
  if (root) {
    try {
      const output = execFileSync("git", ["diff", "--name-status", "--find-renames", diffRef], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      changed = output.split(/\r?\n/).filter(Boolean).map((line) => { const parts = line.split("\t"); return { status: parts[0].charAt(0), path: parts[0].charAt(0) === "R" ? parts[2] || parts[1] : parts[1] || "" }; }).filter((item) => item.path.length > 0);
    } catch { changed = []; }
  }
  if (changed.length === 0 && !root) {
    const paths = diffRef.split("...").map((value) => value.trim()).filter(Boolean);
    changed = paths.length === 0 ? [] : [{ status: "M", path: paths[paths.length - 1] }];
  }
  const changed_files = changed.map((item) => ({ ...item, feature_ids: [] as string[], new_feature: item.status === "A" }));
  const affected = new Set<string>();
  const newFeatures = new Set<string>();
  for (const file of changed_files) for (const mapping of mappings) if (globMatches(mapping.file_glob, file.path)) { for (const feature of mapping.features) { affected.add(feature); if (file.status === "A") newFeatures.add(feature); } }
  return { status: changed_files.length ? "CHANGED" : "NOOP", changed_files: changed_files.map((file) => ({ ...file, feature_ids: [...affected].sort(), new_feature: newFeatures.size > 0 })), affected_features: [...affected].sort(), new_features: [...newFeatures].sort() };
}

export function caseId(feature: string, scenario: string): string { return "case_" + feature.replace(/[^A-Za-z0-9_.:-]+/g, "_") + "_" + scenario.replace(/[^A-Za-z0-9_.:-]+/g, "_"); }
function globMatches(glob: string, value: string): boolean { const pattern = "^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", ".*").replaceAll("*", "[^/]*") + "$"; return new RegExp(pattern).test(value); }
function digest(value: string): string { return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16); }
export { digest };
