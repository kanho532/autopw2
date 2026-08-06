import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const maintenance = await import(pathToFileURL(path.join(root, "packages", "maintenance-cli", "dist", "index.js")).href);
const file = process.argv[2];
try {
  const result = maintenance.readResultsForCi(file || "results.json");
  process.stdout.write(JSON.stringify({ gate: result.gate, quality_exit_code: result.quality_exit_code }) + "\n");
  process.exitCode = result.quality_exit_code;
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error?.code || "OPERATIONAL_ERROR", message: error?.message || String(error) }) + "\n");
  process.exitCode = 70;
}
