// Content pruning for `browser_read`: code splits the page into blocks, Jev rates each one,
// code reassembles the ones that help. Everything here is pure — no browser, no network — so
// the splitting, batching, ordering, gating and drop reporting are testable offline.
//
// Why blocks and not the snapshot: `browser_snapshot` is already bounded (400 elements, a
// 2,500-char viewport text), so there is nothing worth pruning there. What it cannot give the
// caller is the rest of the document — a long Wikipedia article is ~179k chars of text of which
// the snapshot shows ~2.4k. That full text is what this module ranks. See NOTES.md, round 4.

export const MAX_BLOCK_CHARS = 1200;   // target size of one judgeable block
export const MIN_PRUNE_CHARS = 8000;   // below this, return everything and never call Jev
export const BUDGET_CHARS = 12_000;    // default character budget for what comes back
export const BATCH_BLOCKS = 40;        // blocks (= noul questions) per Jev request
export const BATCH_CHARS = 50_000;     // state chars per request; the API caps at 32,768 tokens
export const DROP_BELOW = 0.35;        // bias to keep: drop only when Jev is fairly sure it doesn't help

const SENTENCE = /(?<=[.!?。！？])\s+|\n+/;

// Cut one oversized block at sentence or line boundaries. A block split mid-sentence is a block
// Jev cannot judge, so only fall back to a hard cut when a single sentence is itself too long.
function splitLong(text, maxBlock) {
  if (text.length <= maxBlock) return [text];
  const out = [];
  let cur = "";
  for (const piece of text.split(SENTENCE)) {
    const part = piece.trim();
    if (!part) continue;
    if (part.length > maxBlock) {
      if (cur) { out.push(cur); cur = ""; }
      for (let k = 0; k < part.length; k += maxBlock) out.push(part.slice(k, k + maxBlock));
      continue;
    }
    if (cur && cur.length + part.length + 1 > maxBlock) { out.push(cur); cur = ""; }
    cur = cur ? `${cur} ${part}` : part;
  }
  if (cur) out.push(cur);
  return out;
}

// Raw blocks from EXTRACT_BLOCKS -> blocks worth asking about: oversized leaves split, runs of
// small ones (list items, table rows, a heading and its first paragraphs) merged while they
// share a section, each numbered in document order.
export function normalizeBlocks(raw, { maxBlock = MAX_BLOCK_CHARS } = {}) {
  const parts = [];
  for (const b of raw) {
    const text = (b.text ?? "").trim();
    if (!text) continue;
    for (const t of splitLong(text, maxBlock)) parts.push({ ...b, text: t });
  }
  const out = [];
  let cur = null;
  for (const p of parts) {
    const same = cur && cur.section === p.section && cur.frame === p.frame;
    // a heading opens a new group so it is never ranked on its own, without its section body
    const fits = same && cur.text.length + p.text.length + 1 <= maxBlock && p.tag !== "heading";
    if (fits) { cur.text += `\n${p.text}`; continue; }
    cur = { i: out.length, text: p.text, ...(p.section ? { section: p.section } : {}), ...(p.frame ? { frame: p.frame } : {}) };
    out.push(cur);
  }
  return out;
}

export const totalChars = blocks => blocks.reduce((a, b) => a + b.text.length, 0);

// Group blocks into Jev requests. Asking about many blocks in one request is far cheaper than
// one request per block, so batches are as large as the token cap and the question count allow.
export function batchBlocks(blocks, { maxBlocks = BATCH_BLOCKS, maxChars = BATCH_CHARS } = {}) {
  const out = [];
  let cur = [], chars = 0;
  for (const b of blocks) {
    if (cur.length && (cur.length >= maxBlocks || chars + b.text.length > maxChars)) { out.push(cur); cur = []; chars = 0; }
    cur.push(b); chars += b.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

// One noul per block in the batch: does this block help answer the question?
export function batchQuestions(batch) {
  const q = {};
  for (const b of batch) q[`b${b.i}`] = { type: "noul", instructions: `Does the entry of \`page.blocks\` with \`i\` = ${b.i} contain information that helps answer \`question\`?` };
  return q;
}

// Decide what comes back. `scores` maps block index -> P(helps); a missing score means the block
// was never judged (batch failed, or the gate skipped Jev) and is kept — a wrongly dropped block
// is invisible to the caller, the same class of failure as a false `done`.
export function pickBlocks(blocks, scores, { dropBelow = DROP_BELOW, budgetChars = BUDGET_CHARS } = {}) {
  const score = b => (scores instanceof Map ? scores.get(b.i) : scores?.[b.i]);
  const kept = [], dropped = [];
  for (const b of blocks) {
    const p = score(b);
    if (p === undefined || p === null || p >= dropBelow) kept.push(b); else dropped.push({ ...b, why: "not relevant" });
  }
  // Over budget: give up the least relevant of the keepers first, never a tail truncation.
  if (totalChars(kept) > budgetChars) {
    const rank = [...kept].sort((x, y) => (score(y) ?? 1) - (score(x) ?? 1) || x.i - y.i);
    const room = new Set();
    let used = 0;
    for (const b of rank) {
      if (used + b.text.length > budgetChars && room.size) continue;
      room.add(b.i); used += b.text.length;
    }
    for (const b of kept) if (!room.has(b.i)) dropped.push({ ...b, why: "over budget" });
    kept.length = 0;
    for (const b of blocks) if (room.has(b.i)) kept.push(b);
    dropped.sort((x, y) => x.i - y.i);
  }
  return { kept, dropped };
}

// Kept blocks in document order, with their section heading, and an explicit marker wherever
// something was left out. The caller must never have to guess that content is missing.
export function assemble(blocks, kept) {
  const keep = new Set(kept.map(b => b.i));
  const lines = [];
  let section, gap = 0, gapChars = 0;
  const flush = () => {
    if (!gap) return;
    lines.push(`[… ${gap} block${gap === 1 ? "" : "s"} / ${gapChars} chars dropped …]`);
    gap = 0; gapChars = 0;
  };
  for (const b of blocks) {
    if (!keep.has(b.i)) { gap++; gapChars += b.text.length; continue; }
    flush();
    if (b.section && b.section !== section) { section = b.section; lines.push(`## ${section}`); }
    lines.push(b.text);
  }
  flush();
  return lines.join("\n\n");
}

// The full result for one read, including what was dropped and how to get the whole page.
export function readResult({ url, title, question, blocks, kept, dropped, pruned, reason, truncated, jevCalls = 0, jevMs = 0 }) {
  const out = {
    url, title, question,
    blocks: blocks.length,
    kept_blocks: kept.length,
    dropped_blocks: dropped.length,
    kept_chars: totalChars(kept),
    dropped_chars: dropped.reduce((a, b) => a + b.text.length, 0),
    total_chars: totalChars(blocks),
    pruned,
    content: assemble(blocks, kept),
  };
  if (dropped.length) {
    // "not relevant" (Jev ranked it out) and "over budget" (it lost to a better block) are
    // different losses for the caller: the second one is fixed by raising max_chars.
    out.dropped_by = {};
    for (const b of dropped) out.dropped_by[b.why] = (out.dropped_by[b.why] ?? 0) + 1;
  }
  if (reason) out.reason = reason;
  if (truncated) out.extraction_truncated = "the page is longer than the extraction cap; the tail of the document was not read";
  if (pruned) { out.jev_calls = jevCalls; out.jev_ms = jevMs; }
  if (dropped.length) out.note = `${out.dropped_blocks} block(s) / ${out.dropped_chars} chars were left out (marked in place). Re-read with a broader question or a larger max_chars, or use browser_snapshot for the page as the caller normally sees it.`;
  return out;
}

// Plain text for the MCP caller, in the style of formatPage(): a short header saying what was
// kept and what was left out, then the content. JSON-escaping a page of prose would spend the
// tokens this tool exists to save.
export function formatRead(r) {
  const lines = [`url: ${r.url}`, `title: ${r.title}`, `question: ${r.question}`];
  const how = r.pruned ? `ranked by Jev in ${r.jev_calls} call(s), ${r.jev_ms} ms` : "not ranked";
  lines.push(`content: ${r.kept_blocks} of ${r.blocks} blocks, ${r.kept_chars} of ${r.total_chars} chars (${how})`);
  if (r.dropped_blocks) lines.push(`dropped: ${r.dropped_blocks} blocks / ${r.dropped_chars} chars (${Object.entries(r.dropped_by).map(([k, n]) => `${n} ${k}`).join(", ")}), marked in place below`);
  if (r.reason) lines.push(`reason: ${r.reason}`);
  if (r.extraction_truncated) lines.push(`warning: ${r.extraction_truncated}`);
  if (r.note) lines.push(`note: ${r.note}`);
  return `${lines.join("\n")}\n---\n${r.content}`;
}
