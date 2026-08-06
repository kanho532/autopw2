import fs from "node:fs";
import path from "node:path";

export const PACKAGE = "@autopw/maintenance-cli";
export const VERSION = "2.1.0-rc5.mcp-first";
export const OPERATIONAL_EXIT = 70;
export const QUALITY_EXIT = Object.freeze({ pass: 0, fail: 1, unstable: 1, incomplete: 2, infra: 2 });

export interface DoctorReport { ok: boolean; version: string; checks: Array<{ name: string; ok: boolean; detail: string }>; migration?: MigrationReport; }
export interface MigrationReport { changed: boolean; schema_version: string; backup?: string; warnings: string[]; }

export function doctor(root = process.cwd(), dataRoot = path.join(root, ".autopw", "data"), migrate = false): DoctorReport {
  const checks: DoctorReport["checks"] = [];
  const packageFile = path.join(root, "package.json");
  const packageJson = readJson(packageFile) as { version?: string };
  checks.push({ name: "node", ok: Number(process.versions.node.split(".")[0]) >= 20, detail: process.version });
  checks.push({ name: "package", ok: Boolean(packageJson.version), detail: packageJson.version || "missing package.json version" });
  checks.push(...bundleChecks(root));
  let migration: MigrationReport | undefined;
  if (migrate) migration = migrateDataRoot(dataRoot);
  return { ok: checks.every((item) => item.ok) && (!migration || migration.warnings.length === 0), version: packageJson.version || VERSION, checks, ...(migration ? { migration } : {}) };
}

export function verifySchemaBundle(root = process.cwd()): { ok: boolean; schema_count: number; tool_count: number; errors: string[] } {
  const errors: string[] = [];
  try {
    const schemas = readJson(path.join(root, "packages", "schemas", "schemas", "manifest.json")) as { schema_version?: string; count?: number; schemas?: string[] };
    const tools = readJson(path.join(root, "packages", "mcp-contracts", "contracts", "manifest.json")) as { schema_version?: string; tools?: string[] };
    if (schemas.schema_version !== "2.1" || tools.schema_version !== "2.1") errors.push("schema bundle version is not 2.1");
    if (!schemas.schemas?.length || schemas.count !== schemas.schemas.length) errors.push("schema manifest count mismatch");
    if (!tools.tools?.length || tools.tools.length !== 10) errors.push("tool manifest must contain the frozen 10-tool surface");
    return { ok: errors.length === 0, schema_count: schemas.schemas?.length || 0, tool_count: tools.tools?.length || 0, errors };
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); return { ok: false, schema_count: 0, tool_count: 0, errors }; }
}

export function migrateDataRoot(dataRoot: string): MigrationReport {
  fs.mkdirSync(dataRoot, { recursive: true });
  const metaFile = path.join(dataRoot, "storage-meta.json");
  const warnings: string[] = [];
  const current = fs.existsSync(metaFile) ? readJson(metaFile) as { schema_version?: string } : {};
  if (current.schema_version && !/^2\.1(?:\.|$)/.test(current.schema_version)) { warnings.push("unsupported storage schema version " + current.schema_version); return { changed: false, schema_version: current.schema_version, warnings }; }
  if (current.schema_version === "2.1") return { changed: false, schema_version: "2.1", warnings };
  let backup: string | undefined;
  if (fs.existsSync(metaFile)) { backup = metaFile + ".bak"; fs.copyFileSync(metaFile, backup); }
  atomicWrite(metaFile, { ...current, schema_version: "2.1", migrated_at: new Date().toISOString(), migration: "M7" });
  return { changed: true, schema_version: "2.1", backup, warnings };
}

export function readResultsForCi(file: string): { gate: keyof typeof QUALITY_EXIT; quality_exit_code: number; result: Record<string, unknown> } {
  const result = readJson(file) as Record<string, unknown>;
  const gate = String(result.gate || "") as keyof typeof QUALITY_EXIT;
  if (!(gate in QUALITY_EXIT)) throw Object.assign(new Error("results.json has no supported gate"), { code: "RESULTS_INVALID" });
  return { gate, quality_exit_code: QUALITY_EXIT[gate], result };
}

export function validateProfile(file: string): { ok: boolean; errors: string[] } {
  try {
    const value = readJson(file) as Record<string, unknown>;
    const errors: string[] = [];
    if (value.schema_version !== "2.1") errors.push("schema_version must be 2.1");
    if (!value.base_tier || !["smoke", "fast", "full"].includes(String(value.base_tier))) errors.push("base_tier must be smoke, fast or full");
    if (!value.gate || typeof value.gate !== "object") errors.push("gate configuration is required");
    return { ok: errors.length === 0, errors };
  } catch (error) { return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }; }
}

export function runCli(argv = process.argv.slice(2)): number {
  const root = option(argv, "--root") || process.cwd();
  const dataRoot = option(argv, "--data-root") || path.join(root, ".autopw", "data");
  try {
    const [command, subcommand, target] = argv.filter((item) => !item.startsWith("--") && !item.includes("="));
    if (command === "doctor") { print(doctor(root, dataRoot, argv.includes("--migrate"))); return 0; }
    if (command === "schema" && subcommand === "verify") { const result = verifySchemaBundle(root); if (argv.includes("--migrate")) (result as Record<string, unknown>).migration = migrateDataRoot(dataRoot); print(result); return result.ok ? 0 : OPERATIONAL_EXIT; }
    if (command === "profile" && subcommand === "validate") { const result = validateProfile(target || path.join(root, "profiles", "default", "profile.json")); print(result); return result.ok ? 0 : OPERATIONAL_EXIT; }
    if (command === "server" && subcommand === "status") { print({ ok: fs.existsSync(dataRoot), data_root: dataRoot, mode: "maintenance-only", running: false }); return fs.existsSync(dataRoot) ? 0 : OPERATIONAL_EXIT; }
    if (command === "run" && subcommand === "status") { const state = readJson(path.join(dataRoot, "runs", target || "", "run_state.json")); print(state); return 0; }
    print({ ok: false, code: "USAGE", message: "maintenance commands: doctor, schema verify, profile validate, server status, run status" }); return 64;
  } catch (error) { print({ ok: false, code: (error as { code?: string }).code || "OPERATIONAL_ERROR", message: error instanceof Error ? error.message : String(error) }); return OPERATIONAL_EXIT; }
}

function bundleChecks(root: string): DoctorReport["checks"] {
  const files = ["packages/schemas/schemas/manifest.json", "packages/mcp-contracts/contracts/manifest.json", "packages/mcp-contracts/contracts/host-context.contract.json"];
  return files.map((file) => ({ name: file, ok: fs.existsSync(path.join(root, file)), detail: fs.existsSync(path.join(root, file)) ? "present" : "missing" }));
}
function option(argv: string[], name: string): string | undefined { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; }
function readJson(file: string): unknown { return JSON.parse(fs.readFileSync(file, "utf8")); }
function atomicWrite(file: string, value: unknown): void { const temporary = file + ".tmp." + process.pid; fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", "utf8"); fs.renameSync(temporary, file); }
function print(value: unknown): void { process.stdout.write(JSON.stringify(value, null, 2) + "\n"); }

if (import.meta.url === new URL(process.argv[1] || "", "file:").href) process.exitCode = runCli();
