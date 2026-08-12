export const TRIAGE_SCHEMA_VERSION = "autopw.triage/1.0" as const;
export type TriageClassification = "PRODUCT_DEFECT" | "PLAN_DEFECT" | "TEST_DEFECT" | "INFRA_DEFECT";
export interface TriageSignal { code?: string; kind?: "assertion" | "contract" | "network" | "timeout" | "policy" | "unknown"; phase?: "setup" | "test" | "cleanup" | "unknown"; action?: string; expected?: unknown; actual?: unknown; }
export interface TriageInput {
  proposed_classification?: TriageClassification;
  signal?: TriageSignal;
  plan_origin?: string;
  case_confidence?: number;
  evidence_refs?: string[];
  requirement_evidence_refs?: string[];
  oracle?: { kind?: string; proven?: boolean };
}
export interface TriageDecision {
  schema_version: typeof TRIAGE_SCHEMA_VERSION;
  classification: TriageClassification;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  plan_origin: string;
  evidence_strength: "HIGH" | "MEDIUM" | "LOW";
  oracle_strength: "STRONG" | "BASIC" | "UNPROVEN";
  phase: "setup" | "test" | "cleanup" | "unknown";
  reason: string;
  expected?: unknown;
  actual?: unknown;
}

export function triageFailure(input: TriageInput): TriageDecision {
  const origin = input.plan_origin || "unknown";
  const phase = input.signal?.phase || "unknown";
  const evidenceStrength = strength(input.case_confidence, [...(input.evidence_refs || []), ...(input.requirement_evidence_refs || [])]);
  const oracleStrength: TriageDecision["oracle_strength"] = !input.oracle?.proven ? "UNPROVEN" : ["relation", "collection", "persistence", "deletion", "validation", "semantic", "ui_relation"].includes(input.oracle.kind || "") ? "STRONG" : "BASIC";
  const base = { schema_version: TRIAGE_SCHEMA_VERSION, plan_origin: origin, evidence_strength: evidenceStrength, oracle_strength: oracleStrength, phase, ...(Object.hasOwn(input.signal || {}, "expected") ? { expected: input.signal?.expected } : {}), ...(Object.hasOwn(input.signal || {}, "actual") ? { actual: input.signal?.actual } : {}) };
  if (input.signal?.kind === "network" || input.proposed_classification === "INFRA_DEFECT") return { ...base, classification: "INFRA_DEFECT", confidence: "MEDIUM", reason: "LOW_LEVEL_INFRASTRUCTURE_SIGNAL" };
  if (phase === "setup" || phase === "cleanup") return { ...base, classification: origin === "generated" ? "PLAN_DEFECT" : "TEST_DEFECT", confidence: evidenceStrength === "LOW" ? "LOW" : "MEDIUM", reason: "FIXTURE_OR_LIFECYCLE_PHASE_FAILURE" };
  if (input.signal?.kind === "contract" || input.signal?.kind === "policy" || input.signal?.kind === "timeout") return { ...base, classification: origin === "generated" ? "PLAN_DEFECT" : "TEST_DEFECT", confidence: evidenceStrength === "LOW" ? "LOW" : "MEDIUM", reason: "PLAN_CONTRACT_OR_POLICY_FAILURE" };
  if (input.signal?.kind === "assertion" && phase === "test" && evidenceStrength === "HIGH" && oracleStrength !== "UNPROVEN") return { ...base, classification: "PRODUCT_DEFECT", confidence: oracleStrength === "STRONG" ? "HIGH" : "MEDIUM", reason: "EVIDENCE_BACKED_TEST_ORACLE_MISMATCH" };
  const classification = origin === "generated" ? "PLAN_DEFECT" : input.proposed_classification === "PRODUCT_DEFECT" && evidenceStrength !== "LOW" ? "PRODUCT_DEFECT" : "TEST_DEFECT";
  return { ...base, classification, confidence: classification === "PRODUCT_DEFECT" ? "MEDIUM" : evidenceStrength === "LOW" ? "LOW" : "MEDIUM", reason: classification === "PRODUCT_DEFECT" ? "TRUSTED_MANUAL_ORACLE_MISMATCH" : "INSUFFICIENT_PROVENANCE_FOR_PRODUCT_DEFECT" };
}

function strength(confidence: number | undefined, refs: string[]): "HIGH" | "MEDIUM" | "LOW" { const value = typeof confidence === "number" && Number.isFinite(confidence) ? confidence : 0.5; if (value >= 0.85 && refs.length > 0) return "HIGH"; if (value >= 0.6 || refs.length > 0) return "MEDIUM"; return "LOW"; }
