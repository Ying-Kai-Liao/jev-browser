// Offline tests: page script against a local fixture, and pure page-model helpers. No Jev calls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { JevBrowser, repeatsBlock, actionError } from "../src/session.mjs";
import { pageDiff, formatPage, repeatedElements } from "../src/page-model.mjs";

const FIXTURE = `<!doctype html><html><head><title>Fixture</title>
<style>.ghost{opacity:0;position:absolute} .hidden{display:none} .sizerow{position:relative;width:320px;height:90px} .sizerow input{opacity:0;position:absolute;inset:0;width:320px;height:90px;margin:0} .sizerow label{position:relative;display:block;width:320px;height:90px} .sizeinner{height:100%} .vh{position:absolute;top:0;left:0;width:1px;height:1px;clip:rect(1px,1px,1px,1px);clip-path:inset(0 0 99.9% 99.9%);margin:0} .colornav-item{position:relative;padding:10px;list-style:none} .colornav-item label{display:block;width:42px;height:42px} th{cursor:default} .clicky{cursor:pointer} .far{margin-top:3000px}</style></head><body>
<h1>Fixture page</h1>
<label for="email">Email address</label><input id="email" type="email" placeholder="you@x.com">
<label>Password <input type="password" name="pw"></label>
<span id="lbl">Search the docs</span><input aria-labelledby="lbl">
<div id="boxes"><input type="checkbox"> checkbox 1<br><input type="checkbox" checked> checkbox 2</div>
<ul><li class="completed"><input class="ghost" type="checkbox" aria-label="Toggle Todo"><label>buy milk</label></li></ul>
<div class="sizerow"><input id="size14" type="radio" name="size"><label for="size14"><div class="sizeinner">14 inch</div></label></div>
<ul class="colornav"><li class="colornav-item"><input id="cblack" class="vh" type="radio" name="colour"><label for="cblack"><span>Space Black</span></label></li></ul>
<input type="file" class="hidden" id="upl">
<button disabled>Save</button><button aria-busy="true">Working…</button>
<select name="s"><option>One</option><option selected>Two</option></select>
<table><thead><tr><th aria-sort="ascending">Last Name</th><th>First</th></tr></thead><tbody><tr><td>Bach</td><td>J</td></tr></tbody></table>
<div class="clicky">Open panel</div>
<img src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2740%27 height=%2740%27/%3E" width="40" height="40" alt="User avatar">
<button class="hidden">Invisible</button>
<div aria-hidden="true"><button>Behind modal</button></div>
<my-el></my-el>
<iframe srcdoc="<input id='inner' placeholder='Inside frame'>" width="300" height="80"></iframe>
<a href="/x">Delete</a><a href="/y">Delete</a>
<p class="far">Offscreen paragraph text</p>
<script>customElements.define("my-el", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<button>Shadow button</button>"; } });</script>
</body></html>`;

let browser, b, page;
before(async () => {
  browser = await chromium.launch();
  b = await JevBrowser.launch({ browser });
  await b.page.setContent(FIXTURE);
  await b.page.waitForTimeout(300);
  page = await b.snapshot();
});
after(async () => { await b.close(); await browser.close(); });

const find = pred => page.elements.find(pred);

test("labels come from for=, wrapping label, aria-labelledby and adjacent text", () => {
  assert.equal(find(e => e.tag === "input:email").label, "Email address");
  assert.equal(find(e => e.tag === "input:password").label, "Password");
  assert.equal(find(e => e.label === "Search the docs")?.tag, "input:text");
  const boxes = page.elements.filter(e => e.tag === "input:checkbox" && /checkbox \d/.test(e.label ?? ""));
  assert.deepEqual(boxes.map(e => [e.label, e.checked]), [["checkbox 1", false], ["checkbox 2", true]]);
});

test("transparent styled checkbox is kept with row context", () => {
  const t = find(e => e.label === "Toggle Todo");
  assert.ok(t, "opacity:0 checkbox listed");
  assert.equal(t.row_state, "completed");
  assert.match(t.near, /buy milk/);
});

test("hidden file input is listed and flagged", () => {
  assert.equal(find(e => e.tag === "input:file")?.hidden, true);
});

test("state flags: disabled, busy, select value/options, sort", () => {
  assert.equal(find(e => e.text === "Save").disabled, true);
  assert.equal(find(e => e.text === "Working…").busy, true);
  const s = find(e => e.tag === "select");
  assert.equal(s.value, "Two"); assert.deepEqual(s.options, ["One", "Two"]);
  assert.equal(find(e => e.tag === "th" && e.text === "Last Name").sorted, "ascending");
});

test("pointer-cursor divs, images, shadow DOM and iframes are reachable", () => {
  assert.ok(find(e => e.text === "Open panel"), "cursor:pointer div");
  assert.ok(find(e => e.tag === "img" && e.text === "User avatar"), "image");
  assert.ok(find(e => e.text === "Shadow button"), "shadow DOM");
  const inner = find(e => e.placeholder === "Inside frame");
  assert.ok(inner?.frame, "iframe element carries its frame");
});

test("hidden and aria-hidden elements are excluded", () => {
  assert.equal(find(e => e.text === "Invisible"), undefined);
  assert.equal(find(e => e.text === "Behind modal"), undefined);
});

test("visible text is the viewport, metrics describe the whole page", () => {
  assert.match(page.text, /Fixture page/);
  assert.doesNotMatch(page.text, /Offscreen paragraph/);
  assert.ok(page.metrics.page_height > 3000);
  assert.equal(page.metrics.elements, page.elements.length);
});

test("repeated elements are counted", () => {
  assert.equal(page.repeated_elements['a "Delete"'], 2);
  assert.equal(repeatedElements([{ tag: "a", text: "x" }]), undefined);
});

test("every element can be located and acted on, including in frames", async () => {
  const inner = find(e => e.placeholder === "Inside frame");
  await b.act({ tool: "type", target: inner.i, value: "hello" });
  assert.equal(await b.locate(inner.i).inputValue(), "hello");
  const box = find(e => e.label === "checkbox 1");
  await b.act({ tool: "click", target: box.i });
  assert.equal(await b.locate(box.i).isChecked(), true);
});

test("pageDiff reports added/removed elements, url and metric changes", () => {
  const a = { url: "u1", text: "hello world", metrics: { elements: 1 }, elements: [{ i: 0, tag: "button", text: "Add" }] };
  const c = { url: "u2", text: "hello world again", metrics: { elements: 2 }, elements: [{ i: 0, tag: "button", text: "Add" }, { i: 1, tag: "button", text: "Delete" }] };
  const d = pageDiff(a, c);
  assert.deepEqual(d.added, ['button "Delete"']);
  assert.equal(d.removed, undefined);
  assert.equal(d.url, "u1 -> u2");
  assert.equal(d.metrics.elements, "1 -> 2");
  assert.equal(d.new_text, "again");
  assert.equal(pageDiff(null, c), undefined);
});

test("pageDiff pairs duplicates, reports value/check changes, ignores surrounding-text-only changes", () => {
  const inp = v => ({ i: 1, tag: "input:text", placeholder: "What needs to be done?", near: "todos", ...(v ? { value: v } : {}) });
  const tog = (n, c = false) => ({ i: 3, tag: "input:checkbox", label: "Toggle Todo", near: n, checked: c });
  const all = n => ({ i: 2, tag: "input:checkbox", label: "Mark all as complete", near: n, checked: false });
  const a = { url: "u", text: "todos buy milk 1 item left", elements: [inp("walk the dog"), all("buy milk"), tog("buy milk")] };
  const b = { url: "u", text: "todos buy milk walk the dog 2 items left", elements: [inp(), all("buy milk walk the dog"), tog("buy milk"), tog("walk the dog")] };
  const d = pageDiff(a, b);
  assert.deepEqual(d.added, ['input:checkbox "Toggle Todo" near "walk the dog" checked=false']);
  assert.deepEqual(d.changed, ['input:text "What needs to be done?" near "todos": value="walk the dog" -> (empty)']);
  assert.equal(d.removed, undefined);
  assert.equal(d.new_text, "walk the dog 2 items");
  const c = { ...b, elements: [inp(), all("x"), tog("buy milk", true), tog("walk the dog")] };
  assert.deepEqual(pageDiff(b, c).changed, ['input:checkbox "Toggle Todo" near "buy milk": checked=false -> checked=true']);
});

test("pageDiff reports reordering when the same elements move", () => {
  const els = ["A", "B", "C"].map((t, i) => ({ i, tag: "div", text: t }));
  const a = { url: "u", text: "", elements: els };
  const c = { url: "u", text: "", elements: [els[1], els[0], els[2]] };
  assert.deepEqual(pageDiff(a, c).reordered, { before: ['div "A"', 'div "B"'], after: ['div "B"', 'div "A"'] });
  assert.equal(pageDiff(a, a).reordered, undefined);
});

test("formatPage renders one line per element", () => {
  const txt = formatPage(page);
  assert.match(txt, /^url: /);
  assert.match(txt, /\[\d+\] input:email label="Email address"/);
});

// Hand-built page models: the snapshot options are pure rendering, so they need no browser.
const model = (elements, rest = {}) => ({ url: "u", title: "t", text: "", elements, ...rest });

test("formatPage redacts a typed password and leaves the page model alone", () => {
  const pg = model([{ i: 0, tag: "input:password", label: "Password", value: "hunter2" }], { text: "sign in" });
  const txt = formatPage(pg);
  assert.doesNotMatch(txt, /hunter2/);
  assert.match(txt, /\[0\] input:password label="Password" value="\[redacted\]"/);
  assert.equal(pg.elements[0].value, "hunter2", "redaction happens in the renderer, not in the model");
  // an empty password field has nothing to hide and still renders as before
  assert.match(formatPage(model([{ i: 0, tag: "input:password", label: "Password" }])), /\[0\] input:password label="Password"$/m);
});

test("urls: href is off by default, printed when asked, kept when it is the only identity", () => {
  const pg = model([{ i: 0, tag: "a", text: "Docs", href: "/docs" }, { i: 1, tag: "a", href: "/icon-only" }]);
  const off = formatPage(pg);
  assert.doesNotMatch(off, /href=\/docs/);
  assert.match(off, /\[1\] a href=\/icon-only/);
  assert.match(formatPage(pg, { urls: true }), /\[0\] a "Docs" href=\/docs/);
});

test("interactive drops the visible text block and keeps dialogs and elements", () => {
  const pg = model([{ i: 0, tag: "button", text: "Retry" }], { text: "a long page of prose", dialogs: ["Payment failed"] });
  const txt = formatPage(pg, { interactive: true });
  assert.doesNotMatch(txt, /visible text:/);
  assert.doesNotMatch(txt, /long page of prose/);
  assert.match(txt, /dialogs: Payment failed/);
  assert.match(txt, /\[0\] button "Retry"/);
  assert.match(formatPage(pg), /visible text: a long page of prose/);
});

test("filter keeps matching elements case-insensitively and counts the rest", () => {
  const pg = model([
    { i: 0, tag: "button", text: "Add to cart" },
    { i: 1, tag: "button", text: "Checkout" },
    { i: 2, tag: "a", text: "Home", href: "/cart" },
    { i: 3, tag: "input:text", placeholder: "Search" },
  ]);
  const txt = formatPage(pg, { filter: "CART" });
  assert.match(txt, /elements \(2 of 4; 2 hidden by filter "CART"\)/);
  assert.match(txt, /\[0\] button "Add to cart"/);
  assert.match(txt, /\[2\] a "Home"/, "an href match counts even though the href is not printed");
  assert.doesNotMatch(txt, /Checkout/);
  assert.match(formatPage(pg), /elements \(4\):/, "no filter, no count");
});

test("max_chars truncates, says what was dropped and how to narrow, and is hard-capped", () => {
  const pg = model(Array.from({ length: 500 }, (_, i) => ({ i, tag: "button", text: `Button number ${i} with a label long enough to cost real tokens` })));
  const txt = formatPage(pg, { maxChars: 1000 });
  assert.ok(txt.length <= 1000, `rendered ${txt.length} chars for maxChars 1000`);
  assert.match(txt, /… truncated: \d+ of 500 element lines and \d+ chars dropped; narrow with filter, interactive or diff/);
  assert.ok(formatPage(pg).length <= 10000, "10000 by default");
  assert.ok(formatPage(pg, { maxChars: 999999 }).length <= 20000, "asking for more than the cap still caps");
  assert.ok(formatPage(pg, { maxChars: Infinity, maxElements: 500 }).length > 20000, "library callers can opt out");
});

test("snapshot diff reports only what changed, and falls back to a full page with no anchor", async () => {
  const b2 = await JevBrowser.launch({ browser });
  await b2.page.setContent(`<button>Alpha</button>`);
  const first = await b2.snapshotText({ diff: true });
  assert.match(first, /no previous snapshot to diff against; showing the full page/);
  assert.match(first, /\[\d+\] button "Alpha"/);
  await b2.page.evaluate(() => { const x = document.createElement("button"); x.textContent = "Beta"; document.body.append(x); });
  const d = await b2.snapshotText({ diff: true });
  assert.match(d, /changes since the previous snapshot:/);
  assert.match(d, /added \(1\):\n\s+button "Beta"/);
  assert.doesNotMatch(d, /\[\d+\] button "Alpha"/, "unchanged elements are not listed again");
  assert.match(await b2.snapshotText({ diff: true }), /no changes since the previous snapshot/);
  await b2.close();
});

test("a typed password reaches neither a snapshot nor a diff", async () => {
  const b2 = await JevBrowser.launch({ browser });
  await b2.page.setContent(`<label>Password <input type="password" name="pw"></label><button>Sign in</button>`);
  await b2.snapshotText();                                   // anchor the diff on the empty form
  await b2.page.fill("input[type=password]", "hunter2");
  const d = await b2.snapshotText({ diff: true });
  assert.doesNotMatch(d, /hunter2/);
  assert.match(d, /input:password "Password".*: \(empty\) -> value="\[redacted\]"/);
  await b2.page.fill("input[type=password]", "correct horse");
  const snap = await b2.snapshotText();
  assert.doesNotMatch(snap, /correct horse/);
  assert.match(snap, /input:password label="Password" value="\[redacted\]"/);
  // one secret replaced by another redacts to the same string, so the diff reports nothing:
  // not even the fact that it changed leaks, which is the safe side to err on.
  assert.match(await b2.snapshotText({ diff: true }), /no changes since the previous snapshot/);
  await b2.close();
});

test("resolve keeps tool, target and value consistent", () => {
  const pg = { elements: [{ i: 0, tag: "button", text: "Go" }, { i: 1, tag: "input:text", label: "Name" }, { i: 2, tag: "input:file" }] };
  const ans = (tool, target) => ({ tool: { choice: tool, probabilities: { [tool]: 0.9 } }, target: { probabilities: target }, value: { choice: "name" } });
  // type aimed at a button falls back to the likeliest text field
  let r = b.resolve(pg, ans("type", { 0: 0.7, 1: 0.3, 2: 0 }), { name: "Ada" });
  assert.equal(r.tool, "type"); assert.equal(r.target, 1); assert.equal(r.value, "Ada");
  // type with no values becomes click
  r = b.resolve(pg, ans("type", { 1: 0.9, 0: 0.1 }), {});
  assert.equal(r.tool, "click");
  // upload always lands on a file input
  r = b.resolve(pg, ans("upload", { 0: 0.95, 1: 0.05 }), { name: "/tmp/f" });
  assert.equal(r.target, 2);
});

test("repeatsBlock detects action loops", () => {
  assert.equal(repeatsBlock(["t", "e", "t", "e", "t", "e"], 2, 3), true);
  assert.equal(repeatsBlock(["x", "t", "e", "t", "e"], 2, 3), false);
  assert.equal(repeatsBlock(["a", "a", "a"], 1, 5), false);
  assert.equal(repeatsBlock(["a", "a", "a", "a", "a"], 1, 5), true);
  assert.equal(repeatsBlock(["a", "a", "a", "a", "a", "a"], 2, 3), false);
});

test("overlays: covered elements are flagged and an unmarked modal is reported as a dialog", async () => {
  const b2 = await JevBrowser.launch({ browser });
  await b2.page.setContent(`<button id="under">Media</button><p>lots of page</p>
    <div style="position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center">
      <div style="position:absolute;inset:0;background:rgba(0,0,0,.4)"></div>
      <div style="position:relative;background:#fff;padding:40px">Don't miss what's happening <button>Log in</button></div>
    </div>`);
  const pg = await b2.snapshot();
  assert.equal(pg.elements.find(e => e.text === "Media").covered, true);
  assert.equal(pg.elements.find(e => e.text === "Log in").covered, undefined);
  assert.ok(pg.dialogs?.some(d => /Don't miss what's happening/.test(d)), JSON.stringify(pg.dialogs));
  const err = await b2.act({ tool: "click", target: pg.elements.find(e => e.text === "Media").i }).then(() => null, actionError);
  assert.equal(err, "click blocked: another element (a modal, overlay or banner) covers the target");
  await b2.close();
});

test("a transparent input under its own nested label is clickable, not covered", async () => {
  const r = find(e => e.label === "14 inch" && e.tag === "input:radio");
  assert.ok(r, "ghost radio is listed");
  assert.equal(r.covered, undefined, "its own label must not count as an overlay");
  await b.act({ tool: "click", target: r.i });
  assert.equal(await b.page.locator("#size14").isChecked(), true, "clicking the label selects the real radio");
});

test("a clipped 1px-hidden input whose container sits on top is clickable, not covered", async () => {
  const r = find(e => e.label === "Space Black" && e.tag === "input:radio");
  assert.ok(r, "visually hidden radio is listed");
  assert.equal(r.covered, undefined, "a visually hidden input is not an overlay victim");
  await b.act({ tool: "click", target: r.i });
  assert.equal(await b.page.locator("#cblack").isChecked(), true, "clicking the label selects the real radio");
});

test("fixture page has no false covered flags or dialogs", () => {
  assert.deepEqual(page.elements.filter(e => e.covered).map(e => e.text ?? e.label), []);
  assert.equal(page.dialogs, undefined);
});

// Stub Jev's per-round answers: click element `target` with nothing done.
const clickAnswers = target => ({
  done: { noul: 0 }, done_change: { noul: 0 }, blocked: { noul: 0 }, error: { noul: 0 }, login: { noul: 0 }, irreversible: { noul: 0.1 },
  tool: { choice: "click", probabilities: { click: 0.9 } }, target: { probabilities: { [target]: 0.95 } }, stages: 1,
});

test("dialogs: confirm is dismissed by default and accepted only when asked", async () => {
  const b2 = await JevBrowser.launch({ browser });
  await b2.page.setContent(`<button onclick="document.body.dataset.c = confirm('Delete your account?')">Delete account</button>
    <button onclick="alert('Saved'); document.body.dataset.a = 'shown'">Save</button>`);
  const snap = await b2.snapshotText();
  const del = +snap.match(/\[(\d+)\] button "Delete account"/)[1], save = +snap.match(/\[(\d+)\] button "Save"/)[1];
  let r = await b2.actOn({ action: "click", element: del });
  assert.equal(await b2.page.evaluate(() => document.body.dataset.c), "false");
  assert.match(r.events.join(), /confirm dialog "Delete your account\?" dismissed/);
  r = await b2.actOn({ action: "click", element: save });
  assert.equal(await b2.page.evaluate(() => document.body.dataset.a), "shown");
  assert.match(r.events.join(), /alert dialog "Saved" accepted/);
  await b2.actOn({ action: "click", element: del, acceptDialog: true });
  assert.equal(await b2.page.evaluate(() => document.body.dataset.c), "true");
  await b2.close();
});

test("dialogs: do() hands back a confirm that Jev rates irreversible, and fails safe without Jev", async () => {
  const b2 = await JevBrowser.launch({ browser });
  await b2.page.setContent(`<button onclick="document.body.dataset.c = confirm('Permanently delete 3 files?')">Delete files</button>`);
  const i = (await b2.snapshot()).elements[0].i;
  b2.decide = async () => clickAnswers(i);
  b2.call = async () => ({ answers: { q: { noul: 0.9 } } });
  let r = await b2.do("Delete the files");
  assert.equal(r.status, "needs_confirmation");
  assert.equal(r.pending.dialog, "Permanently delete 3 files?");
  assert.equal(await b2.page.evaluate(() => document.body.dataset.c), "false");
  // Jev unavailable: dismiss rather than accept
  b2.call = async () => { throw new Error("Jev 402"); };
  r = await b2.do("Delete the files");
  assert.equal(r.status, "needs_confirmation");
  // benign confirm is accepted
  b2.call = async () => ({ answers: { q: { noul: 0.1 } } });
  await b2.do("Delete the files", { maxActions: 1 });
  assert.equal(await b2.page.evaluate(() => document.body.dataset.c), "true");
  await b2.close();
});

test("loop guard tells different targets apart on an unchanged page", async () => {
  const b2 = await JevBrowser.launch({ browser });
  await b2.page.setContent(`<button>A</button><button>B</button><button>C</button><button>D</button>`);
  const ids = (await b2.snapshot()).elements.map(e => e.i);
  let n = 0;
  b2.decide = async () => clickAnswers(ids[n++ % ids.length]);
  const r = await b2.do("Click every button", { maxActions: 4 });
  assert.equal(r.status, "max_actions", r.info);
  await b2.close();
});

test("act: element numbers are matched to the current page, and stale ones are refused", async () => {
  const b2 = await JevBrowser.launch({ browser });
  await b2.page.setContent(`<button onclick="document.body.dataset.hit = 'save'">Save</button><button id="rm">Remove me</button>`);
  const snap = await b2.snapshotText();
  const save = +snap.match(/\[(\d+)\] button "Save"/)[1], rm = +snap.match(/\[(\d+)\] button "Remove me"/)[1];
  // the page gains an element above, which shifts every number
  await b2.page.evaluate(() => { const x = document.createElement("button"); x.textContent = "New"; x.onclick = () => document.body.dataset.hit = "new"; document.body.prepend(x); });
  await b2.snapshot();   // renumbers the page, as check() and choose() do
  await b2.actOn({ action: "click", element: save });
  assert.equal(await b2.page.evaluate(() => document.body.dataset.hit), "save");
  await b2.page.evaluate(() => document.getElementById("rm").remove());
  await assert.rejects(b2.actOn({ action: "click", element: rm }), /no longer on the page/);
  await b2.close();
});
