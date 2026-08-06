// MCP tool contracts (Draft 2020-12) for the 10 public AutoPW tools. Enums/ids
// resolve through common schema defs. Each contract carries request instances
// and ok/error response instances so verify:m0 can validate every tool example
// against its input schema and result union (incl. each tool's error path).
import { ref } from "../../schemas/src/common.mjs";
import { LIMITS } from "../../schemas/src/limits.mjs";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const VER = () => ({ $ref: ref.def("schemaVersion") });
const WID = () => ({ $ref: ref.def("workspaceId") });
const OID = () => ({ $ref: ref.def("operationId") });
const RID = () => ({ $ref: ref.def("runId") });
const CID = () => ({ $ref: ref.def("clientRequestId") });
const enumRef = (n) => ({ $ref: ref.enum(n) });
const ART = () => ({ $ref: ref.def("artifactRef") });
const str = (d) => ({ type: "string", description: d });
const ERROR = () => ({ $ref: ref.schema("mcp-error-envelope") });

function inputSchema(name, desc, props, required) {
  return {
    $schema: DRAFT, $id: ref.tool(name) + "#/input", title: name + " input",
    description: desc, type: "object", properties: props, required, additionalProperties: false
  };
}
function rv(kindConst, payload, requiredExtra) {
  return { type: "object", properties: { kind: { type: "string", const: kindConst }, schema_version: VER(), ...payload },
    required: ["kind", "schema_version", ...requiredExtra], additionalProperties: false };
}
function acceptedResult(payload) {
  return rv("accepted", { operation_id: OID(), poll_after_ms: { type: "integer", minimum: 0, maximum: LIMITS.pollAfterMsMax.min }, ...payload },
    ["operation_id", "poll_after_ms"].concat(Object.keys(payload)));
}
function ERR(code, message, retryable, poll) {
  const e = { kind: "error", schema_version: "2.1", error: { code, message } };
  if (retryable !== undefined) e.retryable = retryable;
  if (poll !== undefined) e.poll_after_ms = poll;
  return e;
}
function tool(name, desc, input, results, meta, ex) {
  return { name, description: desc, input_schema: input, result_union: results, ...meta, examples: ex };
}

const CREQ = ["schema_version", "client_request_id", "workspace_id"];
const QREQ = ["schema_version", "workspace_id"];

export function buildToolContracts() {
  const T = {};

  T.derive_coverage = tool("derive_coverage",
    "Preview coverage scope, skeleton, blockers, candidate summary and CDD Draft. Returns an accepted Operation; poll get_operation_status, then read get_operation_result.",
    inputSchema("derive_coverage", "Coverage preview request", {
      schema_version: VER(), client_request_id: CID(), workspace_id: WID(),
      project_subpath: { $ref: ref.def("projectSubpath") },
      profile_path: str("relative profile path"), tier: enumRef("baseTier"),
      diff_ref: str("git diff ref"), auth_scope_id: str("approved auth scope id reference")
    }, CREQ),
    [acceptedResult({}), ERROR()],
    { creates_operation: true, requires_client_request_id: true, async_default: true, retryable: true,
      authorization_scope: ["workspace", "auth"], returns_max_bytes: LIMITS.payloadBytesSoft.max },
    {
      request: [{ schema_version: "2.1", client_request_id: "cr_abc123", workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", tier: "fast", diff_ref: "origin/main...HEAD" }],
      ok: [{ kind: "accepted", schema_version: "2.1", operation_id: "op_0123456789abcdefghij", poll_after_ms: 2000 }],
      error: [ERR("UNAUTHORIZED_WORKSPACE", "workspace not in host allowlist", false)]
    });

  T.run_audit = tool("run_audit",
    "Create and start a managed audit Run. Returns accepted with a persistent run_handle that survives MCP session, transport and Codex process disconnects. Cancel only via cancel_run or host close policy. Returns MATRIX_BUDGET_EXCEEDED instead of silently trimming a full matrix.",
    inputSchema("run_audit", "Audit run request", {
      schema_version: VER(), client_request_id: CID(), workspace_id: WID(),
      project_subpath: { $ref: ref.def("projectSubpath") },
      profile_path: str("relative profile path"), base_tier: enumRef("baseTier"),
      fixture_variant: { type: "string", enum: ["pass", "fail", "incomplete"] },
      matrix_budget: { type: "object", properties: { max_execution_instances: { type: "integer", minimum: LIMITS.matrixBudgetMaxExecutionInstances.min } }, additionalProperties: false },
      auth_scope_id: str("approved auth scope id reference"), lifecycle: enumRef("lifecycleMode")
    }, ["schema_version", "client_request_id", "workspace_id", "profile_path", "base_tier"]),
    [acceptedResult({ run_handle: RID() }), ERROR()],
    { creates_operation: true, requires_client_request_id: true, async_default: true, retryable: true,
      authorization_scope: ["workspace", "auth", "network"], returns_max_bytes: LIMITS.payloadBytesSoft.max },
    {
      request: [{ schema_version: "2.1", client_request_id: "cr_run1", workspace_id: "ws_demo", project_subpath: ".", profile_path: ".autopw/profile.yaml", base_tier: "fast" }],
      ok: [{ kind: "accepted", schema_version: "2.1", operation_id: "op_0123456789abcdefghij", run_handle: "run_0123456789abcdefghij", poll_after_ms: 5000 }],
      error: [ERR("MATRIX_BUDGET_EXCEEDED", "projected execution instances exceed effective matrix budget", false),
              ERR("UNAUTHORIZED_WORKSPACE", "workspace not authorized", false)]
    });

  T.get_operation_status = tool("get_operation_status",
    "Query status of a preview/resume/cancel/cleanup Operation. Read-only: does not lease, advance phase or resume.",
    inputSchema("get_operation_status", "Operation status query", {
      schema_version: VER(), workspace_id: WID(), operation_id: OID()
    }, QREQ.concat(["operation_id"])),
    [rv("ok", { operation_id: OID(), status: enumRef("operationStatus"), label: str("human-readable"), poll_after_ms: { type: "integer", minimum: 0 } }, ["operation_id", "status"]), ERROR()],
    { creates_operation: false, requires_client_request_id: false, async_default: false, retryable: true,
      authorization_scope: ["workspace"], returns_max_bytes: LIMITS.payloadBytesSoft.max },
    {
      request: [{ schema_version: "2.1", workspace_id: "ws_demo", operation_id: "op_0123456789abcdefghij" }],
      ok: [{ kind: "ok", schema_version: "2.1", operation_id: "op_0123456789abcdefghij", status: "RUNNING", label: "discovering", poll_after_ms: 2000 }],
      error: [ERR("OPERATION_NOT_FOUND", "operation id unknown or expired", false)]
    });

  T.get_operation_result = tool("get_operation_result",
    "Read the result of a completed non-Run Operation (e.g. coverage preview). Returns not_ready if the Operation has not completed.",
    inputSchema("get_operation_result", "Operation result query", {
      schema_version: VER(), workspace_id: WID(), operation_id: OID(), page: { type: "integer", minimum: 1 }
    }, QREQ.concat(["operation_id"])),
    [rv("ok", { operation_id: OID(), result_ref: ART(), summary: { type: "object", additionalProperties: true } }, ["operation_id"]),
     rv("not_ready", { operation_id: OID(), poll_after_ms: { type: "integer", minimum: 0 } }, ["operation_id", "poll_after_ms"]),
     ERROR()],
    { creates_operation: false, requires_client_request_id: false, async_default: false, retryable: true,
      authorization_scope: ["workspace"], returns_max_bytes: LIMITS.payloadBytesSoft.max },
    {
      request: [{ schema_version: "2.1", workspace_id: "ws_demo", operation_id: "op_0123456789abcdefghij" }],
      ok: [{ kind: "ok", schema_version: "2.1", operation_id: "op_0123456789abcdefghij", summary: { skeleton_count: 12 } }],
      error: [ERR("OPERATION_NOT_FOUND", "operation id unknown or expired", false)]
    });

  T.get_run_status = tool("get_run_status",
    "Query Run phase, run status, progress, recent events and recommended next action. Read-only; does not advance phase or resume.",
    inputSchema("get_run_status", "Run status query", {
      schema_version: VER(), workspace_id: WID(), run_id: RID()
    }, QREQ.concat(["run_id"])),
    [rv("ok", {
      run_id: RID(), phase: enumRef("runPhase"), run_status: enumRef("runStatus"),
      audit_status: enumRef("auditStatus"), gate: enumRef("gate"),
      progress_pct: { type: "number", minimum: 0, maximum: 100 },
      next_action: str("recommended next action"),
      poll_after_ms: { type: "integer", minimum: 0, maximum: LIMITS.pollAfterMsMax.min },
      stale: { type: "boolean" }, interrupted: { type: "boolean" }
    }, ["run_id", "phase", "run_status", "next_action", "poll_after_ms"]), ERROR()],
    { creates_operation: false, requires_client_request_id: false, async_default: false, retryable: true,
      authorization_scope: ["workspace"], returns_max_bytes: LIMITS.payloadBytesSoft.max },
    {
      request: [{ schema_version: "2.1", workspace_id: "ws_demo", run_id: "run_0123456789abcdefghij" }],
      ok: [{ kind: "ok", schema_version: "2.1", run_id: "run_0123456789abcdefghij", phase: "RUNNING", run_status: "ACTIVE", progress_pct: 40, next_action: "poll get_run_status", poll_after_ms: 5000, stale: false, interrupted: false }],
      error: [ERR("RUN_FORBIDDEN", "handle not bound to this workspace", false)]
    });

  T.get_run_result = tool("get_run_result",
    "Read the final machine gate and report reference after GATED. Returns not_ready before GATED and a failure summary on Fatal Failure (never a fabricated gate).",
    inputSchema("get_run_result", "Run result query", {
      schema_version: VER(), workspace_id: WID(), run_id: RID(), page: { type: "integer", minimum: 1 }
    }, QREQ.concat(["run_id"])),
    [rv("ok", { run_id: RID(), gate: enumRef("gate"), audit_status: enumRef("auditStatus"),
      results_ref: ART(), report_ref: ART(), gate_summary: { type: "object", additionalProperties: true } }, ["run_id", "gate", "audit_status", "results_ref"]),
     rv("not_ready", { run_id: RID(), poll_after_ms: { type: "integer", minimum: 0 } }, ["run_id", "poll_after_ms"]),
     rv("failed", { run_id: RID(), fatal_class: enumRef("fatalFailureClass"), failure_ref: ART() }, ["run_id", "fatal_class"]),
     ERROR()],
    { creates_operation: false, requires_client_request_id: false, async_default: false, retryable: true,
      authorization_scope: ["workspace"], returns_max_bytes: LIMITS.payloadBytesSoft.max },
    {
      request: [{ schema_version: "2.1", workspace_id: "ws_demo", run_id: "run_0123456789abcdefghij" }],
      ok: [{ kind: "ok", schema_version: "2.1", run_id: "run_0123456789abcdefghij", gate: "fail", audit_status: "COMPLETE", results_ref: { handle: "art_results_1", kind: "results.json" }, report_ref: { handle: "art_report_1", kind: "report.md" }, gate_summary: { product_defects: 2 } }],
      error: [ERR("RUN_FORBIDDEN", "handle not bound to this workspace", false)]
    });

  T.resume_run = tool("resume_run",
    "Take over a stale/interrupted Run and continue outstanding execution instances. Idempotent by client_request_id; at-least-once semantics; non-resumable instances block resume.",
    inputSchema("resume_run", "Resume request", {
      schema_version: VER(), client_request_id: CID(), workspace_id: WID(), run_id: RID()
    }, CREQ.concat(["run_id"])),
    [acceptedResult({ run_id: RID() }), ERROR()],
    { creates_operation: true, requires_client_request_id: true, async_default: true, retryable: true,
      authorization_scope: ["workspace"], returns_max_bytes: LIMITS.payloadBytesSoft.max },
    {
      request: [{ schema_version: "2.1", client_request_id: "cr_res1", workspace_id: "ws_demo", run_id: "run_0123456789abcdefghij" }],
      ok: [{ kind: "accepted", schema_version: "2.1", operation_id: "op_0123456789abcdefghij", run_id: "run_0123456789abcdefghij", poll_after_ms: 5000 }],
      error: [ERR("BLOCKED_RESUME", "non-resumable instance cannot be safely rerun", false)]
    });

  T.cancel_run = tool("cancel_run",
    "Request controlled cancellation. The Run enters TERMINALIZING and still produces a real incomplete/infra gate; it is never killed with a fabricated pass.",
    inputSchema("cancel_run", "Cancel request", {
      schema_version: VER(), client_request_id: CID(), workspace_id: WID(), run_id: RID()
    }, CREQ.concat(["run_id"])),
    [acceptedResult({ run_id: RID() }), ERROR()],
    { creates_operation: true, requires_client_request_id: true, async_default: true, retryable: true,
      authorization_scope: ["workspace"], returns_max_bytes: LIMITS.payloadBytesSoft.max },
    {
      request: [{ schema_version: "2.1", client_request_id: "cr_can1", workspace_id: "ws_demo", run_id: "run_0123456789abcdefghij" }],
      ok: [{ kind: "accepted", schema_version: "2.1", operation_id: "op_0123456789abcdefghij", run_id: "run_0123456789abcdefghij", poll_after_ms: 3000 }],
      error: [ERR("RUN_NOT_ACTIVE", "run already terminal", false)]
    });

  T.cleanup_run = tool("cleanup_run",
    "Idempotently clean up Seed data, temporary browser data and artifacts that satisfy the retention policy. Does not modify a frozen gate.",
    inputSchema("cleanup_run", "Cleanup request", {
      schema_version: VER(), client_request_id: CID(), workspace_id: WID(), run_id: RID()
    }, CREQ.concat(["run_id"])),
    [acceptedResult({ run_id: RID() }), ERROR()],
    { creates_operation: true, requires_client_request_id: true, async_default: true, retryable: true,
      authorization_scope: ["workspace"], returns_max_bytes: LIMITS.payloadBytesSoft.max },
    {
      request: [{ schema_version: "2.1", client_request_id: "cr_cln1", workspace_id: "ws_demo", run_id: "run_0123456789abcdefghij" }],
      ok: [{ kind: "accepted", schema_version: "2.1", operation_id: "op_0123456789abcdefghij", run_id: "run_0123456789abcdefghij", poll_after_ms: 1000 }],
      error: [ERR("RUN_FORBIDDEN", "handle not bound to this workspace", false)]
    });

  T.explain_run = tool("explain_run",
    "Return a bounded explain view: CDD, case birth certificate, issue evidence and gate reason. Page content and descriptions are escaped; no host absolute paths are returned.",
    inputSchema("explain_run", "Explain query", {
      schema_version: VER(), workspace_id: WID(), run_id: RID(),
      focus_case_id: { $ref: ref.def("caseId") }, page: { type: "integer", minimum: 1 }
    }, QREQ.concat(["run_id"])),
    [rv("ok", { run_id: RID(), gate: enumRef("gate"), audit_status: enumRef("auditStatus"),
      cases: { type: "array", items: { type: "object", additionalProperties: true } },
      evidence_refs: { type: "array", items: ART() } }, ["run_id"]), ERROR()],
    { creates_operation: false, requires_client_request_id: false, async_default: false, retryable: true,
      authorization_scope: ["workspace"], returns_max_bytes: LIMITS.payloadBytesSoft.max },
    {
      request: [{ schema_version: "2.1", workspace_id: "ws_demo", run_id: "run_0123456789abcdefghij" }],
      ok: [{ kind: "ok", schema_version: "2.1", run_id: "run_0123456789abcdefghij", gate: "incomplete", audit_status: "INCOMPLETE", cases: [{ case_id: "case_search_normal", reason: "test_defect" }], evidence_refs: [] }],
      error: [ERR("RUN_FORBIDDEN", "handle not bound to this workspace", false)]
    });

  return T;
}

export const TOOL_NAMES = Object.freeze([
  "derive_coverage","run_audit","get_operation_status","get_operation_result",
  "get_run_status","get_run_result","resume_run","cancel_run","cleanup_run","explain_run"
]);
