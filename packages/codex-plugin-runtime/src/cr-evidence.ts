import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ReviewTier = "fast" | "full";

export interface PrepareCrEvidenceOptions {
  sourceRoot: string;
  workspaceRoot: string;
  workspaceId: string;
  runId: string;
  reviewTier: ReviewTier;
  project?: string;
}

interface ArtifactIndexEntry {
  relative_path?: string;
  kind?: string;
  size_bytes?: number;
  sha256?: string;
  display_name?: string;
}

interface ArtifactIndex {
  schema_version?: string;
  artifacts?: Record<string, ArtifactIndexEntry>;
}

interface ExportedArtifact {
  relative_path: string;
  kind: string;
  size_bytes: number;
  sha256: string;
  source_handle?: string;
  display_name?: string;
}

const RUN_ID = /^run_[A-Za-z0-9_-]+$/;
const METADATA_FILES = [
  "artifact-index.json",
  "application-graph.json",
  "derivation.json",
  "discovery.json",
  "evidence-facts.json",
  "evidence-manifest.json",
  "execution-manifest.json",
  "latest.json",
  "mapping-audit.json",
  "plan.json",
  "requirement-coverage.json",
  "run_state.json",
];
const REPORT_FILES = ["report.md", "report.html", "results.json", "suite.ts"];

export function prepareCrEvidence(options: PrepareCrEvidenceOptions): Record<string, unknown> {
  if (!RUN_ID.test(options.runId)) throw invalid("run_id is invalid");
  const sourceRoot = path.resolve(options.sourceRoot);
  const workspaceRoot = fs.realpathSync.native(options.workspaceRoot);
  const project = safeName(options.project || path.basename(workspaceRoot));
  const destination = path.join(workspaceRoot, ".autopw", "cr-evidence", options.runId);
  const exported: ExportedArtifact[] = [];

  const resultsSource = path.join(sourceRoot, "artifacts", "results.json");
  if (!isFile(resultsSource)) throw Object.assign(new Error("run results are not available"), { code: "CR_EVIDENCE_NOT_READY" });
  const results = readJson(resultsSource);

  fs.mkdirSync(destination, { recursive: true });
  for (const name of METADATA_FILES) copyKnown(sourceRoot, name, destination, `autopw-${path.extname(name) === ".json" ? "metadata" : "artifact"}`, exported);
  for (const name of REPORT_FILES) copyKnown(path.join(sourceRoot, "artifacts"), name, path.join(destination, "artifacts"), reportKind(name), exported);
  copyIndexedEvidence(sourceRoot, destination, exported);

  const crPhases = options.reviewTier === "fast"
    ? ["cr-intake", "cr-evidence", "cr-issues", "cr-gate", "cr-report"]
    : ["cr-intake", "cr-branch-governance", "cr-diff", "cr-scope", "cr-technical-review", "cr-evidence", "cr-issues", "cr-gate", "cr-report"];
  const skippedPhases = options.reviewTier === "fast"
    ? ["cr-branch-governance", "cr-diff", "cr-scope", "cr-technical-review"]
    : [];
  const manifest = {
    schema_version: "1.0",
    kind: "autopw_cr_evidence",
    generated_at: new Date().toISOString(),
    project,
    workspace_id: options.workspaceId,
    run_id: options.runId,
    review_tier: options.reviewTier,
    autopw_result: {
      gate: stringField(results, "gate"),
      audit_status: stringField(results, "audit_status"),
      exit_code: numberField(results, "exit_code"),
      summary: recordField(results, "summary"),
      issues: arrayField(results, "issues"),
    },
    cr_handoff: {
      required_phases: crPhases,
      skipped_phases: skippedPhases,
      skipped_reason: skippedPhases.length ? "fast tier uses evidence-focused CR and must remain stage_report when skipped dimensions are required" : null,
      authoritative_gate: "cr-gate",
      autopw_gate_scope: "test execution only",
      default_report_state: "stage_report",
      instructions: "Treat this bundle as evidence input. Do not derive CR severity or release approval directly from AutoPW test status.",
    },
    artifacts: exported,
  };
  writeJson(path.join(destination, "cr-evidence.json"), manifest);
  return {
    kind: "ok",
    run_id: options.runId,
    review_tier: options.reviewTier,
    evidence_dir: destination,
    manifest_path: path.join(destination, "cr-evidence.json"),
    artifact_count: exported.length,
    cr_phases: crPhases,
    skipped_cr_phases: skippedPhases,
    report_state_hint: "stage_report",
  };
}

function copyIndexedEvidence(sourceRoot: string, destination: string, exported: ExportedArtifact[]): void {
  const indexPath = path.join(sourceRoot, "artifact-index.json");
  if (!isFile(indexPath)) return;
  const index = readJson(indexPath) as ArtifactIndex;
  for (const [handle, entry] of Object.entries(index.artifacts || {})) {
    if (!entry.relative_path || !entry.kind) continue;
    const source = contained(sourceRoot, entry.relative_path);
    if (!isFile(source)) continue;
    if (entry.sha256 && digest(source) !== entry.sha256) throw Object.assign(new Error(`artifact checksum mismatch: ${handle}`), { code: "CR_EVIDENCE_INTEGRITY_FAILED" });
    const output = path.join(destination, "evidence", entry.relative_path);
    copyFile(source, output);
    exported.push({ relative_path: portable(path.relative(destination, output)), kind: entry.kind, size_bytes: fs.statSync(output).size, sha256: digest(output), source_handle: handle, ...(entry.display_name ? { display_name: entry.display_name } : {}) });
  }
}

function copyKnown(sourceDir: string, name: string, destinationDir: string, kind: string, exported: ExportedArtifact[]): void {
  const source = path.join(sourceDir, name);
  if (!isFile(source)) return;
  const output = path.join(destinationDir, name);
  copyFile(source, output);
  const evidenceRoot = destinationDir.endsWith("artifacts") ? path.dirname(destinationDir) : destinationDir;
  exported.push({ relative_path: portable(path.relative(evidenceRoot, output)), kind, size_bytes: fs.statSync(output).size, sha256: digest(output) });
}

function reportKind(name: string): string {
  if (name === "results.json") return "autopw-results";
  if (name === "report.md") return "autopw-markdown-report";
  if (name === "report.html") return "autopw-html-report";
  return "compiled-suite";
}

function copyFile(source: string, output: string): void { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(source, output); }
function contained(root: string, relativePath: string): string { const output = path.resolve(root, relativePath); const relative = path.relative(root, output); if (relative.startsWith("..") || path.isAbsolute(relative)) throw invalid("artifact path escapes the run"); return output; }
function digest(file: string): string { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function isFile(file: string): boolean { return fs.existsSync(file) && fs.statSync(file).isFile(); }
function portable(value: string): string { return value.replaceAll("\\", "/"); }
function readJson(file: string): Record<string, unknown> { return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>; }
function writeJson(file: string, value: unknown): void { fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8"); }
function invalid(message: string): Error & { code: string } { return Object.assign(new Error(message), { code: "INVALID_INPUT" }); }
function safeName(value: string): string { const output = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""); if (!output) throw invalid("project is invalid"); return output.slice(0, 64); }
function stringField(value: Record<string, unknown>, key: string): string | null { return typeof value[key] === "string" ? value[key] : null; }
function numberField(value: Record<string, unknown>, key: string): number | null { return typeof value[key] === "number" ? value[key] : null; }
function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> { return value[key] && typeof value[key] === "object" && !Array.isArray(value[key]) ? value[key] as Record<string, unknown> : {}; }
function arrayField(value: Record<string, unknown>, key: string): unknown[] { return Array.isArray(value[key]) ? value[key] : []; }
