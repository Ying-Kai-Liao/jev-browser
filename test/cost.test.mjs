// Offline tests for the jev-cost ledger: what each side is charged, how a scenario is compared
// with its baseline, that a loss stays a loss, and how the report renders. No network, no key,
// no browser — every scenario here is a hand-built ledger.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callerTokens, ledger, charge, chargeJev, finish, compare, totals,
  formatRows, formatCase, parseArgs, defaultFilter, casesFor, CASES,
} from "../bin/jev-cost.mjs";

// A scenario, built the way a run builds one: charge the caller, charge Jev, close the ledger.
function row(id, { group = "act", baseline = null, callerChars = 0, jev = {}, ms = 0, jevApplicable = true, note = "" } = {}) {
  const led = ledger(id, { group, baseline, jevApplicable, note });
  if (callerChars) charge(led, "t", {}, "x".repeat(callerChars - JSON.stringify({ name: "t", arguments: {} }).length));
  chargeJev(led, jev);
  return finish(led, ms);
}

test("token conversion is chars / 4, rounded, and lives in one function", () => {
  assert.equal(callerTokens(0), 0);
  assert.equal(callerTokens(4), 1);
  assert.equal(callerTokens(6), 2);          // 1.5 rounds to 2
  assert.equal(callerTokens(40_000), 10_000);
});

test("the caller is charged for both directions of every tool call", () => {
  const led = ledger("s");
  charge(led, "browser_snapshot", { filter: "user" }, "a".repeat(100));
  charge(led, "browser_do", { goal: "Log in" }, "b".repeat(50));
  const argChars = JSON.stringify({ name: "browser_snapshot", arguments: { filter: "user" } }).length
    + JSON.stringify({ name: "browser_do", arguments: { goal: "Log in" } }).length;
  assert.equal(led.caller_chars, argChars + 150, "arguments the caller wrote count as well as the results it read");
  assert.equal(led.calls.length, 2);
  assert.equal(led.calls[0].result_chars, 100);
  assert.ok(led.calls[0].arg_chars > 0, "an empty-looking call still costs the caller its arguments");
  finish(led, 1000);
  assert.equal(led.caller_tokens, callerTokens(led.caller_chars));
  assert.equal(led.seconds, 1);
});

test("Jev's side accumulates calls, tokens and ms", () => {
  const led = ledger("s");
  chargeJev(led, { calls: 1, tokens: 900, ms: 700 });
  chargeJev(led, { calls: 2, tokens: 1_100, ms: 800 });
  assert.deepEqual([led.jev_calls, led.jev_tokens, led.jev_ms], [3, 2_000, 1_500]);
});

test("a scenario that by construction has no Jev side keeps its driving cost out of the ledger", () => {
  const led = ledger("playwright-mcp", { jevApplicable: false });
  chargeJev(led, { calls: 6, tokens: 40_000, ms: 4_000 });
  assert.deepEqual([led.jev_calls, led.jev_tokens], [0, 0], "the baseline reports no Jev spend");
  assert.deepEqual(led.driving, { calls: 6, tokens: 40_000, ms: 4_000 }, "what it cost to walk the page is kept, not thrown away");
});

test("compare: each row is measured against the row it names", () => {
  const rows = [
    row("playwright-mcp", { baseline: "playwright-mcp", callerChars: 40_000, jevApplicable: false }),
    row("browser_do", { baseline: "playwright-mcp", callerChars: 4_000, jev: { calls: 4, tokens: 3_000 } }),
  ];
  compare(rows);
  const [base, jb] = rows;
  assert.equal(base.ratio, 1, "a row that is its own baseline is 1.00×");
  assert.equal(base.caller_saved, 0);
  assert.equal(jb.ratio, 10, "10,000 caller tokens against 1,000");
  assert.equal(jb.caller_saved, 9_000);
  assert.equal(jb.net, 6_000, "9,000 caller tokens saved less the 3,000 Jev spent");
});

test("compare: a row with no baseline is not given one", () => {
  const rows = [row("browser_act scroll", { group: "observe", callerChars: 400 })];
  compare(rows);
  assert.deepEqual([rows[0].ratio, rows[0].caller_saved, rows[0].net], [null, null, null]);
});

test("a loss is reported as a loss: net stays negative and is never clamped", () => {
  // The small-page case: the baseline snapshot is cheap, so Jev's spend outweighs the saving.
  const rows = [
    row("playwright-mcp", { baseline: "playwright-mcp", callerChars: 4_000, jevApplicable: false }),
    row("browser_do", { baseline: "playwright-mcp", callerChars: 2_000, jev: { calls: 4, tokens: 12_000 } }),
  ];
  compare(rows);
  assert.equal(rows[1].caller_saved, 500, "it does save the caller tokens");
  assert.equal(rows[1].net, -11_500, "and still loses overall");
  const t = totals(rows, { baseline: "playwright-mcp" });
  assert.equal(t.net, -11_500);
  assert.equal(t.ratio, 2, "the caller-token ratio can look good while the net is a loss");
  const out = formatCase({ id: "small", url: "https://example.com/", rows, totals: t });
  assert.match(out, /-11,500/, "the losing number is printed, not hidden");
  assert.match(out, /LOSS on this page: browser_do/, "and it is said in words");
});

test("a scenario whose caller cost is worse than its baseline shows a ratio below 1", () => {
  const rows = [
    row("playwright-mcp", { baseline: "playwright-mcp", callerChars: 2_000, jevApplicable: false }),
    row("browser_do", { baseline: "playwright-mcp", callerChars: 8_000, jev: { calls: 2, tokens: 500 } }),
  ];
  compare(rows);
  assert.equal(rows[1].ratio, 0.25);
  assert.equal(rows[1].caller_saved, -1_500, "spending more than the baseline is a negative saving");
  assert.equal(rows[1].net, -2_000);
});

test("totals: sums every row, and counts Jev only where a Jev side exists", () => {
  const rows = [
    row("playwright-mcp", { baseline: "playwright-mcp", callerChars: 40_000, jevApplicable: false, jev: { calls: 9, tokens: 90_000 }, ms: 2_000 }),
    row("browser_do", { baseline: "playwright-mcp", callerChars: 4_000, jev: { calls: 4, tokens: 3_000 }, ms: 11_000 }),
    row("browser_snapshot", { group: "observe", baseline: "browser_snapshot", callerChars: 8_000, ms: 1_000 }),
  ];
  compare(rows);
  const t = totals(rows, { baseline: "playwright-mcp" });
  assert.equal(t.caller_tokens, callerTokens(40_000) + callerTokens(4_000) + callerTokens(8_000));
  assert.equal(t.jev_tokens, 3_000, "the baseline's driving cost is not counted");
  assert.equal(t.jev_calls, 4);
  assert.equal(t.seconds, 14);   // 2 s + 11 s + 1 s
  assert.equal(t.ratio, 10, "the headline ratio is over the act group, where a baseline exists");
});

test("totals: with no Playwright-MCP baseline there is no headline ratio rather than a made-up one", () => {
  const rows = [row("browser_snapshot", { group: "observe", baseline: "browser_snapshot", callerChars: 8_000 })];
  compare(rows);
  const t = totals(rows, { baseline: "playwright-mcp" });
  assert.equal(t.ratio, null);
  assert.equal(t.net, null);
  assert.match(formatRows(rows, t), /—/, "an unmeasurable column is an em dash, not a zero");
});

test("formatting: the baseline's Jev columns are em dashes and the totals row is present", () => {
  const rows = [
    row("playwright-mcp", { baseline: "playwright-mcp", callerChars: 40_000, jevApplicable: false, ms: 1_400 }),
    row("browser_do", { baseline: "playwright-mcp", callerChars: 4_000, jev: { calls: 4, tokens: 3_000 }, ms: 11_200 }),
  ];
  compare(rows);
  const out = formatRows(rows, totals(rows, { baseline: "playwright-mcp" }));
  const [, , base, jb, , total] = out.split("\n");
  assert.match(base, /playwright-mcp \(baseline\)/);
  assert.equal((base.match(/—/g) ?? []).length, 2, "jev tok and jev calls are not applicable to the baseline");
  assert.match(base, /1\.00×/, "the baseline is the reference: 1.00× and a net of 0");
  assert.match(base, /10,000/, "40,000 chars of aria snapshots");
  assert.match(jb, /1,000/);
  assert.match(jb, /3,000/, "the Jev side is on the same line as the caller side: one ledger, two columns");
  assert.match(jb, /11\.20/, "seconds are printed to 2 decimals: a 40 ms snapshot is a real cost, not a 0.0");
  assert.match(total, /^TOTAL/);
  assert.match(total, /12\.60/, "seconds add up across scenarios");
});

test("formatting: a four-figure ratio still fits its column and drops its noise digits", () => {
  const rows = [
    row("playwright-mcp", { baseline: "playwright-mcp", callerChars: 1_000_000, jevApplicable: false }),
    row("browser_do", { baseline: "playwright-mcp", callerChars: 400, jev: { calls: 4, tokens: 40_000 } }),
    row("mid", { baseline: "playwright-mcp", callerChars: 40_000 }),
  ];
  compare(rows);
  const out = formatRows(rows, totals(rows, { baseline: "playwright-mcp" })).split("\n");
  assert.ok(rows[1].ratio > 1000 && rows[2].ratio > 10 && rows[2].ratio < 100, "the fixture spans both rules");
  assert.match(out[3], /\s2,\d{3}×/, "no decimals above 100×");
  assert.match(out[4], /\s2\d\.\d×/, "one decimal between 10× and 100×");
  const width = out[0].length;
  for (const l of out) assert.equal(l.length, width, `every line is ${width} chars: nothing overflows its column`);
});

test("formatting: notes are printed under the table they qualify", () => {
  const rows = [row("browser_snapshot --diff", { group: "observe", callerChars: 100, note: "measured after one scroll" })];
  compare(rows);
  const out = formatCase({ id: "c", url: "https://example.com/", goal: "Log in", question: "q", filter: "user", rows, totals: totals(rows, {}) });
  assert.match(out, /\* browser_snapshot --diff: measured after one scroll/);
  assert.match(out, /goal: "Log in"/, "the report says what it ran, so the numbers can be reproduced");
  assert.match(out, /snapshot filter: "user"/);
});

test("arguments: flags, repeatable values, and an unknown flag is refused", () => {
  const o = parseArgs(["--url", "https://x/", "--goal", "Log in", "--value", "user=ada", "--value", "pw=a=b", "--json", "--max-actions", "3"]);
  assert.equal(o.url, "https://x/");
  assert.equal(o.goal, "Log in");
  assert.deepEqual(o.values, { user: "ada", pw: "a=b" });
  assert.equal(o.json, true);
  assert.equal(o.maxActions, 3);
  assert.throws(() => parseArgs(["--nope"]), /unknown flag/);
});

test("the default snapshot filter comes from the goal, and is empty when there is no goal", () => {
  assert.equal(defaultFilter("Open the linked article about Bletchley Park"), "Bletchley");
  assert.equal(defaultFilter("Log in"), "");
  assert.equal(defaultFilter(undefined), "");
});

test("a URL on the command line is enough; no bench run is needed", () => {
  const cs = casesFor(parseArgs(["--url", "https://example.com/"]));
  assert.equal(cs.length, 1);
  assert.equal(cs[0].url, "https://example.com/");
  assert.equal(cs[0].goal, undefined, "without a goal the act group is simply skipped");
  assert.ok(cs[0].question, "a read question is defaulted so the read group still runs");
});

test("the built-in set includes a small page, so a loss is visible by default", () => {
  assert.ok(CASES.some(c => c.id === "saucedemo"));
  assert.deepEqual(casesFor(parseArgs(["--case", "saucedemo"])).map(c => c.id), ["saucedemo"]);
  assert.throws(() => casesFor(parseArgs(["--case", "nope"])), /no such case/);
  for (const c of CASES) assert.ok(c.url && c.question, `${c.id} needs a url and a read question`);
});
