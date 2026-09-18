// Offline tests for browser_read: block splitting, batching, ordering, the size gate and the
// "what was dropped" reporting. The Jev call is stubbed everywhere; no network, no key.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { JevBrowser } from "../src/session.mjs";
import { normalizeBlocks, batchBlocks, batchQuestions, pickBlocks, assemble, readResult, formatRead, totalChars, MAX_BLOCK_CHARS } from "../src/prune.mjs";

const sentences = (n, word) => Array.from({ length: n }, (_, k) => `${word} sentence ${k} padding padding padding.`).join(" ");

test("splitting: an oversized block is cut at sentence boundaries, never mid-sentence", () => {
  const text = sentences(120, "alpha");
  assert.ok(text.length > 3 * MAX_BLOCK_CHARS);
  const out = normalizeBlocks([{ text, tag: "p", section: "S" }]);
  assert.ok(out.length >= 3, `expected several blocks, got ${out.length}`);
  for (const b of out) assert.ok(b.text.length <= MAX_BLOCK_CHARS, `block ${b.i} is ${b.text.length} chars`);
  for (const b of out) assert.match(b.text, /\.$/, "every piece ends on a sentence boundary");
  // no content is lost by splitting
  assert.equal(out.map(b => b.text).join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "));
});

test("splitting: a single sentence longer than a block is hard-cut rather than dropped", () => {
  const text = "x".repeat(MAX_BLOCK_CHARS * 2 + 50);
  const out = normalizeBlocks([{ text, tag: "p" }]);
  assert.equal(out.length, 3);
  assert.equal(out.map(b => b.text).join("").length, text.length);
});

test("merging: small blocks in one section merge, headings and section changes start a new one", () => {
  const raw = [
    { text: "Intro", tag: "heading", section: "Intro" },
    { text: "first line", tag: "li", section: "Intro" },
    { text: "second line", tag: "li", section: "Intro" },
    { text: "Details", tag: "heading", section: "Intro > Details" },
    { text: "third line", tag: "li", section: "Intro > Details" },
    { text: "fourth line", tag: "li", section: "Intro > Details" },
  ];
  const out = normalizeBlocks(raw);
  assert.equal(out.length, 2, "one block per section, heading merged with its body");
  assert.deepEqual(out.map(b => b.i), [0, 1], "numbered in document order");
  assert.equal(out[0].section, "Intro");
  assert.equal(out[0].text, "Intro\nfirst line\nsecond line");
  assert.equal(out[1].text, "Details\nthird line\nfourth line");
});

test("merging: blocks stop merging at the size limit and blocks from different frames stay apart", () => {
  const raw = Array.from({ length: 12 }, () => ({ text: "z".repeat(300), tag: "p", section: "S" }));
  const out = normalizeBlocks(raw);
  for (const b of out) assert.ok(b.text.length <= MAX_BLOCK_CHARS);
  assert.equal(totalChars(out) + (out.length - 1) * 0, raw.length * 300 + (12 - out.length));  // newlines added by merging

  const framed = normalizeBlocks([{ text: "a", tag: "p", section: "S" }, { text: "b", tag: "p", section: "S", frame: 1 }]);
  assert.equal(framed.length, 2);
  assert.equal(framed[1].frame, 1);
});

test("batching: order is preserved, every block appears once, caps are respected", () => {
  const blocks = normalizeBlocks(Array.from({ length: 95 }, (_, k) => ({ text: `b${k} ${"y".repeat(900)}`, tag: "p", section: `s${k}` })));
  const batches = batchBlocks(blocks, { maxBlocks: 40, maxChars: 50_000 });
  assert.ok(batches.length >= 3, `expected several batches, got ${batches.length}`);
  for (const bt of batches) {
    assert.ok(bt.length <= 40, "at most maxBlocks questions per request");
    assert.ok(totalChars(bt) <= 50_000 || bt.length === 1, "at most maxChars per request");
  }
  assert.deepEqual(batches.flat().map(b => b.i), blocks.map(b => b.i), "flattened batches are the blocks in document order");
});

test("batching: one noul question per block, named by the block's index", () => {
  const blocks = normalizeBlocks([{ text: "a", tag: "p" }, { text: "b", tag: "p", section: "S" }]);
  const q = batchQuestions(blocks);
  assert.deepEqual(Object.keys(q), ["b0", "b1"]);
  assert.equal(q.b1.type, "noul");
  assert.match(q.b1.instructions, /`i` = 1/);
  assert.match(q.b1.instructions, /`question`/);
});

const four = () => normalizeBlocks([0, 1, 2, 3].map(k => ({ text: `block ${k} ${"w".repeat(200)}`, tag: "p", section: `s${k}` })));

test("picking: low scores are dropped, unscored blocks are kept, order is the document's", () => {
  const blocks = four();
  const { kept, dropped } = pickBlocks(blocks, { 0: 0.9, 1: 0.02, 3: 0.4 }, { dropBelow: 0.35, budgetChars: 100_000 });
  assert.deepEqual(kept.map(b => b.i), [0, 2, 3], "block 2 was never scored and is kept");
  assert.deepEqual(dropped.map(b => b.i), [1]);
  assert.equal(dropped[0].why, "not relevant");
});

test("picking: over budget, the least relevant keepers go first and the rest stay in order", () => {
  const blocks = four();
  const size = blocks[0].text.length;
  const { kept, dropped } = pickBlocks(blocks, { 0: 0.4, 1: 0.99, 2: 0.5, 3: 0.95 }, { dropBelow: 0.35, budgetChars: size * 2 + 1 });
  assert.deepEqual(kept.map(b => b.i), [1, 3], "the two strongest survive, in document order");
  assert.deepEqual(dropped.map(b => b.i), [0, 2]);
  assert.equal(dropped.find(b => b.i === 0).why, "over budget");
  assert.ok(totalChars(kept) <= size * 2 + 1);
});

test("picking: a budget smaller than one block still returns that block rather than nothing", () => {
  const blocks = four();
  const { kept } = pickBlocks(blocks, { 0: 0.9, 1: 0.9, 2: 0.9, 3: 0.9 }, { budgetChars: 10 });
  assert.equal(kept.length, 1);
});

test("assembling: kept text in document order, section headings, an explicit marker per gap", () => {
  const blocks = normalizeBlocks([
    { text: "keep one", tag: "p", section: "A" },
    { text: "toss", tag: "p", section: "B" },
    { text: "toss two", tag: "p", section: "C" },
    { text: "keep two", tag: "p", section: "D" },
  ]);
  const out = assemble(blocks, [blocks[0], blocks[3]]);
  assert.match(out, /## A\n\nkeep one/);
  assert.match(out, /## D\n\nkeep two/);
  assert.doesNotMatch(out, /toss/);
  assert.match(out, /\[… 2 blocks \/ 12 chars dropped …\]/, "the gap is marked in place, never a silent cut");
  assert.ok(out.indexOf("keep one") < out.indexOf("dropped") && out.indexOf("dropped") < out.indexOf("keep two"));
});

test("reporting: readResult counts what was kept and dropped and says how to get the rest", () => {
  const blocks = four();
  const { kept, dropped } = pickBlocks(blocks, { 0: 0.9, 1: 0.01, 2: 0.01, 3: 0.9 }, { dropBelow: 0.35, budgetChars: 100_000 });
  const r = readResult({ url: "u", title: "t", question: "q", blocks, kept, dropped, pruned: true, jevCalls: 1, jevMs: 800 });
  assert.equal(r.blocks, 4);
  assert.equal(r.kept_blocks, 2);
  assert.equal(r.dropped_blocks, 2);
  assert.equal(r.kept_chars + r.dropped_chars, r.total_chars);
  assert.equal(r.jev_calls, 1);
  assert.match(r.note, /browser_snapshot/);
  assert.match(r.content, /dropped/);
});

test("reporting: formatRead puts the accounting in a header above the content", () => {
  const blocks = four();
  const { kept, dropped } = pickBlocks(blocks, { 0: 0.9, 1: 0.01, 2: 0.01, 3: 0.9 }, { dropBelow: 0.35, budgetChars: 100_000 });
  const out = formatRead(readResult({ url: "https://x/y", title: "T", question: "why?", blocks, kept, dropped, pruned: true, jevCalls: 2, jevMs: 900 }));
  const [head, body] = out.split("\n---\n");
  assert.match(head, /^url: https:\/\/x\/y$/m);
  assert.match(head, /question: why\?/);
  assert.match(head, /content: 2 of 4 blocks, \d+ of \d+ chars \(ranked by Jev in 2 call\(s\), 900 ms\)/);
  assert.match(head, /dropped: 2 blocks \/ \d+ chars \(2 not relevant\), marked in place below/);
  assert.match(body, /block 0/);
  assert.doesNotMatch(body, /block 1 /);
});

test("reporting: nothing dropped means no note", () => {
  const blocks = four();
  const r = readResult({ url: "u", title: "t", question: "q", blocks, kept: blocks, dropped: [], pruned: false, reason: "small page" });
  assert.equal(r.note, undefined);
  assert.equal(r.dropped_blocks, 0);
  assert.equal(r.reason, "small page");
});

// --- against a real page, with the Jev call stubbed ---

const SECTION = k => `<h2>Section ${k}</h2><p>${sentences(24, `body${k}`)}</p>`;
const LONG = `<!doctype html><html><head><title>Long article</title></head><body>
<nav>Home About Contact</nav><h1>Long article</h1>
${Array.from({ length: 20 }, (_, k) => SECTION(k)).join("")}
<div style="display:none"><h2>Hidden section</h2><p>${sentences(20, "secret")}</p></div>
<footer>Copyright notice</footer></body></html>`;
const SHORT = `<!doctype html><html><head><title>Small page</title></head><body>
<h1>Small page</h1><p>The cat sat on the mat.</p><p>The dog sat on the log.</p></body></html>`;

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser.close(); });

const open = async html => {
  const b = await JevBrowser.launch({ browser });
  await b.page.setContent(html);
  await b.page.waitForTimeout(100);
  return b;
};

test("extraction reads the whole document, not the viewport, and skips hidden content", async () => {
  const b = await open(LONG);
  const { blocks: raw, title } = await b.extractBlocks();
  const blocks = normalizeBlocks(raw);
  assert.equal(title, "Long article");
  const all = blocks.map(x => x.text).join("\n");
  assert.match(all, /body0 sentence 0/, "text at the top of the document");
  assert.match(all, /body19 sentence 0/, "text far below the fold is included too");
  assert.doesNotMatch(all, /secret/, "display:none content is not readable text");
  // headings become the section path rather than blocks of their own
  assert.ok(blocks.some(x => x.section === "Long article > Section 7"), JSON.stringify(blocks.map(x => x.section).slice(0, 6)));
  assert.ok(totalChars(blocks) > 20_000);
  await b.close();
});

test("gate: a small page is returned whole and never calls Jev", async () => {
  const b = await open(SHORT);
  let called = 0;
  b.call = async () => { called++; throw new Error("Jev must not be called below the threshold"); };
  const r = await b.read("What did the cat do?");
  assert.equal(called, 0);
  assert.equal(r.pruned, false);
  assert.equal(r.dropped_blocks, 0);
  assert.match(r.reason, /threshold for ranking: no Jev call/);
  assert.match(r.content, /cat sat on the mat/);
  assert.match(r.content, /dog sat on the log/);
  assert.equal(r.jev_calls, undefined);
  await b.close();
});

test("gate: a big page is ranked, kept in document order, and reports what it dropped", async () => {
  const b = await open(LONG);
  const asked = [];
  // only sections 3 and 11 help; everything else is clearly irrelevant
  b.call = async (state, questions) => {
    asked.push(Object.keys(questions).length);
    assert.ok(JSON.stringify(state).length < 130_000, "a request must stay well under the token cap");
    const answers = {};
    for (const [name, q] of Object.entries(questions)) {
      assert.equal(q.type, "noul");
      const block = state.page.blocks.find(x => `b${x.i}` === name);
      answers[name] = { noul: /body3 |body11 /.test(block.text) ? 0.95 : 0.03 };
    }
    return { answers, ms: 500, tokens: 1000 };
  };
  const r = await b.read("What do sections 3 and 11 say?");
  assert.equal(r.pruned, true);
  assert.ok(asked.length >= 1);
  assert.equal(asked.reduce((a, n) => a + n, 0), r.blocks, "every block was asked about exactly once");
  assert.match(r.content, /body3 sentence 0/);
  assert.match(r.content, /body11 sentence 0/);
  assert.doesNotMatch(r.content, /body7 sentence/);
  assert.ok(r.content.indexOf("body3 sentence 0") < r.content.indexOf("body11 sentence 0"), "document order");
  assert.ok(r.dropped_blocks > 0 && r.dropped_chars > 0);
  assert.ok(r.dropped_by["not relevant"] > 0);
  assert.equal(r.kept_chars + r.dropped_chars, r.total_chars);
  assert.match(r.content, /\[… \d+ blocks? \/ \d+ chars dropped …\]/);
  assert.match(r.note, /browser_snapshot/);
  assert.equal(r.jev_calls, asked.length);
  await b.close();
});

test("a failed ranking request keeps its blocks rather than losing them", async () => {
  const b = await open(LONG);
  b.call = async () => { throw new Error("Jev 500"); };
  const r = await b.read("Anything at all?");
  assert.equal(r.pruned, true);
  assert.equal(r.dropped_by["not relevant"], undefined, "an unranked block may never be dropped as irrelevant");
  assert.ok(r.dropped_by["over budget"] > 0, "only the character budget may trim it, and that is reported");
  assert.match(r.reason, /could not be ranked and were kept/);
  assert.match(b.events.join("\n"), /browser_read: a ranking request failed/);
  await b.close();
});

test("the character budget is honoured and the overflow is reported, not silently cut", async () => {
  const b = await open(LONG);
  b.call = async (state, questions) => ({ answers: Object.fromEntries(Object.keys(questions).map(n => [n, { noul: 0.9 }])), ms: 1, tokens: 1 });
  const r = await b.read("Everything is relevant", { budgetChars: 4000 });
  assert.ok(r.kept_chars <= 4000, `kept ${r.kept_chars} chars`);
  assert.ok(r.dropped_blocks > 0);
  assert.equal(r.kept_chars + r.dropped_chars, r.total_chars);
  assert.match(r.note, /left out/);
  await b.close();
});
