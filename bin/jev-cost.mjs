#!/usr/bin/env node
// jev-cost — a two-sided token ledger for one page: what the calling LLM pays, and what Jev spends.
//
// Every number here is measured as it happens. Each snapshot is taken again on the page as it
// then is, every tool result is measured as the text it actually is, and the Jev side is the
// API's own `usage.input_tokens`. Nothing is measured once and multiplied — that assumption is
// what made bench/context-cost.mjs an estimate rather than a measurement.
//
//   npm run cost                                        # the built-in cases
//   npm run cost -- --url https://… --goal "Log in"     # any page
//   node bin/jev-cost.mjs --help
//
// A run needs network and TYPESAFE_API_KEY, and costs API credits. The accounting itself is
// pure and is tested offline in test/cost.test.mjs.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JevBrowser } from "../src/session.mjs";
import { formatRead } from "../src/prune.mjs";

// ---------------------------------------------------------------- token counting
// One place, so a real tokenizer can replace it. The repo's convention is chars / 4; it is an
// approximation and every report says so. An exact counter would have to stay optional: the
// default path must not need a network call or a second key.
export const CALLER_TOKEN_NOTE = "caller tokens ≈ chars ÷ 4 (approximate, this repo's convention)";
export const JEV_TOKEN_NOTE = "Jev tokens are the API's own usage.input_tokens (exact)";
export function callerTokens(chars) { return Math.round(chars / 4); }

// ---------------------------------------------------------------- the ledger
// One ledger per scenario. `jev_applicable: false` marks a scenario that by construction spends
// no Jev tokens (the Playwright-MCP baseline): whatever Jev cost we paid to walk the page into
// each state is recorded under `driving` and kept out of the report, because a real
// Playwright-MCP run would spend the caller model's tokens there instead.
export function ledger(id, { group = "", baseline = null, note = "", jevApplicable = true } = {}) {
  return {
    id, group, baseline, note, jev_applicable: jevApplicable,
    caller_chars: 0, calls: [], jev_calls: 0, jev_tokens: 0, jev_ms: 0, ms: 0,
    driving: { calls: 0, tokens: 0, ms: 0 },
  };
}

// One MCP tool call. The caller pays for both directions: the arguments it had to write and the
// result it reads back. Anything that happens behind the boundary is not its cost.
export function charge(led, name, args, resultText) {
  const arg_chars = JSON.stringify({ name, arguments: args ?? {} }).length;
  const result_chars = String(resultText ?? "").length;
  led.caller_chars += arg_chars + result_chars;
  led.calls.push({ name, arg_chars, result_chars });
  return resultText;
}

export function chargeJev(led, { calls = 0, tokens = 0, ms = 0 } = {}) {
  if (led.jev_applicable) { led.jev_calls += calls; led.jev_tokens += tokens; led.jev_ms += ms; }
  else { led.driving.calls += calls; led.driving.tokens += tokens; led.driving.ms += ms; }
  return led;
}

export function finish(led, ms) {
  led.ms = ms;
  led.caller_tokens = callerTokens(led.caller_chars);
  led.seconds = +(ms / 1000).toFixed(2);
  return led;
}

// ---------------------------------------------------------------- comparison
// Each row names the row it is measured against. Losses stay negative on purpose: an instrument
// that can only produce favourable numbers is not an instrument.
//   caller_saved = baseline's caller tokens − this row's
//   net          = caller_saved − Jev tokens this row spent
// `net` counts a caller token and a Jev token as one each. They are not worth the same (that is
// the whole point of moving work to the cheap model), so `net` is the pessimistic reading: a
// scenario that is positive here is a win on any pricing.
export function compare(rows) {
  const by = new Map(rows.map(r => [r.id, r]));
  for (const r of rows) {
    const b = r.baseline ? by.get(r.baseline) : null;
    if (!b) { r.ratio = null; r.caller_saved = null; r.net = null; continue; }
    r.ratio = r.caller_tokens > 0 ? +(b.caller_tokens / r.caller_tokens).toFixed(2) : null;
    r.caller_saved = b.caller_tokens - r.caller_tokens;
    r.net = r.caller_saved - (r.jev_applicable ? r.jev_tokens : 0);
  }
  return rows;
}

export function totals(rows, { baseline = null } = {}) {
  const jev = k => rows.reduce((a, r) => a + (r.jev_applicable ? r[k] : 0), 0);
  const t = {
    caller_tokens: rows.reduce((a, r) => a + r.caller_tokens, 0),
    jev_tokens: jev("jev_tokens"),
    jev_calls: jev("jev_calls"),
    seconds: +(rows.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(2),
    ratio: null, net: null,
  };
  // The headline ratio only means something where a Playwright-MCP baseline exists: the `act`
  // group, on the same page and the same goal.
  const base = rows.find(r => r.id === baseline);
  if (base) {
    const act = rows.filter(r => r.group === "act" && r.id !== baseline);
    const sum = act.reduce((a, r) => a + r.caller_tokens, 0);
    if (act.length && sum > 0) {
      t.ratio = +(base.caller_tokens / sum).toFixed(2);
      t.net = (base.caller_tokens - sum) - act.reduce((a, r) => a + (r.jev_applicable ? r.jev_tokens : 0), 0);
    }
  }
  return t;
}

// ---------------------------------------------------------------- formatting
const num = n => n == null ? "—" : n.toLocaleString("en-US");
// Two decimals below 10×, one below 100×, none above: past that the digits are noise, and a
// four-figure ratio still has to fit the column.
const ratioStr = r => r == null ? "—" : `${r >= 100 ? Math.round(r).toLocaleString("en-US") : r.toFixed(r >= 10 ? 1 : 2)}×`;
const pad = (s, n) => String(s).padStart(n);
const padEnd = (s, n) => String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s).padEnd(n);
const W = { group: 8, scenario: 40, caller: 11, jev: 9, calls: 6, secs: 7, ratio: 10, net: 11 };

export function formatRows(rows, t) {
  const head = padEnd("group", W.group) + padEnd("scenario", W.scenario) + pad("caller tok", W.caller)
    + pad("jev tok", W.jev) + pad("calls", W.calls) + pad("s", W.secs) + pad("vs base", W.ratio) + pad("net", W.net);
  const lines = [head, "-".repeat(head.length)];
  for (const r of rows) {
    lines.push(
      padEnd(r.group, W.group) + padEnd(r.id + (r.baseline === r.id ? " (baseline)" : ""), W.scenario)
      + pad(num(r.caller_tokens), W.caller)
      + pad(r.jev_applicable ? num(r.jev_tokens) : "—", W.jev)
      + pad(r.jev_applicable ? num(r.jev_calls) : "—", W.calls)
      + pad(r.seconds.toFixed(2), W.secs)
      + pad(ratioStr(r.ratio), W.ratio)
      + pad(num(r.net), W.net));
  }
  lines.push("-".repeat(head.length));
  lines.push(padEnd("TOTAL", W.group + W.scenario) + pad(num(t.caller_tokens), W.caller)
    + pad(num(t.jev_tokens), W.jev) + pad(num(t.jev_calls), W.calls) + pad(t.seconds.toFixed(2), W.secs)
    + pad(ratioStr(t.ratio), W.ratio) + pad(num(t.net), W.net));
  return lines.join("\n");
}

export function formatCase(c) {
  const out = [`\n══ ${c.id} ══ ${c.url}`];
  const meta = [c.goal ? `goal: ${JSON.stringify(c.goal)}` : null, c.question ? `question: ${JSON.stringify(c.question)}` : null,
    c.filter ? `snapshot filter: ${JSON.stringify(c.filter)}` : null].filter(Boolean);
  if (meta.length) out.push("   " + meta.join("   "));
  out.push("");
  out.push(formatRows(c.rows, c.totals));
  const notes = c.rows.filter(r => r.note).map(r => `  * ${r.id}: ${r.note}`);
  if (notes.length) out.push("", ...notes);
  // A loss is the interesting case, so it is said in words and not left in a column.
  const losses = c.rows.filter(r => r.net != null && r.net < 0).sort((a, b) => a.net - b.net);
  if (losses.length) out.push("", `  LOSS on this page: ${losses.map(r => `${r.id} (${num(r.net)} tokens)`).join(", ")}`);
  return out.join("\n");
}

// ---------------------------------------------------------------- the MCP boundary
// The caller's cost is the text that crosses bin/jev-browser-mcp.mjs. Everything below repeats
// that file's shaping so the count is of real result text, not of an internal object.
// browser_snapshot and browser_read already return a shared function's output (snapshotText,
// formatRead), so only browser_open's and browser_do's wrappers are duplicated here — keep
// these two in step with the server; they are the only place the shapes are written twice.
const mcpText = obj => typeof obj === "string" ? obj : JSON.stringify(obj, null, 1);

function openResult(r, page) { return mcpText({ ...r, elements: page.elements.length, visible_text: page.text.slice(0, 400) }); }

function doResult(r) {
  const actions = r.actions.map(h => h.event ? `(event) ${h.event}` : `${h.action}${h.key ? ` ${h.key}` : ""} ${h.element ?? ""}${h.value ? ` <- values.${h.value}` : ""}${h.option ? ` <- "${h.option}"` : ""}${h.destination ? ` -> ${h.destination}` : ""}${h.error ? `  ERROR: ${h.error}` : ""}`.trim());
  const out = { status: r.status, url: r.url, title: r.title, actions, done_score: r.done_score, jev_calls: r.jev_calls, ms: r.ms };
  for (const k of ["info", "pending", "page_text", "candidates"]) if (r[k]) out[k] = r[k];
  return mcpText(out);
}

// Run `fn` and hand back both its value and the Jev spend it caused, read off the session's own
// counters (src/session.mjs keeps calls / jev_ms / tokens; tokens is usage.input_tokens).
async function measure(b, fn) {
  const t0 = Date.now(), s0 = { ...b.stats };
  const value = await fn();
  return { value, ms: Date.now() - t0, jev: { calls: b.stats.calls - s0.calls, tokens: b.stats.tokens - s0.tokens, ms: b.stats.jev_ms - s0.jev_ms } };
}

// ---------------------------------------------------------------- scenarios
// Playwright MCP returns a fresh AI aria snapshot with every navigation and every action. This
// walks the same page toward the same goal one action at a time and takes a real, differently
// sized snapshot after each one — the reuse of a single start-page snapshot is exactly the
// assumption this tool exists to remove.
const PW_TOOL = { click: "browser_click", type: "browser_type", press_enter: "browser_press_key", press_key: "browser_press_key", select: "browser_select_option", hover: "browser_hover", right_click: "browser_click", drag: "browser_drag", upload: "browser_file_upload", scroll: "browser_scroll", back: "browser_navigate_back" };

async function baselineScenario({ url, goal, values, maxActions, headed }) {
  const led = ledger("playwright-mcp", {
    group: "act", baseline: "playwright-mcp", jevApplicable: false,
    note: "one real page.ariaSnapshot({mode:\"ai\"}) per navigation and per action, each measured on the page as it then was. Jev columns are '—' because a Playwright-MCP run has no cheap model; the Jev calls used here only walked the page into each state. Seconds are the measured snapshot time only — a real run also pays the caller model's own latency, which this cannot measure.",
  });
  const b = await JevBrowser.launch({ headed });
  const t0 = Date.now();
  let snapMs = 0, refs = 0;
  const snap = async () => { const t = Date.now(); const s = await b.page.ariaSnapshot({ mode: "ai" }); snapMs += Date.now() - t; return s; };
  try {
    const { jev } = await measure(b, () => b.open(url));
    chargeJev(led, jev);
    charge(led, "browser_navigate", { url }, await snap());
    let acted = 0;
    while (acted < maxActions) {
      const step = await measure(b, () => b.do(goal, { values, maxActions: 1 }));
      chargeJev(led, step.jev);
      const done = step.value.actions.filter(h => h.action && h.action !== "wait");
      for (const h of done) {
        acted++;
        // Playwright MCP's own call arguments: a human-readable element description plus a ref.
        // Modelled, not measured — it is a handful of tokens next to the snapshot that follows.
        const args = { element: h.element ?? "", ref: `e${++refs}`, ...(h.value ? { text: h.value } : {}), ...(h.key ? { key: h.key } : {}) };
        charge(led, PW_TOOL[h.action] ?? "browser_click", args, await snap());
      }
      if (!done.length || step.value.status !== "max_actions") break;
    }
    led.actions = acted;
    led.status = acted ? "walked" : "no actions";
  } finally { await b.close(); }
  finish(led, snapMs);          // see the note: only the snapshot time is this baseline's own
  led.wall_ms = Date.now() - t0;
  led.note = `${led.actions} action(s) -> ${led.calls.length} aria snapshots, ${led.note} Walking the page to those states cost ${led.driving.calls} Jev calls / ${led.driving.tokens.toLocaleString("en-US")} tokens, which are excluded above.`;
  return led;
}

// Everything that goes through the jev-browser tools, in one session on the same page, in the
// order a caller would use them: look, read, act, look again.
async function jevScenarios(c, { maxActions, headed }) {
  const rows = [];
  const b = await JevBrowser.launch({ headed });
  const row = async (id, opts, fn) => {
    const led = ledger(id, opts);
    const { ms, jev } = await measure(b, () => fn(led));
    chargeJev(led, jev);
    rows.push(finish(led, ms));
    return led;
  };
  try {
    await row("browser_open", { group: "open" }, async led => {
      const r = await b.open(c.url);
      charge(led, "browser_open", { url: c.url }, openResult(r, await b.snapshot()));
    });

    // The MCP server maps each browser_snapshot argument onto one snapshotText option; the same
    // mapping is repeated here so the measured text is the text the caller would have received.
    const snapRow = (id, args, opts = {}) => row(id, { group: "observe", baseline: "browser_snapshot", ...opts },
      async led => charge(led, "browser_snapshot", args, await b.snapshotText({
        diff: !!args.diff, interactive: !!args.interactive, filter: args.filter ?? "", urls: !!args.urls, maxChars: args.max_chars,
      })));
    await snapRow("browser_snapshot", {});
    await snapRow("browser_snapshot --interactive", { interactive: true });
    if (c.filter) await snapRow("browser_snapshot --filter", { filter: c.filter });
    await snapRow("browser_snapshot --urls", { urls: true });
    await snapRow("browser_snapshot --max-chars 2000", { max_chars: 2000 });

    if (c.question) {
      // The whole document, no ranking: what it costs the caller to get the answer by reading
      // everything. read() skips the Jev call whenever the page already fits the budget, so a
      // 200k budget is a plain dump through the same boundary.
      await row("browser_read (whole doc)", { group: "read", baseline: "browser_read (whole doc)", note: "browser_read with max_chars 200000: the page's full text, no ranking and no Jev call — the cost of answering by reading everything." },
        async led => charge(led, "browser_read", { question: c.question, max_chars: 200_000 }, formatRead(await b.read(c.question, { budgetChars: 200_000 }))));
      await row("browser_read (ranked)", { group: "read", baseline: "browser_read (whole doc)", note: "browser_read at its default 12000-char budget. Pages at or under the budget are returned whole with no Jev call, so on a short page this is the same text at the same price." },
        async led => charge(led, "browser_read", { question: c.question }, formatRead(await b.read(c.question))));
    }

    if (c.goal) {
      await row("browser_do", { group: "act", baseline: "playwright-mcp" }, async led => {
        const r = await b.do(c.goal, { values: c.values ?? {}, maxActions });
        led.status = r.status; led.actions = r.actions.filter(h => h.action).length;
        charge(led, "browser_do", { goal: c.goal, ...(Object.keys(c.values ?? {}).length ? { values: c.values } : {}), max_actions: maxActions }, doResult(r));
      });
      // `diff` needs one action between two snapshots; a scroll is the one action that takes no
      // decision model, so the diff below is the diff's cost and nothing else's.
      await row("browser_snapshot (after action)", { group: "observe", baseline: "browser_snapshot (after action)" },
        async led => charge(led, "browser_snapshot", {}, await b.snapshotText({ filter: "" })));
      await row("browser_act scroll", { group: "observe", note: "the one action between the two snapshots above and below, so `--diff` has something to report. No decision model is involved." },
        async led => charge(led, "browser_act", { action: "scroll" }, mcpText(await b.actOn({ action: "scroll" }))));
      await row("browser_snapshot --diff", { group: "observe", baseline: "browser_snapshot (after action)", note: "measured after that scroll. What a diff saves depends entirely on how much the preceding action changed; this is one page's answer, not a general one." },
        async led => charge(led, "browser_snapshot", { diff: true }, await b.snapshotText({ diff: true, filter: "" })));
    }
  } finally { await b.close(); }
  return rows;
}

async function runCase(c, opts) {
  const rows = [];
  if (c.goal) rows.push(await baselineScenario({ ...c, ...opts }));
  rows.push(...await jevScenarios(c, opts));
  compare(rows);
  return { ...c, rows, totals: totals(rows, { baseline: "playwright-mcp" }) };
}

// ---------------------------------------------------------------- cases
// Deliberately two: one small page where Jev's spend and latency can outweigh the saving, and
// one large page where they should not. Every run costs API credits.
export const CASES = [
  {
    id: "saucedemo", url: "https://www.saucedemo.com/",
    goal: "Log in", values: { username: "standard_user", password: "secret_sauce" },
    question: "Which usernames can be used to log in, and what is the password?",
    filter: "user",
  },
  {
    id: "wikipedia", url: "https://en.wikipedia.org/wiki/Alan_Turing",
    goal: "Open the linked article about Bletchley Park",
    question: "What did Alan Turing do at Bletchley Park during the Second World War?",
    filter: "Bletchley",
  },
];

// ---------------------------------------------------------------- CLI
const HELP = `jev-cost — measure what the calling LLM pays and what Jev spends, on one page.

  npm run cost                                         run the built-in cases
  npm run cost -- --url <url> --goal "<goal>"          run against any page
  node bin/jev-cost.mjs --url <url> --question "<q>"

Everything is measured as it happens; nothing is measured once and multiplied. Caller tokens are
the text crossing the MCP boundary (tool results plus the arguments the caller had to write);
${CALLER_TOKEN_NOTE}. ${JEV_TOKEN_NOTE}.

  --url <url>            page to measure. Without it, the built-in cases run.
  --goal "<goal>"        browser_do goal. Without it, the act group and the diff are skipped.
  --value k=v            a named string browser_do may type (repeatable), e.g. --value password=hunter2
  --question "<q>"       browser_read question. Default: "What is this page about?"
  --filter <text>        substring for browser_snapshot --filter. Default: the longest word of the goal.
  --case <id,...>        built-in cases to run: ${CASES.map(c => c.id).join(", ")}. Default: all.
  --max-actions <n>      browser_do action budget per scenario. Default 10.
  --headed               run Chromium headed.
  --json                 machine-readable output instead of the table.
  --report <file>        re-print the table from an earlier --json run instead of running anything.
  --help                 this text.

Columns: caller tok = tokens the expensive model pays. jev tok / calls = the cheap model's own
usage.input_tokens and request count. s = wall clock. vs base = caller tokens of the row this one
is measured against, divided by this row's. net = caller tokens saved minus Jev tokens spent, one
for one; it goes negative when a scenario loses, and it is printed as a loss.

Needs network and TYPESAFE_API_KEY; a run costs API credits.`;

export function parseArgs(argv) {
  const o = { values: {}, maxActions: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--json") o.json = true;
    else if (a === "--report") o.report = next();
    else if (a === "--headed") o.headed = true;
    else if (a === "--url") o.url = next();
    else if (a === "--goal") o.goal = next();
    else if (a === "--question") o.question = next();
    else if (a === "--filter") o.filter = next();
    else if (a === "--case") o.cases = next().split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--max-actions") o.maxActions = +next();
    else if (a === "--value") { const [k, ...v] = next().split("="); o.values[k] = v.join("="); }
    else throw new Error(`unknown flag: ${a}  (try --help)`);
  }
  return o;
}

// The default filter has to come from somewhere; the goal's longest word is the substring a
// caller narrowing a snapshot would most likely reach for, and the report prints what it used.
export function defaultFilter(goal) {
  const words = String(goal ?? "").split(/[^A-Za-z0-9]+/).filter(w => w.length > 3);
  return words.sort((a, b) => b.length - a.length)[0] ?? "";
}

export function casesFor(o) {
  if (o.url) return [{
    id: "cli", url: o.url, goal: o.goal, values: o.values,
    question: o.question ?? "What is this page about?",
    filter: o.filter ?? defaultFilter(o.goal),
  }];
  const wanted = o.cases ? CASES.filter(c => o.cases.includes(c.id)) : CASES;
  if (!wanted.length) throw new Error(`no such case: ${o.cases.join(", ")}`);
  return wanted.map(c => ({ ...c, ...(o.filter ? { filter: o.filter } : {}) }));
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) { console.log(HELP); return; }
  // Re-printing a saved run costs nothing and takes no credits, so a report and the JSON behind
  // it can be published from one run instead of two that would not quite agree.
  if (o.report) { report(JSON.parse(readFileSync(o.report, "utf8"))); return; }
  const opts = { maxActions: o.maxActions, headed: !!o.headed };
  const done = [];
  for (const c of casesFor(o)) {
    if (!o.json) console.error(`running ${c.id} (${c.url}) …`);
    done.push(await runCase(c, opts));
  }
  const out = { generated_at: new Date().toISOString(), caller_token_note: CALLER_TOKEN_NOTE, jev_token_note: JEV_TOKEN_NOTE, cases: done };
  if (o.json) console.log(JSON.stringify(out, null, 1));
  else report(out);
}

export function report({ caller_token_note = CALLER_TOKEN_NOTE, jev_token_note = JEV_TOKEN_NOTE, cases = [] }) {
  console.log(`jev-cost — measured, not estimated.\n${caller_token_note}; ${jev_token_note}.`);
  for (const c of cases) console.log(formatCase(c));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main(process.argv.slice(2)).catch(e => { console.error(String(e?.message ?? e)); process.exit(1); });
}
