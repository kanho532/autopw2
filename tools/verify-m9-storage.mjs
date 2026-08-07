// M9.2 Case-scoped evidence storage acceptance verifier.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { RunStorage } = await import(pathToFileURL(path.join(root, "packages/run-storage/dist/index.js")).href);
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopw-m9-storage-"));
const storage = new RunStorage(dataRoot);
let passed = 0;
let failed = 0;
function check(name, condition, detail = "") { if (condition) { passed += 1; console.log("PASS  " + name + (detail ? " (" + detail + ")" : "")); } else { failed += 1; console.log("FAIL  " + name + (detail ? " (" + detail + ")" : "")); } }
function rejects(action, code) { try { action(); return false; } catch (error) { return !code || error.code === code; } }

try {
  const runId = "run_m92";
  const caseId = "case_create:1";
  const dir = storage.caseDir(runId, caseId);
  check("m9.2-case-directory-created", fs.existsSync(path.join(dir, "artifacts")));
  storage.writeCaseJson(runId, caseId, "case.json", { case_id: caseId, title: "create" });
  check("m9.2-case-json-written", storage.readJson(runId, path.join("cases", "case_create%3A1", "case.json"))?.case_id === caseId);
  const ref = storage.writeCaseArtifact(runId, caseId, "trace.zip", "playwright-trace", Buffer.from("trace-data"));
  check("m9.2-opaque-artifact-handle", /^art_[a-f0-9]{64}$/.test(ref.handle) && !ref.handle.includes("trace.zip"));
  const indexPath = storage.artifactIndexPath(runId);
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  check("m9.2-artifact-index-written", index.schema_version === "1.0" && /^cases\/case_create%3A1\/artifacts\/art_[a-f0-9]{64}\.zip$/.test(index.artifacts[ref.handle]?.relative_path) && index.artifacts[ref.handle]?.display_name === "trace.zip");
  check("m9.2-index-records-kind-size-digest", index.artifacts[ref.handle].kind === "playwright-trace" && index.artifacts[ref.handle].size_bytes === 10 && /^[a-f0-9]{64}$/.test(index.artifacts[ref.handle].sha256));
  check("m9.2-index-handle-resolves", storage.readArtifactRef(runId, ref).toString() === "trace-data");
  check("m9.2-kind-confusion-rejected", rejects(() => storage.readArtifactRef(runId, { ...ref, kind: "screenshot" }), "ARTIFACT_HANDLE_INVALID"));
  check("m9.2-case-id-traversal-rejected", rejects(() => storage.caseDir(runId, "../escape"), "SAFE_PATH_INVALID"));
  check("m9.2-case-id-absolute-rejected", rejects(() => storage.caseDir(runId, path.resolve("escape")), "SAFE_PATH_INVALID"));
  check("m9.2-case-file-traversal-rejected", rejects(() => storage.writeCaseJson(runId, caseId, "../escape.json", {})));
  check("m9.2-artifact-file-traversal-rejected", rejects(() => storage.writeCaseArtifact(runId, caseId, "../escape.bin", "binary", "x")));
  check("m9.2-empty-artifact-kind-rejected", rejects(() => storage.writeCaseArtifact(runId, caseId, "empty.bin", "", "x"), "ARTIFACT_KIND_INVALID"));
  const firstVersion = storage.writeCaseArtifact(runId, caseId, "immutable.zip", "trace", "version-a");
  const secondVersion = storage.writeCaseArtifact(runId, caseId, "immutable.zip", "trace", "version-b");
  check("m9.2-same-display-name-uses-distinct-immutable-paths", firstVersion.handle !== secondVersion.handle && storage.readArtifactRef(runId, firstVersion).toString() === "version-a" && storage.readArtifactRef(runId, secondVersion).toString() === "version-b");

  const legacy = storage.writeArtifact(runId, "legacy.json", "legacy.json", "legacy");
  check("m9.2-legacy-handle-remains-readable", storage.readArtifactRef(runId, legacy).toString() === "legacy");
  const secondRef = storage.writeCaseArtifact(runId, "case_read", "response.json", "api-response", "response");
  check("m9.2-case-isolation-in-index", index.artifacts[ref.handle].relative_path.includes("case_create%3A1") && storage.readArtifactRef(runId, secondRef).toString() === "response");
  check("m9.2-index-schema-present", fs.existsSync(path.join(root, "packages/run-storage/schema/artifact-index.schema.json")));
  const concurrent = await Promise.all(Array.from({ length: 50 }, async (_, index) => {
    await Promise.resolve();
    return new RunStorage(dataRoot).writeCaseArtifact(runId, "case_concurrent", "artifact_" + index + ".bin", "concurrent", Buffer.from(String(index)));
  }));
  const concurrentIndex = storage.readArtifactIndex(runId);
  check("m9.2-concurrent-index-retains-all-artifacts", concurrentIndex && concurrent.length === 50 && Object.keys(concurrentIndex.artifacts).length >= 52);
  check("m9.2-concurrent-artifacts-resolve", concurrent.every((ref) => storage.readArtifactRef(runId, ref).length > 0));
} finally {
  fs.rmSync(dataRoot, { recursive: true, force: true });
}

console.log(`\nM9.2 storage verify: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
