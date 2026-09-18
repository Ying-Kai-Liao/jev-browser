#!/usr/bin/env node
// MCP server (stdio): one persistent Jev-driven browser session for an LLM client.
//
//   claude mcp add jev-browser -- node /path/to/jev-browser/bin/jev-browser-mcp.mjs
//
// Env: TYPESAFE_API_KEY, JEV_BROWSER_HEADED=1,
//      JEV_BROWSER_PROFILE=/dir (persistent profile, keeps logins), JEV_BROWSER_LOG=1 (rounds to stderr)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { JevBrowser } from "../src/session.mjs";

// Holds the launch promise, not the session, so parallel tool calls share one browser.
let session;
function browser() {
  session ??= JevBrowser.launch({ headed: process.env.JEV_BROWSER_HEADED === "1", highlight: process.env.JEV_BROWSER_HEADED === "1", userDataDir: process.env.JEV_BROWSER_PROFILE || undefined })
    .catch(e => { session = undefined; throw e; });
  return session;
}
async function closeSession() {
  if (!session) return;
  const s = session; session = undefined;
  await (await s.catch(() => null))?.close();
}
const text = obj => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 1) }] });
const fail = e => ({ isError: true, content: [{ type: "text", text: String(e?.message ?? e).split("\n")[0] }] });
const wrap = fn => async args => { try { return await fn(args); } catch (e) { return fail(e); } };
const stderrLog = process.env.JEV_BROWSER_LOG === "1" ? s => process.stderr.write(s + "\n") : () => {};

const server = new McpServer({ name: "jev-browser", version: "0.1.1" });

server.registerTool("browser_open", {
  title: "Open URL",
  description: "Navigate the browser session to a URL and wait until the page settles. Starts the browser on first use.",
  inputSchema: { url: z.string().describe("Absolute URL") },
}, wrap(async ({ url }) => {
  const b = await browser();
  const r = await b.open(url);
  const page = await b.snapshot();
  return text({ ...r, elements: page.elements.length, visible_text: page.text.slice(0, 400) });
}));

server.registerTool("browser_do", {
  title: "Do one browser step",
  description: [
    "Work toward ONE observable outcome on the current page. A fast decision model (Jev) picks each element/action/value; it cannot write text or plan, so:",
    "- Write one outcome per call (\"Log in\", \"Add the Backpack to the cart\", \"Open the Pull requests tab\"); split ordered sub-tasks into separate calls.",
    "- Put every string to type, option to pick or file path to upload in `values`, with meaningful keys ({email, password}).",
    "- Make open-ended goals measurable (\"until at least 3 new results are shown\").",
    "Statuses: done | likely_done (Jev is unsure the goal is met: verify with browser_check or browser_snapshot before moving on) | needs_login (sign-in wall and no credentials given: ask the user to log in, e.g. with JEV_BROWSER_HEADED=1 and JEV_BROWSER_PROFILE, or pass credentials in values) | needs_confirmation (next click looks irreversible: re-call with allow_irreversible=true only if the user wants it) | error (page shows an error) | blocked | stuck | ambiguous (see candidates; use browser_act) | max_actions.",
    "After steps with side effects, use browser_check to confirm nothing unintended changed.",
  ].join("\n"),
  inputSchema: {
    goal: z.string().describe("One observable outcome"),
    values: z.record(z.string(), z.string()).optional().describe("Named strings Jev may type/select/upload"),
    max_actions: z.number().int().min(1).max(30).optional().describe("Default 10"),
    allow_irreversible: z.boolean().optional().describe("Proceed through actions like placing orders, paying, sending, deleting"),
    explain: z.boolean().optional().describe("Include per-round Jev probabilities"),
  },
}, wrap(async ({ goal, values, max_actions, allow_irreversible, explain }) => {
  const b = await browser();
  const r = await b.do(goal, { values: values ?? {}, maxActions: max_actions ?? 10, allowIrreversible: !!allow_irreversible, log: stderrLog });
  const actions = r.actions.map(h => h.event ? `(event) ${h.event}` : `${h.action}${h.key ? ` ${h.key}` : ""} ${h.element ?? ""}${h.value ? ` <- values.${h.value}` : ""}${h.option ? ` <- "${h.option}"` : ""}${h.destination ? ` -> ${h.destination}` : ""}${h.error ? `  ERROR: ${h.error}` : ""}`.trim());
  const out = { status: r.status, url: r.url, title: r.title, actions, done_score: r.done_score, jev_calls: r.jev_calls, ms: r.ms };
  for (const k of ["info", "pending", "page_text", "candidates"]) if (r[k]) out[k] = r[k];
  if (explain) out.rounds = r.rounds.map(({ candidates, ...x }) => x);
  return text(out);
}));

server.registerTool("browser_check", {
  title: "Check page",
  description: "Ask a yes/no question about the current page. Returns the probability of yes (≥0.85 reliable yes, ≤0.15 reliable no, in between: look yourself with browser_snapshot).",
  inputSchema: { question: z.string() },
}, wrap(async ({ question }) => {
  const b = await browser();
  const p = await b.check(question);
  return text({ question, p_yes: +p.toFixed(3) });
}));

server.registerTool("browser_choose", {
  title: "Choose about page",
  description: "Ask which of several options is true of the current page. Options must be provided (Jev cannot generate text). Returns the choice and a probability per option.",
  inputSchema: { question: z.string(), options: z.array(z.string()).min(2).max(255) },
}, wrap(async ({ question, options }) => {
  const b = await browser();
  const r = await b.choose(question, options);
  return text({ choice: r.choice, confidence: r.confidence, probabilities: Object.fromEntries(Object.entries(r.probabilities).map(([k, v]) => [k, +v.toFixed(3)])) });
}));

server.registerTool("browser_snapshot", {
  title: "Page snapshot",
  description: [
    "Compact view of the current page: visible text and numbered interactive elements. Use it to take over when browser_do is ambiguous or stuck, then act with browser_act.",
    "This is the one observation you read in full, so narrow it: `diff` after an action, `filter` when you know what you are looking for, `interactive` when the page's prose does not matter.",
    "Link targets are omitted unless `urls` is true; element numbers, not URLs, are what browser_act takes.",
  ].join("\n"),
  inputSchema: {
    diff: z.boolean().optional().describe("Only what changed since the previous snapshot (falls back to a full one if there is none). Carries no element numbers: take a full snapshot to act."),
    interactive: z.boolean().optional().describe("Drop the visible-text block and list only elements (dialog/status text is kept)"),
    filter: z.string().optional().describe("Keep only elements whose label/text/placeholder/name/href contains this substring, case-insensitive"),
    urls: z.boolean().optional().describe("Print href= on element lines. Default false"),
    max_chars: z.number().int().min(200).optional().describe("Size limit of the rendered snapshot. Default 10000, capped at 20000"),
  },
}, wrap(async ({ diff, interactive, filter, urls, max_chars }) =>
  text(await (await browser()).snapshotText({ diff: !!diff, interactive: !!interactive, filter: filter ?? "", urls: !!urls, maxChars: max_chars }))));

server.registerTool("browser_act", {
  title: "Act on element",
  description: "Perform one action on an element number from the latest browser_snapshot (or from browser_do candidates). No decision model involved. Numbers are matched to the current page; if the element is gone, take a new snapshot. Confirm/prompt dialogs the action opens are dismissed unless accept_dialog is true.",
  inputSchema: {
    action: z.enum(["click", "type", "press_enter", "press_key", "select", "hover", "right_click", "drag", "upload", "scroll", "back"]),
    element: z.number().int().optional().describe("Element number [i]; not needed for scroll/back/page-level press_key"),
    value: z.string().optional().describe("Text to type, option label to select, or file path to upload"),
    key: z.string().optional().describe("Key for press_key, e.g. Escape"),
    destination: z.number().int().optional().describe("Drop target element number for drag"),
    accept_dialog: z.boolean().optional().describe("Accept a confirm/prompt dialog this action opens (e.g. \"Delete this item?\"). Default: dismiss"),
  },
}, wrap(async ({ accept_dialog, ...args }) => text(await (await browser()).actOn({ ...args, acceptDialog: !!accept_dialog }))));

server.registerTool("browser_screenshot", {
  title: "Screenshot",
  description: "Screenshot of the current page (viewport unless full_page).",
  inputSchema: { full_page: z.boolean().optional() },
}, wrap(async ({ full_page }) => {
  const buf = await (await browser()).screenshot({ fullPage: !!full_page });
  return { content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/png" }] };
}));

server.registerTool("browser_close", {
  title: "Close browser",
  description: "Close the browser session. The next call starts a fresh one.",
  inputSchema: {},
}, wrap(async () => {
  await closeSession();
  return text({ closed: true });
}));

const shutdown = async () => { await closeSession(); process.exit(0); };
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
await server.connect(new StdioServerTransport());
