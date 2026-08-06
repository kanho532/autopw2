import type { ArtifactRef } from "@autopw/run-storage";
import { RunStorage } from "@autopw/run-storage";

export function writeReport({ storage, runId, gate, auditStatus, summary, issues, resultsRef }: { storage: RunStorage; runId: string; gate: string; auditStatus: string; summary: Record<string, unknown>; issues: Record<string, unknown>[]; resultsRef: ArtifactRef }): { reportRef: ArtifactRef; htmlRef: ArtifactRef } {
  const issueRows = issues.map((item) => `| ${String(item.execution_id || "-")} | ${String(item.classification || "-")} | ${escapeHtml(String(item.message || ""))} |`).join("\n") || "| - | - | none |";
  const markdown = `# AutoPW Audit Report\n\n- Run: ${runId}\n- Gate: **${gate}**\n- Audit: **${auditStatus}**\n- Results: ${resultsRef.handle}\n\n## Summary\n\n\`${JSON.stringify(summary)}\`\n\n## Issues\n\n| Execution | Classification | Message |\n|---|---|---|\n${issueRows}\n`;
  const reportRef = storage.writeArtifact(runId, "report.md", "report.md", markdown);
  const html = `<!doctype html><meta charset="utf-8"><title>AutoPW Report</title><h1>AutoPW Audit Report</h1><p>Gate: <strong>${escapeHtml(gate)}</strong></p><p>Audit: <strong>${escapeHtml(auditStatus)}</strong></p><pre>${escapeHtml(JSON.stringify({ summary, issues }, null, 2))}</pre>`;
  const htmlRef = storage.writeArtifact(runId, "report.html", "report.html", html);
  return { reportRef, htmlRef };
}

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] || char)); }
