// Persistent JSON Schema bundle definitions. Draft 2020-12, unique $id each,
// identifiers/enums resolved through common.schema.json $defs (single-sourced).
import { ref } from "./common.mjs";
import { LIMITS } from "./limits.mjs";
const DRAFT = "https://json-schema.org/draft/2020-12/schema";
function obj(name, title, props, required, extra) {
  const s = { $schema: DRAFT, $id: ref.schema(name), title, type: "object", properties: props, required, additionalProperties: false };
  if (extra) Object.assign(s, extra);
  return s;
}
const enumRef = (n) => ({ $ref: ref.enum(n) });
const str = (d) => ({ type: "string", description: d });
const arr = (items) => ({ type: "array", items });
const TS = () => ({ $ref: ref.def("isoTimestamp") });
const ID = (d) => ({ $ref: ref.def(d) });
const UNTRUSTED = () => ({ $ref: ref.def("untrustedData") });
const ART = () => ({ $ref: ref.def("artifactRef") });
const VER = () => ({ $ref: ref.def("schemaVersion") });
const DESCR = () => ({ $ref: ref.def("descriptionText") });
export function buildSchemas() {
  const S = {};
  S["mcp-error-envelope"] = obj("mcp-error-envelope", "MCP error envelope", {
    kind: { type: "string", const: "error" }, schema_version: VER(),
    error: { type: "object", properties: { code: str("Stable machine-readable error code"), message: { type: "string", maxLength: LIMITS.descriptionText.max }, client_request_id: ID("clientRequestId"), details: { type: "object", additionalProperties: true } }, required: ["code", "message"], additionalProperties: false },
    retryable: { type: "boolean" }, poll_after_ms: { type: "integer", minimum: 0 }
  }, ["kind", "schema_version", "error"]);
  S["mcp-tool-common-request"] = obj("mcp-tool-common-request", "Shared fields for create-type MCP tool requests", {
    schema_version: VER(), client_request_id: ID("clientRequestId"), workspace_id: ID("workspaceId"), project_subpath: ID("projectSubpath")
  }, ["schema_version", "client_request_id", "workspace_id"]);
  S["mcp-operation"] = obj("mcp-operation", "MCP Operation record (preview/resume/cancel/cleanup)", {
    operation_id: ID("operationId"), tool: str("Tool name that created the operation"), kind: { type: "string", enum: ["run", "preview", "maintenance"] }, status: enumRef("operationStatus"),
    workspace_id: ID("workspaceId"), client_request_id: ID("clientRequestId"), run_id: ID("runId"), result_ref: ART(), created_at: TS(), updated_at: TS(), expires_at: TS()
  }, ["operation_id", "tool", "status", "workspace_id", "created_at", "updated_at"], { additionalProperties: true });
  S["mcp-run-handle"] = obj("mcp-run-handle", "Stable Run handle returned on accepted", {
    run_id: ID("runId"), handle_token: ID("handleToken"), workspace_id: ID("workspaceId"), created_at: TS()
  }, ["run_id", "handle_token", "workspace_id"]);
  S["mcp-status-view"] = obj("mcp-status-view", "Read-only status query result", {
    kind: { type: "string", const: "ok" }, schema_version: VER(), run_id: ID("runId"), phase: enumRef("runPhase"), run_status: enumRef("runStatus"), audit_status: enumRef("auditStatus"), gate: enumRef("gate"),
    progress_pct: { type: "number", minimum: 0, maximum: 100 }, next_action: str("Recommended next action for the agent"), poll_after_ms: { type: "integer", minimum: 0, maximum: LIMITS.pollAfterMsMax.min }, stale: { type: "boolean" }, interrupted: { type: "boolean" }, recent_events: arr({ type: "object", additionalProperties: true })
  }, ["kind", "schema_version", "run_id", "phase", "run_status", "next_action", "poll_after_ms"]);
  S["mcp-result-view"] = obj("mcp-result-view", "Final result after GATED", {
    kind: { type: "string", const: "ok" }, schema_version: VER(), run_id: ID("runId"), phase: { type: "string", const: "GATED" }, gate: enumRef("gate"), audit_status: enumRef("auditStatus"), results_ref: ART(), report_ref: ART(), gate_summary: { type: "object", additionalProperties: true }
  }, ["kind", "schema_version", "run_id", "phase", "gate", "audit_status", "results_ref"]);
  S["profile"] = obj("profile", "AutoPW profile", {
    schema_version: VER(), gate: { type: "object", properties: { strategy: enumRef("gateStrategy"), min_p0_coverage_pct: { type: "integer", minimum: 0, maximum: 100 } }, required: ["strategy"], additionalProperties: false },
    base_tier: enumRef("baseTier"), matrix_budget: { type: "object", properties: { max_execution_instances: { type: "integer", minimum: LIMITS.matrixBudgetMaxExecutionInstances.min } }, additionalProperties: false },
    lifecycle: enumRef("lifecycleMode"), auth_scope_id: str("Approved auth scope id reference"), browsers: arr(str("browser id")), viewports: arr({ type: "object", additionalProperties: true })
  }, ["schema_version", "gate", "base_tier"], { additionalProperties: true });
  S["coverage-policy"] = obj("coverage-policy", "Coverage policy", {
    schema_version: VER(), mandatory_capabilities: arr({ type: "object", properties: { id: str("capability id"), priority: enumRef("priority"), scope_mode: { type: "string", enum: ["always", "when_affected"] }, feature_ids: arr(ID("featureId")), on_missing: { type: "string", enum: ["incomplete", "warn"] } }, required: ["id", "priority", "scope_mode", "feature_ids", "on_missing"], additionalProperties: false })
  }, ["schema_version", "mandatory_capabilities"], { additionalProperties: true });
  S["route-map"] = obj("route-map", "Route map", {
    schema_version: VER(), ignore_globs: arr(str("glob")), mappings: arr({ type: "object", properties: { file_glob: str("glob"), routes: arr(str("route")), features: arr(str("feature id or wildcard")), propagate: { type: "boolean" } }, required: ["file_glob", "routes", "features", "propagate"], additionalProperties: false })
  }, ["schema_version", "mappings"]);
  S["scenario-contract"] = obj("scenario-contract", "Scenario contract", {
    schema_version: VER(), features: { type: "object", additionalProperties: { type: "object", properties: { controls: { type: "array", additionalProperties: true }, input_templates: { type: "object", additionalProperties: true }, validation_texts: { type: "object", additionalProperties: true }, expectations: { type: "array", additionalProperties: true }, mock_endpoints: { type: "array", additionalProperties: true }, reset_strategy: { type: "object", properties: { kind: { type: "string", enum: ["seed_adapter", "api", "none"] }, idempotent: { type: "boolean" } }, required: ["kind", "idempotent"], additionalProperties: false } }, additionalProperties: true } }
  }, ["schema_version", "features"]);
  S["normalized-request"] = obj("normalized-request", "Normalized run request after preflight", {
    schema_version: VER(), profile_digest: str("Content digest of normalized profile"), diff_ref: str("Diff reference"), tier: enumRef("baseTier"), scope_features: arr(ID("featureId")), auth_scope_id: str("Auth scope id"), mode: enumRef("lifecycleMode")
  }, ["schema_version", "tier", "mode"]);
  S["host-context-snapshot"] = obj("host-context-snapshot", "Trusted host context snapshot", {
    workspace_id: ID("workspaceId"), workspace_realpath: str("resolved realpath"), trust_mode: enumRef("trustMode"), auth_scope_id: str("Auth scope id"), caller: str("Caller identity"), policy_version: str("Server policy version"), installation_id: str("Installation id"), max_execution_instances_per_run: { type: "integer", minimum: LIMITS.maxExecutionInstancesPerRun.min }
  }, ["workspace_id", "workspace_realpath", "trust_mode", "caller"], { additionalProperties: true });
  S["input-versions"] = obj("input-versions", "Input version digests", {
    schema_version: VER(), profile_digest: str(""), coverage_policy_digest: str(""), route_map_digest: str(""), scenario_contract_digest: str(""), engine_version: str(""), schema_version_bundle: str("")
  }, ["schema_version", "profile_digest", "engine_version"]);
  S["run-state"] = obj("run-state", "Single Run phase source of truth", {
    run_id: ID("runId"), state_version: { type: "integer", minimum: 1 }, phase: enumRef("runPhase"), run_status: enumRef("runStatus"), audit_status: enumRef("auditStatus"), gate: enumRef("gate"), owner: str("current lease owner"),
    lease: { type: "object", properties: { ttl_ms: { type: "integer", minimum: LIMITS.leaseTtlMs.min }, heartbeat_ms: { type: "integer", minimum: 200, maximum: LIMITS.heartbeatMs.max }, acquired_at: TS() }, required: ["ttl_ms", "heartbeat_ms", "acquired_at"], additionalProperties: false },
    terminalization_reason: enumRef("terminalizationReason"), fatal_class: enumRef("fatalFailureClass")
  }, ["run_id", "state_version", "phase", "run_status"], { additionalProperties: true });
  S["operation-record"] = obj("operation-record", "Persisted operation record", {
    operation_id: ID("operationId"), tool: str("Tool name"), client_request_id: ID("clientRequestId"), workspace_id: ID("workspaceId"), status: enumRef("operationStatus"), kind: { type: "string", enum: ["run", "preview", "maintenance"] }, created_at: TS(), expires_at: TS(), run_id: ID("runId")
  }, ["operation_id", "tool", "client_request_id", "workspace_id", "status", "created_at", "expires_at"]);
  S["retention-policy"] = obj("retention-policy", "Versioned retention policy", {
    schema_version: VER(), operation_ttl_ms: { type: "integer", minimum: LIMITS.retentionTtlMsMin.min }, run_ttl_ms: { type: "integer", minimum: LIMITS.retentionTtlMsMin.min }, evidence_ttl_ms: { type: "integer", minimum: LIMITS.retentionTtlMsMin.min }, cache_ttl_ms: { type: "integer", minimum: LIMITS.retentionTtlMsMin.min }, artifact_ttl_ms: { type: "integer", minimum: LIMITS.retentionTtlMsMin.min }, high_watermark: { type: "integer", minimum: 0 }, low_watermark: { type: "integer", minimum: 0 }, tombstone_queryable: { type: "boolean" }
  }, ["schema_version", "operation_ttl_ms", "run_ttl_ms", "evidence_ttl_ms", "high_watermark"], { additionalProperties: true });
  S["artifact-tombstone"] = obj("artifact-tombstone", "Tombstone written before artifact deletion", { handle: str("artifact handle"), kind: str("artifact kind"), deleted_at: TS(), expires_at: TS() }, ["handle", "kind", "deleted_at", "expires_at"]);
  S["target-result"] = obj("target-result", "TARGET_READY result", { result: { type: "string", enum: ["CONNECTED", "STARTED"] }, health: str("Health evidence"), at: TS() }, ["result", "health", "at"]);
  S["seed-result"] = obj("seed-result", "SEED_RESOLVED result", { result: { type: "string", enum: ["APPLIED", "SKIPPED"] }, reset_capable: { type: "boolean" }, idempotent: { type: "boolean" }, at: TS() }, ["result", "reset_capable", "idempotent", "at"]);
  S["discovery"] = obj("discovery", "Discovery output", {
    schema_version: VER(), observations: arr({ type: "object", additionalProperties: true }), candidates: arr({ type: "object", additionalProperties: true }),
    scenario_observations: arr({ type: "object", properties: { feature_id: ID("featureId"), scenario: enumRef("scenario"), observed: { type: "boolean" }, blocker: { type: "boolean" } }, required: ["feature_id", "scenario", "observed"], additionalProperties: false })
  }, ["schema_version", "observations", "candidates", "scenario_observations"]);
  S["derivation"] = obj("derivation", "Coverage derivation", {
    schema_version: VER(), skeleton: arr({ type: "object", properties: { case_id: ID("caseId"), feature_id: ID("featureId"), scenario: enumRef("scenario"), effective_tier: enumRef("baseTier"), matrix_cell: str(""), blocked: { type: "boolean" } }, required: ["case_id", "feature_id", "scenario", "effective_tier"], additionalProperties: false }),
    matrix: arr({ type: "object", additionalProperties: true }), p0_required_total: { type: "integer", minimum: 0 }, p0_coverage_pct: { type: ["number", "null"], minimum: 0, maximum: 100 }
  }, ["schema_version", "skeleton"]);
  S["planner-input"] = obj("planner-input", "Planner input", {
    schemaVersion: VER(), skeletons: arr({ type: "object", additionalProperties: true }), candidates: { type: "object", additionalProperties: true },
    contractRefs: arr({ type: "object", properties: { contractId: str(""), version: str(""), ref: str("") }, required: ["contractId", "ref"], additionalProperties: false }),
    untrustedObservations: arr({ type: "object", properties: { observationId: str(""), untrusted: { type: "boolean", const: true }, kind: str(""), value: str("") }, required: ["observationId", "untrusted", "kind", "value"], additionalProperties: false })
  }, ["schemaVersion", "skeletons", "candidates"]);
  S["planner-output"] = obj("planner-output", "Planner candidate selection output", {
    caseSelections: arr({ type: "object", properties: { caseId: ID("caseId"), actionSelections: arr({ type: "object", properties: { actionTemplateId: str(""), routeId: str(""), locatorId: str(""), inputId: str(""), endpointId: str("") }, required: ["actionTemplateId"], additionalProperties: false }), expectationIds: arr(str("")), description: DESCR() }, required: ["caseId", "actionSelections", "expectationIds"], additionalProperties: false })
  }, ["caseSelections"]);
  S["plan-template"] = obj("plan-template", "Cached plan template (candidate selections)", { cache_key: str(""), selections_digest: str(""), planner_provider_id: str(""), model_id: str("") }, ["cache_key", "selections_digest"]);
  S["plan"] = obj("plan", "Frozen logical case plan", {
    schema_version: VER(), cases: arr({ type: "object", properties: { case_id: ID("caseId"), feature_id: ID("featureId"), scenario: enumRef("scenario"), effective_tier: enumRef("baseTier"), steps: arr({ type: "object", additionalProperties: true }) }, required: ["case_id", "feature_id", "scenario", "effective_tier"], additionalProperties: false }), frozen_at: TS()
  }, ["schema_version", "cases", "frozen_at"]);
  S["mapping-audit"] = obj("mapping-audit", "Planned vs generated logical case mapping", { planned_case_ids: arr(ID("caseId")), generated_case_ids: arr(ID("caseId")), match: { type: "string", enum: ["COMPLETE", "MISMATCH"] } }, ["planned_case_ids", "generated_case_ids", "match"]);
  S["execution-manifest"] = obj("execution-manifest", "Batches and execution instances", {
    batches: arr({ type: "object", properties: { batch_id: ID("batchId"), tier: enumRef("baseTier"), browser: str(""), viewport: { type: "object", additionalProperties: true }, locale: str(""), auth_scope_id: str("") }, required: ["batch_id", "tier"], additionalProperties: false }),
    instances: arr({ type: "object", properties: { execution_id: ID("executionId"), case_id: ID("caseId"), batch_id: ID("batchId"), status: enumRef("executionStatus") }, required: ["execution_id", "case_id", "batch_id", "status"], additionalProperties: false })
  }, ["batches", "instances"]);
  S["execution-result"] = obj("execution-result", "Per-instance execution result", { execution_id: ID("executionId"), case_id: ID("caseId"), status: enumRef("executionStatus"), attempts: arr({ type: "object", additionalProperties: true }), evidence_refs: arr(str("")), at: TS() }, ["execution_id", "case_id", "status"]);
  S["event"] = obj("event", "Append-only event log entry", { seq: { type: "integer", minimum: 1 }, kind: str("event kind"), phase: enumRef("runPhase"), at: TS(), detail: { type: "object", additionalProperties: true } }, ["seq", "kind", "at"]);
  S["checkpoint"] = obj("checkpoint", "Execution instance atomic checkpoint", { execution_id: ID("executionId"), case_id: ID("caseId"), status: enumRef("executionStatus"), attempt: { type: "integer", minimum: 0 }, at: TS() }, ["execution_id", "case_id", "status", "at"]);
  S["evidence-manifest"] = obj("evidence-manifest", "Evidence index + redaction state", { execution_id: ID("executionId"), items: arr({ type: "object", additionalProperties: true }), redacted: { type: "boolean" } }, ["execution_id", "items", "redacted"]);
  S["issues"] = obj("issues", "Classified issues", { schema_version: VER(), issues: arr({ type: "object", properties: { id: str("issue id"), classification: enumRef("issueClassification"), confidence: enumRef("classificationConfidence"), execution_id: ID("executionId"), evidence_refs: arr(str("")), untrusted_summary: UNTRUSTED() }, required: ["id", "classification", "confidence"], additionalProperties: false }) }, ["schema_version", "issues"]);
  S["terminalization"] = obj("terminalization", "Controlled early-stop reason", { reason: enumRef("terminalizationReason"), trigger_phase: enumRef("runPhase"), error: { type: "object", additionalProperties: true }, existing_artifacts: arr(str("")), outstanding_scope: arr(ID("caseId")), expected_gate: enumRef("gate") }, ["reason", "trigger_phase", "expected_gate"]);
  S["finalization-result"] = obj("finalization-result", "Runtime finalization result", { browsers_closed: { type: "boolean" }, agents_released: { type: "boolean" }, manage_target_closed: { type: "boolean" }, temp_secrets_cleared: { type: "boolean" }, gate_critical_ok: { type: "boolean" } }, ["browsers_closed", "agents_released", "temp_secrets_cleared", "gate_critical_ok"]);
  S["completion-audit"] = obj("completion-audit", "Structural audit reconciliation", { audit_status: enumRef("auditStatus"), case_reconciliation: { type: "string", enum: ["COMPLETE", "MISMATCH"] }, instance_reconciliation: { type: "string", enum: ["COMPLETE", "MISMATCH"] }, evidence_complete: { type: "boolean" } }, ["audit_status", "case_reconciliation", "instance_reconciliation", "evidence_complete"]);
  S["gate-draft"] = obj("gate-draft", "Write-once gate draft", { gate: enumRef("gate"), audit_status: enumRef("auditStatus"), p0_coverage_pct: { type: ["number", "null"], minimum: 0, maximum: 100 }, summary: { type: "object", additionalProperties: true } }, ["gate", "audit_status"]);
  S["results"] = obj("results", "Machine gate source of truth", { schema_version: VER(), run_id: ID("runId"), gate: enumRef("gate"), audit_status: enumRef("auditStatus"), exit_code: { type: "integer" }, results_ref: ART() }, ["schema_version", "run_id", "gate", "audit_status", "exit_code", "results_ref"]);
  S["failure"] = obj("failure", "Fatal failure record", { schema_version: VER(), run_id: ID("runId"), fatal_class: enumRef("fatalFailureClass"), error: { type: "object", additionalProperties: true }, at: TS() }, ["schema_version", "run_id", "fatal_class", "error", "at"]);
  S["cleanup-result"] = obj("cleanup-result", "Idempotent seed cleanup result", { kind: { type: "string", const: "ok" }, run_id: ID("runId"), cleaned: arr(str("")), idempotent: { type: "boolean" }, at: TS() }, ["kind", "run_id", "cleaned", "idempotent", "at"]);
  return S;
}
export const SCHEMA_NAMES = Object.freeze([
  "mcp-error-envelope","mcp-tool-common-request","mcp-operation","mcp-run-handle","mcp-status-view","mcp-result-view",
  "profile","coverage-policy","route-map","scenario-contract","normalized-request","host-context-snapshot","input-versions",
  "run-state","operation-record","retention-policy","artifact-tombstone","target-result","seed-result","discovery","derivation",
  "planner-input","planner-output","plan-template","plan","mapping-audit","execution-manifest","execution-result","event","checkpoint",
  "evidence-manifest","issues","terminalization","finalization-result","completion-audit","gate-draft","results","failure",
  "cleanup-result","common"
]);
