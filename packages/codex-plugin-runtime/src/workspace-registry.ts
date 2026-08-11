import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TrustedWorkspace {
  workspace_id: string;
  realpath: string;
  target: { base_url: string; allowed_origins: string[] };
  profile_path: string;
  production: boolean;
  auth_scope: { auth_scope_id: string; mode: "none"; isolated: true };
}

interface RegistryDocument { schema_version: "1"; workspaces: TrustedWorkspace[]; }

export class WorkspaceTrustRegistry {
  readonly configRoot: string;
  readonly registryPath: string;

  constructor(configRoot = process.env.AUTOPW_CONFIG_HOME || path.join(process.env.APPDATA || os.homedir(), ".autopw")) {
    this.configRoot = path.resolve(configRoot);
    this.registryPath = path.join(this.configRoot, "workspaces.json");
  }

  list(): TrustedWorkspace[] { return this.read().workspaces.map((item) => ({ ...item, target: { ...item.target, allowed_origins: [...item.target.allowed_origins] }, auth_scope: { ...item.auth_scope } })); }

  trust({ workspacePath, targetUrl, profilePath = "profiles/default/profile.json" }: { workspacePath: string; targetUrl: string; profilePath?: string }): TrustedWorkspace {
    const realpath = this.workspaceRealpath(workspacePath);
    const target = normalizeTarget(targetUrl);
    const document = this.read();
    const retained = document.workspaces.filter((item) => item.realpath !== realpath);
    const workspace_id = "ws_" + crypto.createHash("sha256").update(realpath).digest("hex").slice(0, 16);
    const entry: TrustedWorkspace = { workspace_id, realpath, target, profile_path: normalizeProfile(profilePath), production: false, auth_scope: { auth_scope_id: "as_local", mode: "none", isolated: true } };
    this.write({ schema_version: "1", workspaces: [...retained, entry].sort((a, b) => a.realpath.localeCompare(b.realpath)) });
    return entry;
  }

  untrust(workspacePath: string): boolean {
    const realpath = this.workspaceRealpath(workspacePath);
    const document = this.read();
    const workspaces = document.workspaces.filter((item) => item.realpath !== realpath);
    if (workspaces.length === document.workspaces.length) return false;
    this.write({ schema_version: "1", workspaces });
    return true;
  }

  resolve(workspacePath: string): TrustedWorkspace | undefined {
    const realpath = this.workspaceRealpath(workspacePath);
    return this.list().find((item) => item.realpath === realpath);
  }

  private workspaceRealpath(workspacePath: string): string {
    if (!workspacePath || !path.isAbsolute(workspacePath)) throw Object.assign(new Error("workspace_path must be an absolute existing directory"), { code: "WORKSPACE_PATH_INVALID" });
    const resolved = fs.realpathSync.native(workspacePath);
    if (!fs.statSync(resolved).isDirectory()) throw Object.assign(new Error("workspace_path must be a directory"), { code: "WORKSPACE_PATH_INVALID" });
    return resolved;
  }

  private read(): RegistryDocument {
    if (!fs.existsSync(this.registryPath)) return { schema_version: "1", workspaces: [] };
    try {
      const value = JSON.parse(fs.readFileSync(this.registryPath, "utf8")) as RegistryDocument;
      if (value.schema_version !== "1" || !Array.isArray(value.workspaces)) throw new Error("invalid registry schema");
      return value;
    } catch (error) { throw Object.assign(new Error("workspace trust registry is invalid: " + (error instanceof Error ? error.message : String(error))), { code: "WORKSPACE_REGISTRY_INVALID" }); }
  }

  private write(value: RegistryDocument): void {
    fs.mkdirSync(this.configRoot, { recursive: true });
    const temporary = this.registryPath + ".tmp." + process.pid + "." + crypto.randomBytes(4).toString("hex");
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.registryPath);
  }
}

function normalizeTarget(value: string): TrustedWorkspace["target"] {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw Object.assign(new Error("target URL is invalid"), { code: "TARGET_URL_INVALID" }); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" && parsed.pathname !== "") throw Object.assign(new Error("target URL must be an origin without embedded credentials"), { code: "TARGET_URL_INVALID" });
  return { base_url: parsed.origin, allowed_origins: [parsed.origin] };
}

function normalizeProfile(value: string): string {
  if (!value || path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) throw Object.assign(new Error("profile_path must be a relative contained path"), { code: "PROFILE_PATH_INVALID" });
  return value.replaceAll("\\", "/");
}
