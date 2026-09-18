#!/usr/bin/env node
// End-to-end check for browser_read against a real page, with a real key.
//
//   node examples/read-demo.mjs
//   node examples/read-demo.mjs "https://…" "what do you want to know?"
//
// Needs network and TYPESAFE_API_KEY (the repo .env is read automatically). Prints what the
// page costs unpruned, what survived the ranking, and what was dropped.
import { JevBrowser } from "../src/index.mjs";
import { formatRead } from "../src/prune.mjs";

const url = process.argv[2] ?? "https://en.wikipedia.org/wiki/World_War_II";
const question = process.argv[3] ?? "When and why did Japan surrender?";
const tok = c => Math.round(c / 4);

const b = await JevBrowser.launch();
try {
  await b.open(url);

  // What the caller pays today to look at this page.
  const snapshot = await b.snapshotText();
  const full = (await b.extractBlocks()).blocks.reduce((a, x) => a + x.text.length, 0);
  console.log(`page      : ${url}`);
  console.log(`snapshot  : ${snapshot.length} chars (~${tok(snapshot.length)} tokens), of which ${b.shown.text.length} chars are page text — the viewport only`);
  console.log(`document  : ${full} chars (~${tok(full)} tokens) of readable text in total\n`);

  const t = Date.now();
  const r = await b.read(question);
  console.log(formatRead(r).split("\n---\n")[0]);
  console.log(`wall time : ${Date.now() - t} ms\n`);
  console.log(`--- content kept for "${question}" ---\n`);
  console.log(r.content.length > 4000 ? `${r.content.slice(0, 4000)}\n… (${r.content.length - 4000} more chars)` : r.content);
  console.log(`\n--- ${r.kept_chars} of ${r.total_chars} chars kept: ${(r.total_chars / Math.max(r.kept_chars, 1)).toFixed(1)}× less than reading the whole document ---`);
} finally {
  await b.close();
}
