// Offline tests for a persistent profile shared between a library caller and the MCP server:
// Chrome opens a profile in one browser at a time, so the server must let go of it when idle or
// when its client goes away, and a launch on a profile that is held must say so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { JevBrowser } from "../src/session.mjs";

// Playwright's headless shell doesn't lock a profile; Chrome and the full Chromium build do.
const USE = chromium.executablePath();
const launch = dir => JevBrowser.launch({ userDataDir: dir, use: USE });
const SERVER = fileURLToPath(new URL("../bin/jev-browser-mcp.mjs", import.meta.url));
const PAGE = "data:text/html,<p>hello</p>";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = t => { const d = mkdtempSync(join(tmpdir(), "jev-profile-")); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };

// The MCP server over raw stdio, so the test decides when stdin ends and never sends a signal.
function startServer(t, env) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, JEV_BROWSER_NO_INSTALL: "1", JEV_BROWSER: USE, ...env }, stdio: ["pipe", "pipe", "ignore"] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; } });
  const waiting = new Map();
  let buf = "", id = 0;
  child.stdout.on("data", d => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0;) {
      const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      waiting.get(msg.id)?.(msg); waiting.delete(msg.id);
    }
  });
  const send = msg => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  const request = (method, params) => new Promise(resolve => { waiting.set(++id, resolve); send({ id, method, params }); });
  const exited = new Promise(resolve => child.once("exit", code => resolve(code)));
  return {
    child, exited,
    async init() {
      await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      send({ method: "notifications/initialized" });
    },
    async call(name, args = {}) {
      const r = await request("tools/call", { name, arguments: args });
      if (r.error || r.result.isError) throw new Error(JSON.stringify(r.error ?? r.result.content));
      return r.result;
    },
  };
}

test("launch: a profile another browser holds fails at once with an error naming it", async t => {
  const dir = profile(t);
  const first = await launch(dir);
  t.after(() => first.close());
  const t0 = Date.now();
  await assert.rejects(launch(dir), e => {
    assert.equal(e.code, "PROFILE_IN_USE");
    assert.match(e.message, /profile in use by another browser/);
    assert.ok(e.message.includes(dir), e.message);
    return true;
  });
  assert.ok(Date.now() - t0 < 10_000);
});

test("mcp: the server closes an idle browser, and the next call opens it again", async t => {
  const dir = profile(t);
  const s = startServer(t, { JEV_BROWSER_PROFILE: dir, JEV_BROWSER_IDLE_MINUTES: "0.05" });   // 3 s
  await s.init();
  await s.call("browser_open", { url: PAGE });
  await assert.rejects(launch(dir), { code: "PROFILE_IN_USE" });
  await sleep(6000);
  const mine = await launch(dir);   // the server let go of the profile
  await mine.open(PAGE); await mine.close();
  const r = await s.call("browser_open", { url: PAGE });
  assert.match(r.content[0].text, /hello/);
});

test("mcp: the server closes its browser and exits when the client goes away", async t => {
  const dir = profile(t);
  const s = startServer(t, { JEV_BROWSER_PROFILE: dir });
  await s.init();
  await s.call("browser_open", { url: PAGE });
  s.child.stdin.end();
  const code = await Promise.race([s.exited, sleep(10_000).then(() => "still running")]);
  assert.equal(code, 0);
  const mine = await launch(dir);
  await mine.open(PAGE); await mine.close();
});
