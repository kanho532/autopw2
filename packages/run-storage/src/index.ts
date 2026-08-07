import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { threadId } from "node:worker_threads";

export interface ArtifactRef { handle: string; kind: string; size_bytes?: number; }
export interface ArtifactIndexEntry { relative_path: string; kind: string; size_bytes: number; sha256: string; display_name?: string; }
export interface ArtifactIndex { schema_version: "1.0"; artifacts: Record<string, ArtifactIndexEntry>; }
export interface RunEvent { seq: number; kind: string; phase?: string; at: string; detail: Record<string, unknown>; }

const SAFE_ID = /^[A-Za-z0-9_.:-]+$/;
const SAFE_KIND = /^[A-Za-z0-9_.:-]+$/;
const SAFE_DISPLAY_NAME = /^[A-Za-z0-9_.-]+$/;
const ARTIFACT_HANDLE = /^art_[a-f0-9]{64}$/;
const ARTIFACT_INDEX_PATH = /^cases\/[A-Za-z0-9_.:%-]+\/artifacts\/art_[a-f0-9]{64}(?:\.[A-Za-z0-9_.-]+)?$/;
const LOCK_LEASE_MS = 30_000;
interface LockHandle { fd: number; ownerToken: string; path: string; }

export class RunStorage {
  readonly dataRoot: string;
  readonly runsRoot: string;

  constructor(dataRoot: string) {
    this.dataRoot = path.resolve(dataRoot);
    this.runsRoot = path.join(this.dataRoot, "runs");
    fs.mkdirSync(this.runsRoot, { recursive: true });
  }

  runDir(runId: string): string {
    this.assertSafeSegment(runId, "run_id");
    const dir = path.join(this.runsRoot, runId);
    fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
    return dir;
  }

  caseDir(runId: string, caseId: string): string {
    this.assertSafeSegment(caseId, "case_id");
    const dir = this.safePath(runId, path.join("cases", this.caseStorageSegment(caseId)));
    fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
    return dir;
  }

  writeCaseJson(runId: string, caseId: string, name: string, value: unknown): void {
    this.assertSafeFileName(name, "case file name");
    this.caseDir(runId, caseId);
    this.writeFile(runId, path.join("cases", this.caseStorageSegment(caseId), name), Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8"));
  }

  writeCaseArtifact(runId: string, caseId: string, name: string, kind: string, data: Buffer | string): ArtifactRef {
    this.assertSafeFileName(name, "artifact file name");
    if (typeof kind !== "string" || !SAFE_KIND.test(kind)) throw Object.assign(new Error("artifact kind is invalid"), { code: "ARTIFACT_KIND_INVALID" });
    this.caseDir(runId, caseId);
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const logicalPath = this.toPortablePath(path.join("cases", this.caseStorageSegment(caseId), "artifacts", name));
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const handle = "art_" + crypto.createHash("sha256").update(runId + "\0" + logicalPath + "\0" + kind).update(bytes).digest("hex");
    const extension = path.extname(name);
    const storedName = handle + extension;
    const relativePath = this.toPortablePath(path.join("cases", this.caseStorageSegment(caseId), "artifacts", storedName));
    this.writeFile(runId, relativePath, bytes);
    this.updateArtifactIndex(runId, (index) => {
      index.artifacts[handle] = { relative_path: relativePath, kind, size_bytes: bytes.length, sha256, display_name: name };
      return index;
    });
    return { handle, kind, size_bytes: bytes.length };
  }

  writeJson(runId: string, name: string, value: unknown): void {
    this.writeFile(runId, name, Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8"));
  }

  readJson<T>(runId: string, name: string): T | undefined {
    const file = this.safePath(runId, name);
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  }

  compareAndSwapJson<T extends { lease?: { state_version?: number } }>(runId: string, name: string, expectedVersion: number, mutator: (value: T) => T): T | undefined {
    const file = this.safePath(runId, name);
    const lock = file + ".lock";
    let handle: LockHandle | undefined;
    try {
      handle = this._acquireLock(lock);
      if (!fs.existsSync(file)) return undefined;
      const current = JSON.parse(fs.readFileSync(file, "utf8")) as T;
      if (current.lease?.state_version !== expectedVersion) return undefined;
      const next = mutator(JSON.parse(JSON.stringify(current)) as T);
      this.writeJson(runId, name, next);
      return next;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
      throw error;
    } finally {
      if (handle !== undefined) this._releaseLock(handle);
    }
  }

  private _acquireLock(lock: string): LockHandle | undefined {
    const ownerToken = crypto.randomUUID();
    try {
      const fd = fs.openSync(lock, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, thread_id: threadId, owner_token: ownerToken, created_at: Date.now(), expires_at: Date.now() + LOCK_LEASE_MS }), "utf8");
      return { fd, ownerToken, path: lock };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw error;
      try {
        const stat = fs.statSync(lock);
        const metadata = JSON.parse(fs.readFileSync(lock, "utf8") || "{}") as { pid?: number; thread_id?: number; owner_token?: string; created_at?: number; expires_at?: number };
        const age = Date.now() - (metadata.created_at || stat.mtimeMs);
        if (age > LOCK_LEASE_MS || (typeof metadata.expires_at === "number" && Date.now() > metadata.expires_at)) {
          fs.rmSync(lock, { force: true });
          const fd = fs.openSync(lock, "wx");
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, thread_id: threadId, owner_token: ownerToken, created_at: Date.now(), expires_at: Date.now() + LOCK_LEASE_MS }), "utf8");
          return { fd, ownerToken, path: lock };
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      }
      return undefined;
    }
  }

  private _releaseLock(handle: LockHandle): void {
    try { fs.closeSync(handle.fd); } catch { /* already closed */ }
    try {
      const metadata = JSON.parse(fs.readFileSync(handle.path, "utf8") || "{}") as { owner_token?: string };
      if (metadata.owner_token === handle.ownerToken) fs.rmSync(handle.path, { force: true });
    } catch { /* best effort lock cleanup */ }
  }

  writeFile(runId: string, name: string, data: Buffer | string): void {
    const target = this.safePath(runId, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = target + ".tmp." + process.pid + "." + crypto.randomUUID();
    fs.writeFileSync(temporary, data);
    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
      fs.rmSync(target, { force: true });
      fs.renameSync(temporary, target);
    }
  }

  appendEvent(runId: string, event: Omit<RunEvent, "seq" | "at"> & Partial<Pick<RunEvent, "at">>): RunEvent {
    const file = this.safePath(runId, "events.jsonl");
    const previous = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length : 0;
    const next: RunEvent = { seq: previous + 1, at: event.at || new Date().toISOString(), kind: event.kind, phase: event.phase, detail: event.detail };
    fs.appendFileSync(file, JSON.stringify(next) + "\n", "utf8");
    return next;
  }

  writeArtifact(runId: string, name: string, kind: string, data: Buffer | string): ArtifactRef {
    this.writeFile(runId, path.join("artifacts", name), data);
    const size = fs.statSync(this.safePath(runId, path.join("artifacts", name))).size;
    return { handle: "art_" + runId.slice(4, 12) + "_" + name.replace(/[^A-Za-z0-9_.-]/g, "_"), kind, size_bytes: size };
  }

  artifactPath(runId: string, name: string): string { return this.safePath(runId, path.join("artifacts", name)); }
  readArtifact(runId: string, name: string): Buffer { return fs.readFileSync(this.safePath(runId, path.join("artifacts", name))); }

  artifactIndexPath(runId: string): string { return this.safePath(runId, "artifact-index.json"); }

  readArtifactIndex(runId: string): ArtifactIndex | undefined {
    const file = this.artifactIndexPath(runId);
    if (!fs.existsSync(file)) return undefined;
    const index = JSON.parse(fs.readFileSync(file, "utf8")) as ArtifactIndex;
    this.validateArtifactIndex(index);
    return index;
  }

  private updateArtifactIndex(runId: string, mutator: (index: ArtifactIndex) => ArtifactIndex): ArtifactIndex {
    const indexPath = this.artifactIndexPath(runId);
    const lockPath = indexPath + ".lock";
    const handle = this._acquireRetryingLock(lockPath);
    try {
      const current = this.readArtifactIndex(runId) || { schema_version: "1.0", artifacts: {} };
      const next = mutator(JSON.parse(JSON.stringify(current)) as ArtifactIndex);
      this.validateArtifactIndex(next);
      this.writeJson(runId, "artifact-index.json", next);
      return next;
    } finally {
      this._releaseLock(handle);
    }
  }

  private _acquireRetryingLock(lock: string): LockHandle {
    for (let attempt = 0; attempt < 7_000; attempt += 1) {
      const handle = this._acquireLock(lock);
      if (handle !== undefined) return handle;
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(sleeper, 0, 0, 5);
    }
    throw Object.assign(new Error("artifact index lock timeout"), { code: "ARTIFACT_INDEX_LOCK_TIMEOUT" });
  }

  private validateArtifactIndex(index: ArtifactIndex): void {
    if (!index || index.schema_version !== "1.0" || !index.artifacts || typeof index.artifacts !== "object" || Array.isArray(index.artifacts)) throw Object.assign(new Error("artifact index is invalid"), { code: "ARTIFACT_INDEX_INVALID" });
    for (const [handle, entry] of Object.entries(index.artifacts)) {
      const storedName = entry && typeof entry.relative_path === "string" ? path.posix.basename(entry.relative_path) : "";
      if (!ARTIFACT_HANDLE.test(handle) || !entry || !ARTIFACT_INDEX_PATH.test(entry.relative_path) || !(storedName === handle || storedName.startsWith(handle + ".")) || !SAFE_KIND.test(entry.kind) || !Number.isInteger(entry.size_bytes) || entry.size_bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256) || (entry.display_name !== undefined && !this.isSafeDisplayName(entry.display_name))) throw Object.assign(new Error("artifact index entry is invalid"), { code: "ARTIFACT_INDEX_INVALID" });
    }
  }

  readArtifactRef(runId: string, ref: ArtifactRef): Buffer {
    if (ref && typeof ref.handle === "string" && ARTIFACT_HANDLE.test(ref.handle)) {
      const entry = this.readArtifactIndex(runId)?.artifacts[ref.handle];
      if (!entry || typeof ref.kind !== "string" || !SAFE_KIND.test(ref.kind) || entry.kind !== ref.kind) throw Object.assign(new Error("artifact reference is invalid or has the wrong kind"), { code: "ARTIFACT_HANDLE_INVALID" });
      const target = this.safePath(runId, entry.relative_path);
      if (!fs.existsSync(target)) throw Object.assign(new Error("artifact has expired or is unavailable"), { code: "RESULT_EXPIRED" });
      const bytes = fs.readFileSync(target);
      if (bytes.length !== entry.size_bytes || crypto.createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw Object.assign(new Error("artifact integrity check failed"), { code: "ARTIFACT_CORRUPT" });
      return bytes;
    }
    const prefix = "art_" + runId.slice(4, 12) + "_";
    if (!ref || typeof ref.handle !== "string" || !ref.handle.startsWith(prefix) || !/^art_[A-Za-z0-9_.-]+$/.test(ref.handle)) {
      throw Object.assign(new Error("artifact reference is not bound to this run"), { code: "ARTIFACT_HANDLE_INVALID" });
    }
    const name = ref.handle.slice(prefix.length);
    if (!name || path.basename(name) !== name || (ref.kind && name !== ref.kind)) {
      throw Object.assign(new Error("artifact reference kind does not match handle"), { code: "ARTIFACT_HANDLE_INVALID" });
    }
    const target = this.artifactPath(runId, name);
    if (!fs.existsSync(target)) throw Object.assign(new Error("artifact has expired or is unavailable"), { code: "RESULT_EXPIRED" });
    return fs.readFileSync(target);
  }

  readEvents(runId: string, limit = 20): RunEvent[] {
    const file = this.safePath(runId, "events.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-Math.max(1, limit)).map((line) => JSON.parse(line) as RunEvent);
  }

  private safePath(runId: string, name: string): string {
    const base = path.resolve(this.runDir(runId));
    const target = path.resolve(base, name);
    const relative = path.relative(base, target);
    if (relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("artifact path escapes run directory");
    this.assertRealpathWithin(base, target);
    return target;
  }

  private assertSafeSegment(value: string, label: string): void {
    if (typeof value !== "string" || value === "." || value === ".." || !SAFE_ID.test(value)) throw Object.assign(new Error(label + " is invalid"), { code: "SAFE_PATH_INVALID" });
  }

  private assertSafeFileName(value: string, label: string): void {
    if (typeof value !== "string" || !value || value === "." || value === ".." || path.basename(value) !== value || value.includes("/") || value.includes("\\") || !SAFE_DISPLAY_NAME.test(value) || value.endsWith(".")) throw Object.assign(new Error(label + " is invalid"), { code: "SAFE_PATH_INVALID" });
  }

  private isSafeDisplayName(value: unknown): value is string {
    return typeof value === "string" && Boolean(value) && path.basename(value) === value && !value.includes("/") && !value.includes("\\") && SAFE_DISPLAY_NAME.test(value) && !value.endsWith(".");
  }

  private assertRealpathWithin(base: string, target: string): void {
    const realBase = fs.realpathSync(base);
    let existing = target;
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    const realExisting = fs.realpathSync(existing);
    const candidate = path.resolve(realExisting, path.relative(existing, target));
    const relative = path.relative(realBase, candidate);
    if (relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw Object.assign(new Error("artifact path escapes run directory"), { code: "WORKSPACE_ESCAPE" });
  }

  private toPortablePath(value: string): string { return value.split(path.sep).join("/"); }
  private caseStorageSegment(caseId: string): string { return caseId.replaceAll(":", "%3A"); }
}
