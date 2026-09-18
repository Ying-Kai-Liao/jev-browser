#!/usr/bin/env node
// End-to-end: spawn the MCP server over stdio and drive TodoMVC through its tools.
// Needs network and a Jev API key.   node test/mcp.e2e.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../bin/jev-browser-mcp.mjs", import.meta.url));
const client = new Client({ name: "e2e", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env } }));

const sizes = {};
async function call(name, args = {}) {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const c = r.content[0];
  sizes[name] = (sizes[name] ?? 0) + (c.text?.length ?? 0);
  if (r.isError) throw new Error(`${name}: ${c.text}`);
  const out = c.type === "text" ? (c.text.startsWith("{") ? JSON.parse(c.text) : c.text) : c;
  console.log(`${name} ${Date.now() - t}ms`, c.type === "text" ? (process.env.FULL ? c.text : c.text.slice(0, 160).replace(/\n/g, " ")) : `[${c.type} ${c.data.length} b64 chars]`);
  return out;
}

try {
const tools = (await client.listTools()).tools.map(t => t.name);
assert.deepEqual(tools.sort(), ["browser_act", "browser_check", "browser_choose", "browser_close", "browser_do", "browser_open", "browser_read", "browser_screenshot", "browser_snapshot"]);

await call("browser_open", { url: "https://demo.playwright.dev/todomvc/" });
let r = await call("browser_do", { goal: "Add a todo item", values: { todo: "buy milk" } });
assert.equal(r.status, "done");
r = await call("browser_do", { goal: "Add a todo item", values: { todo: "walk the dog" }, explain: true });
assert.equal(r.status, "done"); assert.ok(r.rounds.length >= 1);
const p = await call("browser_check", { question: "Are there exactly two todo items, 'buy milk' and 'walk the dog'?" });
assert.ok(p.p_yes > 0.6, `check p=${p.p_yes}`);
const ch = await call("browser_choose", { question: "How many items are left?", options: ["0", "1", "2", "3"] });
assert.equal(ch.choice, "2");
const snap = await call("browser_snapshot");
const line = snap.split("\n").find(l => /input:checkbox label="Toggle Todo"/.test(l) && /buy milk/.test(l));
assert.ok(line, "snapshot lists the buy milk toggle");
const i = +line.match(/^\[(\d+)\]/)[1];
// TodoMVC is far below the ranking threshold, so this is the gate path: content in full, no Jev call
const read = await call("browser_read", { question: "What todo items are on the list?" });
assert.match(read, /buy milk/); assert.match(read, /walk the dog/);
assert.match(read, /threshold for ranking: no Jev call/);
await call("browser_act", { action: "click", element: i });
const p2 = await call("browser_check", { question: "Is 'buy milk' marked as completed while 'walk the dog' is not?" });
assert.ok(p2.p_yes > 0.6, `check p=${p2.p_yes}`);
await call("browser_screenshot");
await call("browser_close");
console.log("\nMCP e2e passed. Text returned to the client (chars):", sizes);
} finally {
  await client.close();
}
