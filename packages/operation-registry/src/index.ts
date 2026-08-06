// AutoPW Operation Registry — durable, idempotent, TTL and tombstone support.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type OperationStatus = "ACCEPTED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: unknown): void;
}

export interface ArtifactSnapshot { handle: string; kind: string; size_bytes?: number; }

export interface RetentionPolicy {
  operation_ttl_ms: number;
  run_ttl_ms: number;
  evidence_ttl_ms: number;
  cache_ttl_ms: number;
  artifact_ttl_ms: number;
  high_watermark: number;
  low_watermark: number;
  tombstone_queryable?: boolean;
}

export interface OperationRecord {
  operation_id: string;
  tool: string;
  client_request_id: string;
  workspace_id: string;
  kind: "run" | "preview" | "maintenance";
  params: Record<string, unknown>;
  status: OperationStatus;
  run_id: string | null;
  result_ref: Record<string, unknown> | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  tombstoned: boolean;
  state_version?: number;
  phase?: string;
  run_status?: string;
  audit_status?: string | null;
  gate?: string | null;
  fatal_class?: string | null;
  progress_pct?: number;
  next_action?: string;
  cancel_requested?: boolean;
  result_summary?: Record<string, unknown>;
  results_ref?: ArtifactSnapshot;
  report_ref?: ArtifactSnapshot;
  gate_summary?: Record<string, unknown>;
  evidence_refs?: ArtifactSnapshot[];
  cases?: Record<string, unknown>[];
  audit_summary?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RunSnapshot {
  run_id: string;
  operation_id: string;
  workspace_id: string;
  phase: string;
  run_status: string;
  audit_status: string | null;
  gate: string | null;
  fatal_class: string | null;
  progress_pct: number;
  next_action: string;
  cancel_requested?: boolean;
  results_ref?: ArtifactSnapshot;
  report_ref?: ArtifactSnapshot;
  gate_summary?: Record<string, unknown>;
  evidence_refs?: ArtifactSnapshot[];
  cases?: Record<string, unknown>[];
  audit_summary?: Record<string, unknown>;
}

interface CreateInput {
  tool: string;
  client_request_id: string;
  workspace_id: string;
  kind: OperationRecord["kind"];
  params: Record<string, unknown>;
}

const OP_PREFIX = "op_";
function genId(): string { return OP_PREFIX + crypto.randomBytes(10).toString("hex"); }
function now(): number { return Date.now(); }
function iso(ms: number): string { return new Date(ms).toISOString(); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value as Record<string, unknown>).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson((value as Record<string, unknown>)[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

const DEFAULT_RETENTION: RetentionPolicy = {
  operation_ttl_ms: 604800000, run_ttl_ms: 2592000000, evidence_ttl_ms: 0,
  cache_ttl_ms: 0, artifact_ttl_ms: 0, high_watermark: 1000, low_watermark: 100
};

export class OperationRegistry {
  readonly dataRoot: string;
  readonly opsDir: string;
  readonly runsDir: string;
  readonly indexFile: string;
  readonly retention: RetentionPolicy;
  readonly log: Logger;
  readonly index = new Map<string, string>();
  readonly byId = new Map<string, OperationRecord>();

  constructor({ dataRoot, retention, logger }: { dataRoot: string; retention?: Partial<RetentionPolicy>; logger?: Logger }) {
    this.dataRoot = path.resolve(dataRoot);
    this.opsDir = path.join(this.dataRoot, "operations");
    this.runsDir = path.join(this.dataRoot, "runs");
    this.indexFile = path.join(this.dataRoot, "index.json");
    this.retention = Object.assign({}, DEFAULT_RETENTION, retention || {});
    this.log = logger || { info: () => {}, warn: () => {}, error: () => {} };
    fs.mkdirSync(this.opsDir, { recursive: true });
    fs.mkdirSync(this.runsDir, { recursive: true });
    this._reindex();
  }

  private _key(workspace_id: string, tool: string, client_request_id: string): string {
    return workspace_id + "|" + tool + "|" + client_request_id;
  }

  private _reindex(): void {
    this.index.clear();
    this.byId.clear();
    if (!fs.existsSync(this.opsDir)) return;
    let count = 0;
    for (const file of fs.readdirSync(this.opsDir)) {
      if (!file.endsWith(".json") || file.endsWith(".tombstone.json")) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.opsDir, file), "utf8")) as OperationRecord;
        if (!record.operation_id) continue;
        this.byId.set(record.operation_id, record);
        if (record.client_request_id) this.index.set(this._key(record.workspace_id, record.tool, record.client_request_id), record.operation_id);
        count += 1;
      } catch (error) {
        this.log.warn("reindex skip " + file + ": " + (error instanceof Error ? error.message : String(error)));
      }
    }
    this.log.info("registry reindexed " + count + " operations");
  }

  private _writeAtomic(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + ".tmp." + process.pid + "." + crypto.randomBytes(4).toString("hex");
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(temporary, file);
  }

  create(input: CreateInput): { operation_id: string; operation: OperationRecord; created: boolean } {
    const { tool, client_request_id, workspace_id, kind, params } = input;
    if (!client_request_id) throw Object.assign(new Error("client_request_id required"), { code: "MISSING_CLIENT_REQUEST_ID" });
    const key = this._key(workspace_id, tool, client_request_id);
    const existingId = this.index.get(key);
    if (existingId) {
      const existing = this.byId.get(existingId);
      if (!existing) throw Object.assign(new Error("index drift"), { code: "INDEX_DRIFT" });
      if (canonicalJson(existing.params) !== canonicalJson(params || {})) {
        const error = Object.assign(new Error("IDEMPOTENCY_CONFLICT: same client_request_id with different params"), { code: "IDEMPOTENCY_CONFLICT", existing_operation_id: existingId });
        throw error;
      }
      this.log.info("idempotent return " + existingId + " for " + tool);
      return { operation_id: existingId, operation: existing, created: false };
    }
    if (this._atHighWatermark() && this._reclaimableCount() === 0) {
      throw Object.assign(new Error("BACKPRESSURE: high watermark reached, no expired records to reclaim"), { code: "BACKPRESSURE_REFUSED", high_watermark: this.retention.high_watermark });
    }
    const operation_id = genId();
    const timestamp = now();
    const ttlMs = kind === "run" ? this.retention.run_ttl_ms : this.retention.operation_ttl_ms;
    const record: OperationRecord = {
      operation_id, tool, client_request_id, workspace_id, kind, params: params || {},
      status: "ACCEPTED", run_id: null, result_ref: null, created_at: timestamp,
      updated_at: timestamp, expires_at: timestamp + ttlMs, tombstoned: false
    };
    this._writeAtomic(path.join(this.opsDir, operation_id + ".json"), record);
    this.byId.set(operation_id, record);
    this.index.set(key, operation_id);
    this._writeIndex();
    this.log.info("created " + operation_id + " for " + tool + " (kind=" + kind + ")");
    return { operation_id, operation: record, created: true };
  }

  private _writeIndex(): void {
    const index: Record<string, string> = {};
    for (const [key, value] of this.index) index[key] = value;
    this._writeAtomic(this.indexFile, index);
  }

  update(operation_id: string, mutator: (record: OperationRecord) => OperationRecord | undefined): OperationRecord {
    const file = path.join(this.opsDir, operation_id + ".json");
    const current = this.byId.get(operation_id) || JSON.parse(fs.readFileSync(file, "utf8")) as OperationRecord;
    const next = mutator(JSON.parse(JSON.stringify(current)) as OperationRecord);
    if (!next) return current;
    next.updated_at = now();
    if (next.state_version === undefined || next.state_version === current.state_version) next.state_version = (current.state_version || 0) + 1;
    else if (next.state_version !== (current.state_version || 0) + 1) throw Object.assign(new Error("STATE_VERSION_CONFLICT"), { code: "STATE_VERSION_CONFLICT" });
    this._writeAtomic(file, next);
    this.byId.set(operation_id, next);
    return next;
  }

  updateRun(run: RunSnapshot, { operationStatus }: { operationStatus?: OperationStatus } = {}): OperationRecord {
    return this.update(run.operation_id, (record) => {
      record.run_id = run.run_id; record.phase = run.phase; record.run_status = run.run_status;
      record.audit_status = run.audit_status; record.gate = run.gate; record.fatal_class = run.fatal_class;
      record.progress_pct = run.progress_pct; record.next_action = run.next_action;
      record.cancel_requested = Boolean(run.cancel_requested);
      record.results_ref = run.results_ref;
      record.report_ref = run.report_ref;
      record.gate_summary = run.gate_summary;
      record.evidence_refs = run.evidence_refs;
      record.cases = run.cases;
      record.audit_summary = run.audit_summary;
      if (operationStatus) record.status = operationStatus;
      return record;
    });
  }

  get(operation_id: string): OperationRecord | undefined {
    const record = this.byId.get(operation_id);
    return record && !record.tombstoned ? record : undefined;
  }

  listByWorkspace(workspace_id: string): OperationRecord[] {
    return [...this.byId.values()].filter((record) => record.workspace_id === workspace_id && !record.tombstoned);
  }

  private _reclaimableCount(): number {
    const timestamp = now();
    return [...this.byId.values()].filter((record) => !record.tombstoned && record.expires_at <= timestamp).length;
  }

  private _atHighWatermark(): boolean { return this.byId.size >= this.retention.high_watermark; }
  private _atLowWatermark(): boolean { return this.byId.size <= this.retention.low_watermark; }

  sweep({ forceTombstone = true }: { forceTombstone?: boolean } = {}): { reclaimed: number; tombstoned: number } {
    let reclaimed = 0;
    let tombstoned = 0;
    const timestamp = now();
    for (const record of [...this.byId.values()]) {
      if (record.tombstoned || record.expires_at > timestamp) continue;
      const file = path.join(this.opsDir, record.operation_id + ".json");
      if (forceTombstone) this._writeTombstone(record);
      try { fs.rmSync(file); }
      catch (error) { this.log.warn("sweep could not delete " + file + ": " + (error instanceof Error ? error.message : String(error))); }
      record.tombstoned = true;
      this.byId.delete(record.operation_id);
      for (const [key, operationId] of this.index) if (operationId === record.operation_id) this.index.delete(key);
      tombstoned += 1;
      reclaimed += 1;
      if (this._atLowWatermark()) break;
    }
    this._writeIndex();
    if (reclaimed > 0) this.log.info("sweeper reclaimed " + reclaimed);
    return { reclaimed, tombstoned };
  }

  private _writeTombstone(record: OperationRecord): void {
    this._writeAtomic(path.join(this.opsDir, record.operation_id + ".tombstone.json"), {
      handle: record.operation_id, kind: record.kind, deleted_at: iso(now()), expires_at: iso(record.expires_at)
    });
  }

  queryAfterTombstone(operation_id: string): OperationRecord | undefined {
    if (fs.existsSync(path.join(this.opsDir, operation_id + ".tombstone.json"))) throw Object.assign(new Error("RESULT_EXPIRED"), { code: "RESULT_EXPIRED" });
    return this.get(operation_id);
  }

  reload(): void { this._reindex(); }
}
