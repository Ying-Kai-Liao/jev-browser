#!/usr/bin/env node
// Estimate how much page content the calling LLM must read per task:
//   Playwright MCP style: an AI aria snapshot comes back after every action.
//   jev-browser MCP: one compact browser_do result per step (Jev reads the page instead).
// Uses a finished bench run for action/step counts:  node bench/context-cost.mjs bench/results/r6.json
// Estimate only: snapshot size is measured on each task's start page and reused for every action.
// Superseded by bin/jev-cost.mjs, which measures every snapshot and both sides of the ledger
// (see RESULTS.md); kept because its numbers are published. Delete it if you no longer want them.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { TASKS as BASE, HARD, GUARD } from "./tasks.mjs";

const run = JSON.parse(readFileSync(process.argv[2], "utf8"));
const byId = new Map(run.results.map(r => [r.id, r]));
const tasks = [...BASE, ...HARD, ...GUARD].filter(t => byId.has(t.id));
const tok = chars => Math.round(chars / 4);

// Same shape the MCP server returns for browser_do (see bin/jev-browser-mcp.mjs).
function doResult(s) {
  const actions = (s.actions ?? []).map(h => h.event ? `(event) ${h.event}` : `${h.action} ${h.element ?? ""}${h.value ? ` <- values.${h.value}` : ""}`);
  const out = { status: s.status, url: s.url, title: s.title, actions, done_score: s.done_score, jev_calls: s.jev_calls, ms: s.ms };
  for (const k of ["info", "pending", "page_text", "candidates"]) if (s[k]) out[k] = s[k];
  return JSON.stringify(out, null, 1);
}

const browser = await chromium.launch();
const rows = [];
for (const t of tasks) {
  const r = byId.get(t.id);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  let snap = "";
  try {
    await page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(1500);
    snap = await page.ariaSnapshot({ mode: "ai" });
  } catch (e) { snap = ""; }
  await page.close();
  const actions = r.steps.reduce((a, s) => a + (s.actions ?? []).filter(h => h.action).length, 0);
  const pw = (actions + 1) * snap.length;
  const jb = 300 + r.steps.reduce((a, s) => a + doResult(s).length, 0);
  rows.push({ id: t.id, actions, steps: r.steps.length, snapshot_tokens: tok(snap.length), playwright_mcp_tokens: tok(pw), jev_browser_tokens: tok(jb), jev_tokens_offloaded: r.tokens });
}
await browser.close();

const pad = (s, n) => String(s).padStart(n);
console.log(`${"task".padEnd(22)}${pad("actions", 8)}${pad("snap tok", 10)}${pad("PW-MCP tok", 12)}${pad("jev-b tok", 11)}${pad("ratio", 7)}`);
for (const x of rows) console.log(`${x.id.padEnd(22)}${pad(x.actions, 8)}${pad(x.snapshot_tokens, 10)}${pad(x.playwright_mcp_tokens, 12)}${pad(x.jev_browser_tokens, 11)}${pad((x.playwright_mcp_tokens / x.jev_browser_tokens).toFixed(1) + "×", 7)}`);
const sum = k => rows.reduce((a, x) => a + x[k], 0);
const med = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
console.log(`\ntotal: Playwright-MCP-style ≈ ${sum("playwright_mcp_tokens")} tokens to the LLM; jev-browser ≈ ${sum("jev_browser_tokens")} tokens to the LLM (+ ${sum("jev_tokens_offloaded")} tokens read by Jev)`);
console.log(`median ratio ${med(rows.map(x => x.playwright_mcp_tokens / x.jev_browser_tokens)).toFixed(1)}×`);
