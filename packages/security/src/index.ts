import fs from "node:fs";
import dns from "node:dns";
import net from "node:net";
import path from "node:path";

export type TrustMode = "trusted" | "untrusted_pr";
export type LifecycleMode = "connect" | "manage";
export type DestructivePolicy = "deny" | "read_only" | "allow";
export type ConfigSourceKind = "base" | "fixed" | "head" | "approved_overlay";

export interface HostContextLike {
  trust_mode: TrustMode;
  workspace_authorization: { workspace_id: string; workspace_realpath: string; deny_symlink_escape?: boolean };
  auth_scope: { auth_scope_id: string; mode: "none" | "credentials" | "storage_state"; isolated: true; one_shot?: boolean };
  config_source?: { base_revision?: string; fixed_path?: string; approved_overlay?: string; pr_head_allowed?: boolean };
  policy_version?: string;
  production?: boolean;
  allowed_origins?: string[];
}

export interface ProfileSafetyInput {
  lifecycle?: LifecycleMode;
  production?: boolean;
  destructive_actions?: DestructivePolicy;
  config_source?: ConfigSourceKind;
  auth_scope_id?: string;
  allowed_origins?: string[];
  allowed_file_roots?: string[];
}

export interface EffectiveSecurityPolicy {
  trust_mode: TrustMode;
  lifecycle: LifecycleMode;
  production: boolean;
  destructive_actions: Exclude<DestructivePolicy, "allow"> | DestructivePolicy;
  auth_scope_id: string;
  config_source: "base" | "fixed" | "approved_overlay";
  allowed_origins: string[];
  allowed_file_roots: string[];
}

export interface TrustResolution { policy: EffectiveSecurityPolicy; snapshot: Record<string, unknown>; }

const SECRET_KEY = /(?:password|passwd|token|secret|cookie|authorization|api[_-]?key|private[_-]?key|client[_-]?secret)/i;
const SECRET_TEXT = /((?:bearer\s+)[A-Za-z0-9._~+/=-]+|(?:password|passwd|token|secret|cookie|authorization|api[_-]?key|private[_-]?key|client[_-]?secret)\s*[:=]\s*)[^\s,&]+/gi;
const SECRET_VALUE = /(?:bearer\s+[A-Za-z0-9._~+/=-]+|(?:password|passwd|token|secret|cookie|authorization|api[_-]?key|private[_-]?key|client[_-]?secret)\s*[:=]\s*)[^\s,&]+/i;

export class TrustResolver {
  resolve(host: HostContextLike, profile: ProfileSafetyInput = {}): TrustResolution {
    if (host.trust_mode !== "trusted" && host.trust_mode !== "untrusted_pr") throw securityError("INVALID_TRUST_MODE", "host trust mode is not supported");
    if (host.trust_mode === "untrusted_pr" && host.config_source?.pr_head_allowed === true) throw securityError("UNTRUSTED_HEAD_CONFIG", "untrusted_pr cannot authorize PR head configuration");
    if (host.trust_mode === "untrusted_pr" && (host.auth_scope.mode === "storage_state" || (host.auth_scope.mode === "credentials" && host.auth_scope.one_shot !== true))) throw securityError("UNTRUSTED_AUTH_SCOPE", "untrusted_pr requires none or isolated one-shot credentials");
    if (profile.auth_scope_id && profile.auth_scope_id !== host.auth_scope.auth_scope_id) throw securityError("AUTH_SCOPE_NOT_APPROVED", "profile auth scope is not host approved");
    const lifecycle: LifecycleMode = host.trust_mode === "untrusted_pr" ? "connect" : profile.lifecycle || "connect";
    const production = Boolean(host.production || profile.production);
    if (production && profile.destructive_actions === "allow") throw securityError("PRODUCTION_MUTATION_DENIED", "production policy cannot allow destructive actions");
    const destructive = production ? "deny" : profile.destructive_actions || "deny";
    const source = host.trust_mode === "untrusted_pr"
      ? profile.config_source === "head" ? "base"
        : profile.config_source === "approved_overlay" && host.config_source?.approved_overlay ? "approved_overlay"
          : profile.config_source === "fixed" && host.config_source?.fixed_path ? "fixed" : "base"
      : (profile.config_source === "head" ? "base" : profile.config_source || "fixed");
    if (host.trust_mode === "untrusted_pr" && profile.config_source === "head") throw securityError("UNTRUSTED_HEAD_CONFIG", "head configuration is not authoritative for untrusted_pr");
    const hostOrigins = (host.allowed_origins || []).map(normalizeAllowedOrigin);
    const profileOrigins = (profile.allowed_origins || hostOrigins).map(normalizeAllowedOrigin);
    const allowedOrigins = hostOrigins.length === 0 ? [] : profileOrigins.filter((origin) => hostOrigins.some((hostOrigin) => originWithin(origin, hostOrigin)));
    const base = path.resolve(host.workspace_authorization.workspace_realpath);
    const roots = (profile.allowed_file_roots || ["."]).map((root) => resolveAuthorizedPath(base, root));
    const policy: EffectiveSecurityPolicy = { trust_mode: host.trust_mode, lifecycle, production, destructive_actions: destructive, auth_scope_id: host.auth_scope.auth_scope_id, config_source: source, allowed_origins: [...new Set(allowedOrigins)], allowed_file_roots: roots };
    return { policy, snapshot: { trust_mode: policy.trust_mode, lifecycle: policy.lifecycle, production: policy.production, destructive_actions: policy.destructive_actions, auth_scope_id: policy.auth_scope_id, config_source: policy.config_source, allowed_origins: policy.allowed_origins, allowed_file_roots: policy.allowed_file_roots.map(() => "<authorized>"), policy_version: host.policy_version || "unknown" } };
  }
}

export class SecurityPolicyEngine extends TrustResolver {
  authorizeRequest(host: HostContextLike, request: Record<string, unknown>): TrustResolution {
    const profile: ProfileSafetyInput = { lifecycle: request.lifecycle as LifecycleMode | undefined, auth_scope_id: typeof request.auth_scope_id === "string" ? request.auth_scope_id : undefined };
    const resolution = this.resolve(host, profile);
    if (resolution.policy.trust_mode === "untrusted_pr" && request.lifecycle === "manage") throw securityError("UNTRUSTED_MANAGE_DENIED", "untrusted_pr requires connect lifecycle");
    if (typeof request.project_root === "string" || typeof request.run_directory === "string") throw securityError("UNSAFE_PATH_PARAMETER", "arbitrary project_root/run_directory is not accepted");
    return resolution;
  }
}

export class BrowserNetworkGuard {
  readonly allowedOrigins: Set<string>;
  constructor(allowedOrigins: string[]) { this.allowedOrigins = new Set(allowedOrigins.map(normalizeAllowedOrigin)); }
  check(value: string): { allowed: true; origin: string } | { allowed: false; code: "SAFETY_POLICY_VIOLATION"; reason: string } {
    let url: URL;
    try { url = new URL(value); } catch { return { allowed: false, code: "SAFETY_POLICY_VIOLATION", reason: "invalid URL" }; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return { allowed: false, code: "SAFETY_POLICY_VIOLATION", reason: "URL scheme is not allowed" };
    if (url.username || url.password) return { allowed: false, code: "SAFETY_POLICY_VIOLATION", reason: "URL credentials are not allowed" };
    if (![...this.allowedOrigins].some((origin) => originMatchesUrl(origin, url))) return { allowed: false, code: "SAFETY_POLICY_VIOLATION", reason: "origin is not allowed" };
    const address = net.isIP(url.hostname);
    if ((address === 4 && isUnsafeIpv4(url.hostname)) || (address === 6 && isUnsafeIpv6(url.hostname))) {
      if (!isExplicitLoopbackOrigin(url.hostname, this.allowedOrigins)) return { allowed: false, code: "SAFETY_POLICY_VIOLATION", reason: "private network is not allowed" };
    }
    return { allowed: true, origin: url.origin };
  }
  assertAllowed(value: string): void { const result = this.check(value); if (!result.allowed) throw securityError(result.code, result.reason); }
  async assertAllowedAsync(value: string): Promise<void> {
    this.assertAllowed(value);
    const url = new URL(value);
    if (net.isIP(url.hostname) || url.hostname.toLowerCase() === "localhost") return;
    let addresses: dns.LookupAddress[];
    try { addresses = await dns.promises.lookup(url.hostname, { all: true, verbatim: true }); }
    catch { throw securityError("SAFETY_POLICY_VIOLATION", "origin DNS could not be resolved safely"); }
    if (addresses.some((address) => isUnsafeAddress(address.address))) throw securityError("SAFETY_POLICY_VIOLATION", "origin resolves to a private network");
  }
}

export interface AdapterInvocation { cwd: string; env: Record<string, string | undefined>; command_id: string; network_origins?: string[]; timeout_ms: number; output_bytes: number; }
export class AdapterSandbox {
  readonly roots: string[];
  readonly envAllowlist: Set<string>;
  readonly network: BrowserNetworkGuard;
  constructor({ roots, allowedEnv, allowedOrigins }: { roots: string[]; allowedEnv: string[]; allowedOrigins: string[] }) { this.roots = roots.map((root) => path.resolve(root)); this.envAllowlist = new Set(allowedEnv); this.network = new BrowserNetworkGuard(allowedOrigins); }
  validate(invocation: AdapterInvocation): void {
    if (!this.roots.some((root) => isWithin(root, resolveExistingPath(invocation.cwd)))) throw securityError("ADAPTER_PATH_DENIED", "adapter cwd is outside sandbox roots");
    if (!/^[A-Za-z0-9_.:-]+$/.test(invocation.command_id) || /(?:child_process|node:|require|import|;|&&|\|)/i.test(invocation.command_id)) throw securityError("ADAPTER_COMMAND_DENIED", "adapter command is not a registered command id");
    for (const key of Object.keys(invocation.env)) if (!this.envAllowlist.has(key)) throw securityError("ADAPTER_ENV_DENIED", "adapter environment key is not allowlisted");
    for (const origin of invocation.network_origins || []) this.network.assertAllowed(origin);
    if (invocation.timeout_ms <= 0 || invocation.timeout_ms > 1_800_000) throw securityError("ADAPTER_TIMEOUT_DENIED", "adapter timeout exceeds policy");
    if (invocation.output_bytes < 0 || invocation.output_bytes > 1_048_576) throw securityError("ADAPTER_OUTPUT_DENIED", "adapter output exceeds policy");
  }
}

export class SecureArtifactService {
  authorizeRead({ requestedWorkspaceId, runWorkspaceId, handle, kind }: { requestedWorkspaceId: string; runWorkspaceId: string; handle: string; kind?: string }): void {
    if (requestedWorkspaceId !== runWorkspaceId) throw securityError("ARTIFACT_FORBIDDEN", "artifact is not bound to this workspace");
    if (!/^art_[A-Za-z0-9_.-]+$/.test(handle) || handle.includes("..") || path.isAbsolute(handle)) throw securityError("ARTIFACT_HANDLE_INVALID", "artifact handle is not safe");
    if (kind && this.resolveArtifactName({ handle, kind }) === undefined) throw securityError("ARTIFACT_HANDLE_INVALID", "artifact kind does not match handle");
  }
  resolveArtifactName({ handle, kind }: { handle: string; kind: string }): string | undefined {
    if (!/^art_[A-Za-z0-9_.-]+$/.test(handle) || handle.includes("..") || path.isAbsolute(handle)) return undefined;
    const marker = handle.indexOf("_", 4);
    if (marker < 0) return undefined;
    const name = handle.slice(marker + 1);
    return name && path.basename(name) === name && name === kind ? name : undefined;
  }
}

export function resolveAuthorizedPath(base: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.startsWith("\\\\") || /^[A-Za-z]:/i.test(relative)) throw securityError("WORKSPACE_ESCAPE", "absolute, UNC and drive paths are not accepted");
  const baseReal = fs.realpathSync.native(path.resolve(base));
  const target = path.resolve(baseReal, relative);
  if (!isWithin(baseReal, target)) throw securityError("WORKSPACE_ESCAPE", "path escapes workspace");
  const existing = resolveExistingPath(target);
  if (!isWithin(baseReal, existing)) throw securityError("WORKSPACE_ESCAPE", "realpath escapes workspace");
  return target;
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return value.replace(SECRET_TEXT, "$1[REDACTED]");
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : redactSecrets(item)]));
  return value;
}

export function assertNoSecrets(value: unknown): void { const found = findSecretPaths(value, "$"); if (found.length) throw securityError("SECRET_IN_INPUT", "secret-like fields are not accepted: " + found.join(",")); }
export function normalizeOrigin(value: string): string { const url = new URL(value); if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "")) throw securityError("INVALID_ORIGIN", "origin must not contain credentials or path"); return url.origin; }
function findSecretPaths(value: unknown, prefix: string): string[] { if (typeof value === "string") return SECRET_VALUE.test(value) ? [prefix] : []; if (Array.isArray(value)) return value.flatMap((item, index) => findSecretPaths(item, prefix + "[" + index + "]")); if (!value || typeof value !== "object") return []; return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => SECRET_KEY.test(key) ? [prefix + "." + key] : findSecretPaths(item, prefix + "." + key)); }
function resolveExistingPath(target: string): string { let current = path.resolve(target); while (!fs.existsSync(current)) { const parent = path.dirname(current); if (parent === current) break; current = parent; } return fs.realpathSync.native(current); }
function isWithin(base: string, candidate: string): boolean { const relative = path.relative(path.resolve(base), path.resolve(candidate)); return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)); }
function normalizeAllowedOrigin(value: string): string { if (/^https?:\/\/(?:\[[^\]]+\]|[^/:]+):\*$/.test(value)) return value.toLowerCase(); return normalizeOrigin(value); }
function originWithin(origin: string, hostOrigin: string): boolean { if (!hostOrigin.endsWith(":*")) return origin === hostOrigin; if (origin.endsWith(":*")) return origin === hostOrigin; const url = new URL(origin); return url.protocol + "//" + url.hostname.toLowerCase() + ":*" === hostOrigin; }
function originMatchesUrl(origin: string, url: URL): boolean { if (origin.endsWith(":*")) return url.protocol + "//" + url.hostname.toLowerCase() + ":*" === origin; return url.origin === origin; }
function isExplicitLoopbackOrigin(hostname: string, origins: Set<string>): boolean { const lower = hostname.toLowerCase(); return (lower === "127.0.0.1" || lower === "::1" || lower === "localhost") && [...origins].some((origin) => origin.includes("127.0.0.1") || origin.includes("localhost") || origin.includes("[::1]")); }
function isUnsafeAddress(address: string): boolean { const version = net.isIP(address); return version === 4 ? isUnsafeIpv4(address) : version === 6 && isUnsafeIpv6(address); }
function isUnsafeIpv4(hostname: string): boolean { const parts = hostname.split(".").map(Number); const first = parts[0]; const second = parts[1]; return first === 0 || first === 10 || first === 127 || (first === 100 && second >= 64 && second <= 127) || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 0) || (first === 192 && second === 168) || (first === 198 && (second === 18 || second === 19 || second === 51)) || (first === 203 && second === 0) || first >= 224;
}
function isUnsafeIpv6(hostname: string): boolean { const lower = hostname.toLowerCase(); return lower === "::1" || lower === "0:0:0:0:0:0:0:1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower) || lower.startsWith("::ffff:") && isUnsafeIpv4(lower.slice(7)); }
function securityError(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }
