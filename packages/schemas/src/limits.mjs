// Hard-coded format, length and budget limits for IDs, paths and fields.
// verify:m0 check #7 asserts every limit has a positive, finite value so that
// workspace/path/ID length and format constraints are "fixed" rather than open.

export const LIMITS = Object.freeze({
  workspaceId: { max: 128, pattern: "^[A-Za-z0-9_.:-]+$" },
  projectSubpath: { max: 320, pattern: "^[A-Za-z0-9_./@\\-]+$" },
  clientRequestId: { max: 160, pattern: "^[A-Za-z0-9_.:-]+$" },
  operationId: { max: 64, pattern: "^op_[A-Za-z0-9]{20}$" },
  runId: { max: 64, pattern: "^run_[A-Za-z0-9]{20}$" },
  handleToken: { max: 96, pattern: "^[A-Za-z0-9_-]{32,}$" },
  caseId: { max: 96, pattern: "^[A-Za-z0-9_.:-]+$" },
  executionId: { max: 96, pattern: "^EXE-[A-Za-z0-9]{16}$" },
  batchId: { max: 96, pattern: "^BAT-[A-Za-z0-9]{16}$" },
  featureId: { max: 96, pattern: "^[A-Za-z0-9_.:-]+$" },
  schemaVersionPattern: "^2\\.(1)(\\.[0-9]+)?(-rc[0-9]+)?(-mcp-first)?$",
  untrustedText: { max: 5000 },
  descriptionText: { max: 1000 },
  payloadBytesSoft: { max: 524288 },
  payloadBytesHard: { max: 16777216 },
  pollAfterMsMin: { min: 0 },
  pollAfterMsMax: { min: 600000 },
  leaseTtlMs: { min: 30000 },
  heartbeatMs: { max: 10000 },
  clockSkewMs: { max: 5000 },
  takeoverConfirmMs: { min: 30000 },
  maxExecutionInstancesPerRun: { min: 1 },
  matrixBudgetMaxExecutionInstances: { min: 1 },
  retentionTtlMsMin: { min: 1000 }
});

// helper: enum reference list in $defs form
export function enumRef(name) {
  return { $ref: "#/$defs/" + name };
}
