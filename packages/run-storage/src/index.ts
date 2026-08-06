import fs from "node:fs";
import path from "node:path";

export interface ArtifactRef { handle: string; kind: string; size_bytes?: number; }
export interface RunEvent { seq: number; kind: string; phase?: string; at: string; detail: Record<string, unknown>; }

export class RunStorage {
  readonly dataRoot: string;
  readonly runsRoot: string;

  constructor(dataRoot: string) {
    this.dataRoot = path.resolve(dataRoot);
    this.runsRoot = path.join(this.dataRoot, "runs");
    fs.mkdirSync(this.runsRoot, { recursive: true });
  }

  runDir(runId: string): string {
    const dir = path.join(this.runsRoot, runId);
    fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
    return dir;
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
    let handle: number | undefined;
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
      if (handle !== undefined) fs.closeSync(handle);
      if (handle !== undefined) { try { fs.rmSync(lock, { force: true }); } catch { /* best effort lock cleanup */ } }
    }
  }

  private _acquireLock(lock: string): number | undefined {
    try {
      const handle = fs.openSync(lock, "wx");
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, created_at: Date.now() }), "utf8");
      return handle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(lock);
        const metadata = JSON.parse(fs.readFileSync(lock, "utf8") || "{}") as { pid?: number; created_at?: number };
        const age = Date.now() - (metadata.created_at || stat.mtimeMs);
        const ownerAlive = typeof metadata.pid === "number" && this._processAlive(metadata.pid);
        if (age > 60_000 && !ownerAlive) {
          fs.rmSync(lock, { force: true });
          const handle = fs.openSync(lock, "wx");
          fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, created_at: Date.now() }), "utf8");
          return handle;
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      }
      return undefined;
    }
  }

  private _processAlive(pid: number): boolean {
    if (pid === process.pid) return true;
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  writeFile(runId: string, name: string, data: Buffer | string): void {
    const target = this.safePath(runId, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = target + ".tmp." + process.pid;
    fs.writeFileSync(temporary, data);
    fs.renameSync(temporary, target);
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

  readArtifactRef(runId: string, ref: ArtifactRef): Buffer {
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
    return target;
  }
}
