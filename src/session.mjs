// A browser session driven by Jev. Code reads the page, Jev decides, Playwright acts.
//
//   const b = await JevBrowser.launch();
//   await b.open("https://example.com/login");
//   await b.do("Log in", { values: { email: "a@b.com", password: "…" } });
//   await b.check("Is the user logged in?");          // -> probability
//
// Per round, one Jev request asks: done (two wordings), blocked, error, irreversible, tool,
// target, value. Pages with more than MAX_SINGLE elements go through two stages (group, then
// element). Follow-up requests are made only when needed: a key to press, a drag destination,
// an option to select, or a stricter "is it done" when the answers disagree.
import { chromium } from "playwright";
import { jev } from "./jev.mjs";
import { ENUMERATE, EXTRACT_BLOCKS } from "./page-script.mjs";
import { FIELDISH, SELECTISH, FILEISH, brief, pickCloser, pageDiff, repeatedElements, formatPage, formatDiff, redactPage, redactValues, SECRET_KEY, REDACTED } from "./page-model.mjs";
import { WEBMCP_INIT, webmcpText } from "./webmcp.mjs";
import { normalizeBlocks, batchBlocks, batchQuestions, pickBlocks, readResult, totalChars, MIN_PRUNE_CHARS, BUDGET_CHARS, DROP_BELOW, MAX_JEV_CALLS } from "./prune.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));

// "390x844" -> { width: 390, height: 844 }; anything else throws. The MCP schema uses the same pattern.
export const VIEWPORT_RE = /^(\d{2,5})x(\d{2,5})$/;
export function parseViewport(s) {
  const m = VIEWPORT_RE.exec(String(s ?? ""));
  if (!m) throw new Error(`viewport must look like 390x844, got "${s}"`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

export const TOOLS = {
  click: "Click the target (link, button, checkbox, radio, tab, menu item)",
  type: "Type one of the given `values` into the target text field, replacing its content",
  press_enter: "Press Enter in the target field (e.g. to submit a search or add an item)",
  press_key: "Press a keyboard key other than Enter (Escape, Tab, arrow keys, Space, Backspace…)",
  select: "Choose an option in the target <select> dropdown",
  hover: "Move the mouse over the target to reveal hidden content",
  right_click: "Right-click the target to open a context menu",
  drag: "Drag the target and drop it onto another element",
  upload: "Attach one of the given `values` (a file path) to the target file input",
  scroll: "Scroll down to load or reveal more content",
  wait: "Wait: the page is still loading or processing (spinner, 'loading…', busy/disabled button)",
  none: "No action: the goal is already achieved, or nothing on this page can make progress",
};
// Offered only when the page registered WebMCP tools (see src/webmcp.mjs).
export const WEBMCP_ACTION = "Call one of the page's own agent tools in `page.webmcp_tools`. The site provides them for agents and one call does the whole step (no typing into fields, no submit button), so when a tool does what the next step needs, choose this over click or type";
// `back` is not offered to Jev (it proposed it after successful steps); callers can still use it via act().
export const KEYS = ["Escape", "Tab", "Space", "Backspace", "Delete", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageDown", "PageUp", "Home", "End"];
const TARGETED = new Set(["click", "type", "press_enter", "select", "hover", "right_click", "drag", "upload"]);
const GUARDED = new Set(["click", "press_enter", "press_key"]);
// a page tool can change anything the page can, unless the site marks it read-only
const guarded = act => GUARDED.has(act.tool) || (act.tool === "webmcp" && !act.readOnly);
const ARG_SKIP = "(leave out)";
const MAX_INLINE_ARGS = 24;   // argument questions carried in the decide() request
const actLabel = act => act.tool === "webmcp" ? `tool ${act.webmcp}` : brief(act.el);
// In-page helpers for scroll(). A box scrolls if its overflow allows it and its content is taller.
const SCROLL_BOX_MAIN = () => {
  const scrolls = el => /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1;
  const doc = document.scrollingElement;
  if (doc && doc.scrollHeight > innerHeight + 1 && getComputedStyle(document.body).overflowY !== "hidden" && getComputedStyle(doc).overflowY !== "hidden") return { h: innerHeight };
  let best = null;
  for (const el of document.querySelectorAll("body *")) {
    if (!scrolls(el)) continue;
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0), h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    if (w > 0 && h > 0 && (!best || w * h > best.area)) best = { area: w * h, h, x: Math.max(r.left, 0) + w / 2, y: Math.max(r.top, 0) + h / 2 };
  }
  return best ? { h: best.h, x: best.x, y: best.y } : {};
};
// the visible part of the nearest box that scrolls, el itself or around it; none: the document
const SCROLL_BOX_OF = el => {
  for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    const st = getComputedStyle(n);
    if (/(auto|scroll|overlay)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 1) {
      const r = n.getBoundingClientRect();
      const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0), h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      if (w > 0 && h > 0) return { h, x: Math.max(r.left, 0) + w / 2, y: Math.max(r.top, 0) + h / 2 };
    }
  }
  return { h: innerHeight };
};
// how far everything in the frame is scrolled, summed: changes whichever box moved
const SCROLL_OFFSET = () => {
  let sum = scrollY;
  for (const el of document.querySelectorAll("body *")) if (el.scrollTop) sum += el.scrollTop;
  return sum;
};
// dialog policies: dialog -> accept? Alerts and "leave page?" carry no decision; confirm/prompt may.
export const SAFE_DIALOGS = d => ["alert", "beforeunload"].includes(d.type());
export const ACCEPT_DIALOGS = () => true;

const MAX_SINGLE = 240;          // choice questions accept at most 255 options
const MAX_STATE_CHARS = 70_000;  // requests are capped at 32,768 input tokens
const GROUP = 30;

// Short, model-readable reason for a failed Playwright action.
export function actionError(e) {
  const msg = String(e?.message ?? e);
  const m = msg.match(/<([a-z0-9-]+)[^>]*>.*?(?:from <[^>]*>)?\s*subtree intercepts pointer events/i) || msg.match(/intercepts pointer events/i);
  if (m) return "click blocked: another element (a modal, overlay or banner) covers the target";
  if (/not visible|element is not attached/i.test(msg)) return "target is not visible or no longer on the page";
  if (/disabled|not enabled/i.test(msg)) return "target is disabled";
  return msg.split("\n")[0].slice(0, 160);
}

// true if the last `times * k` entries of seq are one k-long block repeated `times` times
export function repeatsBlock(seq, k, times) {
  if (seq.length < k * times) return false;
  const tail = seq.slice(-k * times), block = tail.slice(0, k).join("\n");
  if (k > 1 && new Set(tail.slice(0, k)).size === 1) return false;   // identical single actions are counted by k = 1
  for (let n = 1; n < times; n++) if (tail.slice(n * k, (n + 1) * k).join("\n") !== block) return false;
  return true;
}

// JEV_BROWSER: a Playwright channel for an installed browser (chrome, chrome-beta, msedge, ...)
// or the path to any Chromium-based browser's executable (Brave, Arc, Vivaldi, ...).
// Empty or "chromium" keeps Playwright's own Chromium.
export function browserOptions(use) {
  use = use?.trim();
  if (!use || use === "chromium") return {};
  return /[\\/]/.test(use) ? { executablePath: use } : { channel: use };
}

export class JevBrowser {
  // userDataDir -> persistent profile (logins survive restarts); browser -> share one Chromium.
  // highlight -> outline each target with Jev's decision before acting (for watching a headed run).
  // use -> the browser to run instead of Playwright's Chromium (default JEV_BROWSER): see browserOptions.
  static async launch({ headed = false, slowMo = 0, viewport = { width: 1280, height: 800 }, storageState, browser, userDataDir, highlight = false, use = process.env.JEV_BROWSER } = {}) {
    let context, own = false;
    const custom = browserOptions(use), opts = { headless: !headed, slowMo, ...custom };
    try {
    if (userDataDir) {
      context = await chromium.launchPersistentContext(userDataDir, { ...opts, viewport });
    } else {
      own = !browser;
      browser ??= await chromium.launch(opts);
      context = await browser.newContext({ viewport, storageState });
    }
    } catch (e) {
      const msg = String(e.message);
      // Chrome opens a profile in one browser at a time; the second one exits before any page loads.
      if (userDataDir && /ProcessSingleton|SingletonLock/i.test(msg)) throw Object.assign(new Error(`Browser profile in use by another browser: ${userDataDir}. Close the browser that has it open (the jev-browser MCP server closes its own after JEV_BROWSER_IDLE_MINUTES without a tool call) or use another profile.`), { code: "PROFILE_IN_USE", profile: userDataDir });
      if (Object.keys(custom).length && /is not found|ENOENT|Executable doesn't exist/i.test(msg)) throw new Error(`Browser "${use}" (JEV_BROWSER) was not found. Install it, or set JEV_BROWSER to a Chromium-based browser's executable path, or unset it to use Playwright's Chromium.`);
      if (/Executable doesn't exist|browserType\.launch/i.test(msg) && /install/i.test(msg)) throw new Error("Chromium for Playwright is not installed. Run: npx playwright install chromium");
      throw e;
    }
    const b = new JevBrowser(browser, context, own);
    b.highlight = highlight;
    b.page = context.pages()[0] ?? await context.newPage();
    return b;
  }

  constructor(browser, context, ownBrowser) {
    this.browser = browser; this.context = context; this.ownBrowser = ownBrowser;
    this.inflight = new Map(); this.events = []; this.frames = new Map(); this.lastPage = null;
    this.shown = null;               // the page whose element numbers the caller last saw
    this.dialogPolicy = SAFE_DIALOGS;
    this.stats = { calls: 0, jev_ms: 0, tokens: 0 };
    context.addInitScript(() => {
      window.__jevMut = performance.now();
      const mo = new MutationObserver(recs => { if (recs.some(r => r.attributeName !== "data-jev-i")) window.__jevMut = performance.now(); });
      const go = () => mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      document ? go() : addEventListener("DOMContentLoaded", go);
    });
    context.addInitScript(WEBMCP_INIT);
    const track = r => ["fetch", "xhr", "document"].includes(r.resourceType()) && this.inflight.set(r, Date.now());
    const untrack = r => this.inflight.delete(r);
    context.on("request", track); context.on("requestfinished", untrack); context.on("requestfailed", untrack);
    context.on("page", p => {
      if (this.viewport) this.resize(p).catch(() => {});
      if (this._page && p !== this._page) { this.events.push(`new tab opened: ${p.url()}`); this.page = p; }
    });
  }

  get page() { return this._page; }
  set page(p) {
    this._page = p;
    p.on("dialog", async d => {
      // confirm/prompt dialogs are often the site's own "are you sure?" before deleting or paying
      const accept = await Promise.resolve(this.dialogPolicy(d)).catch(() => false);
      this.events.push(`${d.type()} dialog "${d.message().slice(0, 100)}" ${accept ? "accepted" : "dismissed"}`);
      await (accept ? d.accept(this.promptText ?? undefined) : d.dismiss()).catch(() => {});
    });
    p.on("close", () => { if (this._page === p) { const rest = this.context.pages(); if (rest.length) { this._page = rest.at(-1); this.events.push("tab closed; switched to previous tab"); } } });
  }

  // Quiet = no fetch/xhr/document request in flight (ignoring ones older than 5s, e.g. long-poll)
  // and no DOM mutation for `quiet` ms. Capped at `max`.
  async settle({ quiet = 400, max = 8000 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < max) {
      const now = Date.now();
      const net = [...this.inflight.values()].filter(t => now - t < 5000).length;
      let idle = 0;
      try { idle = await this.page.evaluate(() => document.readyState === "loading" ? 0 : performance.now() - (window.__jevMut ?? 0)); } catch { idle = 0; }
      if (net === 0 && idle >= quiet) return Date.now() - t0;
      await sleep(100);
    }
    return Date.now() - t0;
  }

  // viewport: { width, height } or "390x844"; it sticks for later pages and every tab, open or new.
  async open(url, { viewport } = {}) {
    const t0 = Date.now();
    if (viewport) {
      this.viewport = typeof viewport === "string" ? parseViewport(viewport) : viewport;
      await Promise.all(this.context.pages().map(p => this.resize(p)));
    }
    await this.page.goto(url, { waitUntil: "commit", timeout: 30_000 });
    await this.page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    await this.settle();
    return { url: this.page.url(), title: await this.page.title(), ms: Date.now() - t0 };
  }

  // Headless Chromium refuses to resize a window that isn't in its normal state, and a page puts it
  // in fullscreen on its own (a "full screen" button, a video player's iframe). Restore the window
  // itself: the window goes fullscreen before document.fullscreenElement is set, so right after the
  // click document.exitFullscreen() would find nothing to exit.
  async resize(p) {
    try {
      await p.setViewportSize(this.viewport);
    } catch (e) {
      if (!/normal state/.test(e.message)) throw e;
      const cdp = await this.context.newCDPSession(p);
      try {
        const { windowId } = await cdp.send("Browser.getWindowForTarget");
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      } finally {
        await cdp.detach().catch(() => {});
      }
      await p.setViewportSize(this.viewport);
    }
  }

  async snapshot() {
    const main = this.page.mainFrame();
    const frames = [main, ...main.childFrames().filter(f => !f.isDetached())];
    let start = 0; const elements = []; let base; this.frames = new Map();
    for (const [n, f] of frames.entries()) {
      // A frame that never committed a navigation (url "", e.g. a lazy iframe below the fold)
      // has no execution context, and evaluate() would wait for one forever.
      if (n > 0 && !f.url()) continue;
      let r, timer;
      try {
        r = await Promise.race([
          f.evaluate(ENUMERATE, { start, frame: n || undefined }),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("frame evaluate timed out")), 5000); }),
        ]);
      } catch { continue; } finally { clearTimeout(timer); }
      if (n === 0) base = r;
      else if (!r.elements.length) continue;
      for (const e of r.elements) this.frames.set(e.i, f);
      elements.push(...r.elements); start = r.next;
    }
    const s = { url: base?.url ?? this.page.url(), title: base?.title ?? "", text: base?.text ?? "", metrics: { ...base?.metrics, elements: elements.length }, elements };
    const rep = repeatedElements(elements); if (rep) s.repeated_elements = rep;
    if (base?.dialogs?.length) s.dialogs = base.dialogs;
    this.lastPage = s;
    return s;
  }

  // The snapshot the caller reads itself — the one observation it pays for in full. Every option
  // narrows the rendering only; none of them collects less or calls Jev. `diff` reuses pageDiff()
  // against the page this caller was last shown, so it reports the same changes the do() loop sees.
  async snapshotText({ diff = false, ...render } = {}) {
    await this.settle();
    // A diff carries no element numbers, so it must not move this.shown: the caller still acts with
    // the numbers it last saw. It only advances the base the next diff is taken against.
    const prev = this.diffBase?.over === this.shown ? this.diffBase.page : this.shown;
    const page = await this.snapshot();
    // redact before diffing: state() in pageDiff prints value=, which would leak a typed password
    const d = diff && prev ? pageDiff(redactPage(prev), redactPage(page)) : null;
    if (!d) {
      this.shown = page;
      return `${diff ? "(no previous snapshot to diff against; showing the full page)\n" : ""}${formatPage(page, render)}`;
    }
    this.diffBase = { over: this.shown, page };
    return formatDiff(page, d, render);
  }

  async call(state, questions) {
    const r = await this.ask(this.redact(state), questions);
    this.stats.calls++; this.stats.jev_ms += r.ms; this.stats.tokens += r.tokens;
    return r;
  }

  ask(state, questions) { return jev(state, questions); }

  // Secret fields show as [redacted], and a secret value given to do() is cut from anything the
  // page echoes back (its text, a diff, a page tool's result) before the request leaves.
  redact(state) {
    if (state.page) state = { ...state, page: redactPage(state.page) };
    if (!this.secrets?.size) return state;
    let json = JSON.stringify(state);
    for (const v of this.secrets) json = json.split(JSON.stringify(v).slice(1, -1)).join(REDACTED);
    return JSON.parse(json);
  }

  // Yes/no question about the current page -> probability.
  async check(question) {
    await this.settle();
    const page = await this.snapshot();
    const { answers } = await this.call({ page }, { q: { type: "noul", instructions: `Answer about \`page\`: ${question}` } });
    return answers.q.noul;
  }

  // Pick one of `options` (array, or name -> description) about the current page.
  async choose(question, options) {
    await this.settle();
    const page = await this.snapshot();
    const criteria = Array.isArray(options) ? Object.fromEntries(options.map(o => [o, null])) : options;
    const { answers } = await this.call({ page }, { q: { type: "choice", instructions: `Answer about \`page\`: ${question}`, criteria } });
    return { choice: answers.q.choice, probabilities: answers.q.probabilities, confidence: answers.q.confidence };
  }

  // The whole document's readable text, cut at structural boundaries, main frame first.
  // `snapshot().text` is viewport-only on purpose; this is what a reader would scroll through.
  async extractBlocks({ maxBlock, maxChars } = {}) {
    const main = this.page.mainFrame();
    const frames = [main, ...main.childFrames().filter(f => !f.isDetached())];
    const blocks = []; let base, truncated = false;
    for (const [n, f] of frames.entries()) {
      // same guards as snapshot(): an uncommitted frame (url "") has no context to evaluate in
      if (n > 0 && !f.url()) continue;
      let r, timer;
      try {
        r = await Promise.race([
          f.evaluate(EXTRACT_BLOCKS, { maxBlock, maxChars, frame: n || undefined }),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("frame evaluate timed out")), 5000); }),
        ]);
      } catch { continue; } finally { clearTimeout(timer); }
      if (n === 0) base = r;
      blocks.push(...r.blocks);
      truncated ||= r.truncated;
    }
    return { url: base?.url ?? this.page.url(), title: base?.title ?? "", blocks, truncated };
  }

  // Page content relevant to `question`: code splits, Jev ranks, code reassembles. The same
  // shape as the two-stage element selection in decide() — Jev is the ranking function, code
  // owns the recursion and the budget. Never returns a silent truncation: whatever is left out
  // is counted, marked in place and reported.
  async read(question, { budgetChars = BUDGET_CHARS, minChars = MIN_PRUNE_CHARS, dropBelow = DROP_BELOW, maxBlock, maxChars } = {}) {
    await this.settle();
    const { url, title, blocks: raw, truncated } = await this.extractBlocks({ maxBlock, maxChars });
    const blocks = normalizeBlocks(raw, maxBlock ? { maxBlock } : {});
    const size = totalChars(blocks);
    const base = { url, title, question, blocks, truncated };

    // Ranking pays off only above both the floor and the caller's own budget: under either the
    // page is already about the size a pruned one would be, and a Jev call costs 700 ms-1.5 s.
    // Skipping the ranking does not skip the budget.
    const gate = Math.max(minChars, budgetChars);
    if (size <= gate) {
      const { kept, dropped } = pickBlocks(blocks, {}, { dropBelow, budgetChars });
      return readResult({ ...base, kept, dropped, pruned: false, reason: `page text is ${size} chars, at or below the ${gate}-char threshold for ranking: no Jev call` });
    }

    const scores = {};
    let calls = 0, ms = 0;
    const batches = batchBlocks(blocks);
    for (const batch of batches.slice(0, MAX_JEV_CALLS)) {
      const state = { question, page: { url, title, blocks: batch.map(b => ({ i: b.i, ...(b.section ? { section: b.section } : {}), text: b.text })) } };
      try {
        const r = await this.call(state, batchQuestions(batch));
        calls++; ms += r.ms;
        for (const b of batch) { const a = r.answers[`b${b.i}`]; if (a?.noul !== undefined) scores[b.i] = a.noul; }
      } catch (e) {
        // bias to keep: an unanswered batch leaves its blocks unscored, and unscored blocks stay
        this.events.push(`browser_read: a ranking request failed (${String(e?.message ?? e).slice(0, 80)}); its blocks were kept unranked`);
      }
    }
    const { kept, dropped } = pickBlocks(blocks, scores, { dropBelow, budgetChars });
    const unranked = blocks.length - Object.keys(scores).length;
    const capped = batches.length > MAX_JEV_CALLS ? ` (the page needs ${batches.length} ranking requests; only the first ${MAX_JEV_CALLS} were made)` : "";
    return readResult({
      ...base, kept, dropped, pruned: true, jevCalls: calls, jevMs: ms,
      reason: unranked ? `${unranked} of ${blocks.length} blocks could not be ranked and were kept unless over budget${capped}` : undefined,
    });
  }

  async decide(page, goal, values, history, lastChange, webmcp = []) {
    values = redactValues(values);   // what Jev sees; resolve() types the real value
    if (webmcp.length) page = { ...page, webmcp_tools: webmcp.map(t => ({ name: t.name, description: t.description.slice(0, 300), arguments: Object.keys(t.inputSchema?.properties ?? {}) })) };
    const task = { goal, ...(Object.keys(values).length ? { values } : {}), history, ...(lastChange ? { last_change: lastChange } : {}) };
    const withValues = Object.keys(values).length ? ", with the given `task.values`" : "";
    const common = {
      done: { type: "noul", instructions: `Does \`page\` show that \`task.goal\` has been achieved${withValues}? Judge from \`page.text\` and \`page.elements\`.` },
      done_change: { type: "noul", instructions: `Does \`page\` show that \`task.goal\` has been achieved${withValues}? Judge from \`page.text\`, \`page.elements\` and \`task.last_change\` (what the last action changed).` },
      blocked: { type: "noul", instructions: "Is there something on `page` that stops progress on `task.goal` and cannot be handled by clicking or typing (captcha, access denied, error page)?" },
      error: { type: "noul", instructions: "Does `page` show an error or rejection message (e.g. invalid credentials, a validation error, not found) caused by the actions in `task.history`?" },
      login: { type: "noul", instructions: "Is `page` a sign-in or sign-up screen, or asking the user to log in, before `task.goal` can continue?" },
      irreversible: { type: "noul", instructions: "Would the next action toward `task.goal` on `page` have an effect outside this browser that is hard to undo, such as placing an order, paying, sending a message, deleting data or publishing?" },
      tool: { type: "choice", instructions: "What is the next action toward `task.goal` on `page`, given what `task.history` already did?", criteria: webmcp.length ? { ...TOOLS, webmcp: WEBMCP_ACTION } : TOOLS },
    };
    let argKeys;
    if (webmcp.length) {
      common.use_tool = { type: "noul", instructions: "Can one of `page.webmcp_tools` (the page's own tools for agents) do the next step toward `task.goal`, given what `task.history` already did? A tool call replaces typing into fields and pressing buttons for that step." };
      common.webmcp_tool = { type: "choice", instructions: "If the next action toward `task.goal` calls one of `page.webmcp_tools`, which one?", criteria: Object.fromEntries(webmcp.map(t => [t.name, t.description.slice(0, 200) || null])) };
      const per = webmcp.map((t, i) => this.argQuestions(t, values, `t${i}a`));
      if (per.reduce((n, p) => n + p.keys.length, 0) <= MAX_INLINE_ARGS) {
        argKeys = Object.fromEntries(webmcp.map((t, i) => [t.name, per[i].keys]));
        for (const p of per) Object.assign(common, p.qs);
      }
    }
    if (Object.keys(values).length) common.value = { type: "choice", instructions: "If the next action toward `task.goal` types, selects or uploads something, which of `task.values` should it use? Prefer values not yet entered on `page`.", criteria: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v).slice(0, 200)])) };
    const targetQ = { type: "choice", instructions: "Which entry of `page.elements` (by its `i`) should the next action toward `task.goal` act on?" };

    if (page.elements.length <= MAX_SINGLE && JSON.stringify(page).length <= MAX_STATE_CHARS) {
      targetQ.criteria = Object.fromEntries(page.elements.map(e => [String(e.i), null]));
      const r = await this.call({ page, task }, { ...common, ...(page.elements.length ? { target: targetQ } : {}) });
      return { ...r.answers, stages: 1, argKeys };
    }
    // Two stages: groups of consecutive elements, then elements in the likeliest groups.
    const groups = [];
    for (let k = 0; k < page.elements.length; k += GROUP) {
      const els = page.elements.slice(k, k + GROUP);
      groups.push({ g: groups.length, summary: els.map(e => (e.label || e.text || e.placeholder || e.href || e.tag).slice(0, 24)).join(" | ").slice(0, 700) });
    }
    const lite = { url: page.url, title: page.title, text: page.text, metrics: page.metrics, dialogs: page.dialogs, groups, ...(page.webmcp_tools ? { webmcp_tools: page.webmcp_tools } : {}) };
    const r1 = await this.call({ page: lite, task }, {
      ...common,
      group: { type: "choice", instructions: "Which entry of `page.groups` (by its `g`) contains the element the next action toward `task.goal` should act on? Each group summarises consecutive page elements.", criteria: Object.fromEntries(groups.map(g => [String(g.g), null])) },
    });
    const ranked = Object.entries(r1.answers.group.probabilities).sort((a, b) => b[1] - a[1]);
    const pick = []; let mass = 0;
    for (const [g, p] of ranked) { if (pick.length && (mass >= 0.9 || pick.length >= 4)) break; pick.push(+g); mass += p; }
    const sub = page.elements.filter(e => pick.includes(Math.floor(e.i / GROUP))).slice(0, MAX_SINGLE);
    const r2 = await this.call({ page: { url: page.url, title: page.title, text: page.text.slice(0, 1200), elements: sub }, task }, {
      target: { ...targetQ, criteria: Object.fromEntries(sub.map(e => [String(e.i), null])) },
    });
    return { ...r1.answers, target: r2.answers.target, stages: 2, groups_considered: pick, argKeys };
  }

  // Resolve independent tool/target/value answers into one consistent action.
  resolve(page, a, values, webmcp = []) {
    let tool = a.tool.choice;
    // Prefer the page's own tool whenever Jev says one fits the next step, unless nothing is left to do
    if (a.use_tool?.noul >= 0.5 && !["none", "wait"].includes(tool)) tool = "webmcp";
    if (tool === "webmcp") {
      const t = webmcp.find(t => t.name === a.webmcp_tool?.choice);
      if (t) {
        const act = { tool, p_tool: Math.max(a.tool.probabilities.webmcp ?? 0, a.use_tool?.noul ?? 0), webmcp: t.name, schema: t.inputSchema, readOnly: !!t.annotations?.readOnlyHint, target: null, p_target: a.webmcp_tool.probabilities[t.name], candidates: [] };
        if (a.argKeys) act.args = this.argsFrom(a, a.argKeys[t.name], values, act);
        return act;
      }
      tool = "none";   // no tool picked: treated as no action, so the loop reports stuck rather than guessing
    }
    const byI = new Map(page.elements.map(e => [String(e.i), e]));
    const ranked = a.target ? Object.entries(a.target.probabilities).sort((x, y) => y[1] - x[1]) : [];
    const fits = { type: FIELDISH, press_enter: e => FIELDISH(e) || e.tag.startsWith("input"), select: SELECTISH, upload: FILEISH };
    let [ti, tp] = ranked[0] ?? [null, 0];
    if (fits[tool] && ti != null && !fits[tool](byI.get(ti))) {
      const alt = ranked.find(([i]) => fits[tool](byI.get(i)));
      if (alt && (alt[1] >= 0.1 || tool === "upload")) [ti, tp] = alt;
      else if (tool === "upload") { const f = page.elements.find(FILEISH); if (f) [ti, tp] = [String(f.i), 0.5]; }
      else if (tool === "type" || tool === "select") tool = "click";
    }
    if (tool === "type" && !Object.keys(values).length) tool = "click";   // nothing to type: open/focus it instead
    const valueKey = a.value?.choice;
    return {
      tool, p_tool: a.tool.probabilities[a.tool.choice], target: ti == null ? null : +ti, p_target: tp ?? 0, el: byI.get(ti),
      valueKey, value: valueKey != null ? values[valueKey] : undefined,
      candidates: ranked.slice(0, 3).map(([i, p]) => ({ i: +i, p: +p.toFixed(2), el: brief(byI.get(i)) })),
    };
  }

  // A page tool's arguments, filled without writing text: each is one of the caller's `values`
  // or, for an enum, one of its options. Jev picks; code converts to the schema's type.
  // These questions normally ride along in the decide() request (no extra round trip).
  argQuestions(tool, values, prefix) {
    const props = Object.entries(tool.inputSchema?.properties ?? {});
    const required = new Set(tool.inputSchema?.required ?? []);
    const shown = redactValues(values);   // Jev sees the key, never a secret's value
    const qs = {}, keys = [];
    for (const [n, [k, prop]] of props.entries()) {
      const isEnum = Array.isArray(prop?.enum);
      const opts = isEnum ? prop.enum.map(String) : Object.keys(values);
      if (!opts.length) continue;
      const criteria = Object.fromEntries(opts.map(o => [o, isEnum ? null : String(shown[o]).slice(0, 200)]));
      if (!required.has(k)) criteria[ARG_SKIP] = null;
      const what = prop?.description ? ` (${String(prop.description).slice(0, 150)})` : "";
      qs[`${prefix}${n}`] = { type: "choice", instructions: `If the next action toward \`task.goal\` calls the page tool \`${tool.name}\`, what should its \`${k}\` argument be${what}? Pick what the goal needs next, given what \`task.history\` already did.`, criteria };
      keys.push([`${prefix}${n}`, k, prop]);
    }
    return { qs, keys };
  }

  argsFrom(answers, keys, values, act) {
    const args = {}; act.argKeys = {};
    for (const [q, k, prop] of keys) {
      const c = answers[q]?.choice;
      if (c == null || c === ARG_SKIP) continue;
      const isEnum = Array.isArray(prop?.enum);
      const raw = isEnum ? prop.enum.find(o => String(o) === c) : values[c];
      const type = Array.isArray(prop?.type) ? prop.type[0] : prop?.type;
      args[k] = type === "number" || type === "integer" ? Number(raw) : type === "boolean" ? (typeof raw === "boolean" ? raw : /^(true|yes|1|on)$/i.test(String(raw))) : raw;
      act.argKeys[k] = isEnum ? c : `values.${c}`;
    }
    return args;
  }

  // Fallback when the questions did not fit in the decide() request: one follow-up call.
  async webmcpArgs(page, goal, history, act, values) {
    const { qs, keys } = this.argQuestions({ name: act.webmcp, inputSchema: act.schema }, values, "a");
    if (!keys.length) { act.argKeys = {}; return {}; }
    const { answers } = await this.call({ page: { url: page.url, title: page.title, text: page.text }, task: { goal, ...(Object.keys(values).length ? { values: redactValues(values) } : {}), history }, tool: { name: act.webmcp, inputSchema: act.schema } }, qs);
    return this.argsFrom(answers, keys, values, act);
  }

  // One page tool call: the page's code runs, with a timeout. No settling, events left in place.
  async runWebmcp(name, args, timeout = 30_000) {
    let timer;
    return Promise.race([
      this.page.evaluate(([n, a]) => window.__jevWebmcp ? window.__jevWebmcp.call(n, a) : { error: "WebMCP registry missing on this page" }, [name, args]),
      new Promise(res => { timer = setTimeout(() => res({ error: `WebMCP tool "${name}" did not finish within ${timeout} ms` }), timeout); }),
    ]).catch(e => ({ error: String(e.message).split("\n")[0] })).finally(() => clearTimeout(timer));
  }

  locate(i) {
    const f = this.frames.get(i) ?? this.page.mainFrame();
    return f.locator(`[data-jev-i="${i}"]`).first();
  }

  // act = { tool, target?, value?, key?, destination? }
  async act(act) {
    const t = Date.now();
    const needs = TARGETED.has(act.tool) || (act.tool === "press_key" && act.target != null);
    const loc = needs ? this.locate(act.target) : null;
    if (needs && act.target == null) throw new Error(`${act.tool} needs a target element`);
    const o = { timeout: 4000 };
    switch (act.tool) {
      case "click": await loc.click(o); break;
      case "right_click": await loc.click({ button: "right", ...o }); break;
      case "type": {
        if (act.value == null) throw new Error("no value to type");
        const v = String(act.value);
        await loc.fill("", o);
        // real key events: some widgets (date pickers, masks) undo programmatic fill()
        if (v.length <= 120) await loc.pressSequentially(v, { delay: 5, ...o }); else await loc.fill(v, o);
        const got = await loc.inputValue({ timeout: 1000 }).catch(() => null);
        if (got !== null && got !== v) await loc.fill(v, o);
        break;
      }
      case "press_enter": await loc.press("Enter", o); break;
      case "press_key": {
        const key = act.key ?? "Escape";
        if (loc) await loc.press(key, o); else await this.page.keyboard.press(key);
        break;
      }
      case "select": {
        const v = String(act.value ?? "");
        await loc.selectOption({ label: v }, o).catch(() => loc.selectOption(v, o));
        break;
      }
      case "hover": await loc.hover(o); break;
      case "drag": {
        if (act.destination == null) throw new Error("drag needs a destination element");
        await loc.dragTo(this.locate(act.destination), o);
        break;
      }
      case "upload": {
        if (act.value == null) throw new Error("no file path to upload");
        await loc.setInputFiles(String(act.value), o);
        break;
      }
      case "scroll": act.scrolled = await this.scroll(act.direction, act.scrollTarget); break;
      case "wait": await sleep(1000); break;
      case "back": await this.page.goBack({ timeout: 10_000 }).catch(() => {}); break;
      case "none": break;
      case "webmcp": {
        const r = await this.runWebmcp(act.webmcp, act.args ?? {});
        if (r.error) throw new Error(`page tool ${act.webmcp}: ${r.error}`);
        act.result = webmcpText(r.result, 300);
        break;
      }
      default: throw new Error(`unknown action ${act.tool}`);
    }
    return Date.now() - t;
  }

  // A wheel scrolls whatever is under the mouse, and Playwright's mouse sits wherever the last action
  // left it, (0, 0) at first. So aim it: at the scrollable box around the target element when one is
  // given, else at the largest visible scrollable area (the document on most sites, an inner column
  // on app-like layouts). One step is 80% of that area's visible height, like Page Down, so no line
  // is skipped. Returns the distance moved, once the scroll has landed: the wheel is asynchronous
  // and settle() doesn't see it (no request, no DOM change).
  async scroll(direction = "down", target) {
    const frame = target != null ? (this.frames.get(target) ?? this.page.mainFrame()) : this.page.mainFrame();
    const vp = await this.page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    let aim;
    if (target != null) {
      aim = await this.locate(target).evaluate(SCROLL_BOX_OF);
      if (aim.x == null) {   // no box of its own: the document, so the element itself is a fine place
        const b = await this.locate(target).boundingBox();
        if (b) aim = { ...aim, x: b.x + b.width / 2, y: b.y + b.height / 2 };
      } else if (frame !== this.page.mainFrame()) {   // frame coordinates -> page coordinates
        const f = await (await frame.frameElement()).boundingBox();
        if (f) aim = { ...aim, x: aim.x + f.x, y: aim.y + f.y };
      }
    } else aim = await this.page.evaluate(SCROLL_BOX_MAIN);
    const at = { x: aim.x ?? vp.w / 2, y: aim.y ?? vp.h / 2 };
    const step = Math.max(100, Math.round((aim.h ?? vp.h) * 0.8));
    const offset = () => frame.evaluate(SCROLL_OFFSET).catch(() => 0);
    const start = await offset();
    await this.page.mouse.move(Math.min(Math.max(at.x, 0), vp.w - 1), Math.min(Math.max(at.y, 0), vp.h - 1));
    await this.page.mouse.wheel(0, direction === "up" ? -step : step);
    let last = start;
    for (const t0 = Date.now(); Date.now() - t0 < 1500;) {
      await sleep(50);
      const now = await offset();
      if (now === last && (now !== start || Date.now() - t0 >= 500)) break;   // landed, or nothing is coming
      last = now;
    }
    return Math.round(last - start);
  }

  // Element numbers the caller saw can be stale: the page changed, or check()/choose() renumbered
  // it. Map number i from the page shown to the caller onto a fresh snapshot, matching the element
  // by name, surrounding text and frame (the k-th of its look-alikes stays the k-th).
  currentElement(i, cur) {
    const old = this.shown ?? cur;
    const path = u => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return u; } };
    if (path(old.url) !== path(cur.url)) throw new Error(`the page changed since element ${i} was listed (${old.url} -> ${cur.url}); take a new snapshot`);
    const was = old.elements.find(e => e.i === i);
    if (!was) throw new Error(`element ${i} is not in the latest snapshot; take a new snapshot`);
    // same name + surrounding text first, then name alone (surrounding text shifts when neighbours
    // change). Only trust the k-th look-alike if no look-alike was added or removed.
    for (const id of [e => `${brief(e)}|${e.near ?? ""}|${e.frame ?? ""}`, e => `${brief(e)}|${e.frame ?? ""}`]) {
      const before = old.elements.filter(e => id(e) === id(was)), after = cur.elements.filter(e => id(e) === id(was));
      if (after.length === before.length) return after[before.indexOf(was)];
    }
    throw new Error(`element ${i} (${brief(was)}) is no longer on the page, or can't be told apart from similar ones; take a new snapshot`);
  }

  // Act on an element number from the latest snapshot or browser_do candidates, chosen by the caller instead of Jev.
  // Confirm/prompt dialogs are dismissed unless acceptDialog.
  async actOn({ action, element, value, key, destination, acceptDialog = false }) {
    const cur = element != null || destination != null ? await this.snapshot() : null;
    const el = element == null ? undefined : this.currentElement(element, cur);
    if (TARGETED.has(action) && !el) throw new Error(`${action} needs an element`);
    const dest = destination == null ? undefined : this.currentElement(destination, cur).i;
    if (action === "scroll" && value != null && !["up", "down"].includes(value)) throw new Error(`scroll value must be "up" or "down", got "${value}"`);
    const act = { tool: action, target: el?.i, value, key, destination: dest };
    if (action === "scroll") Object.assign(act, { direction: value ?? "down", scrollTarget: el?.i });
    this.dialogPolicy = acceptDialog ? ACCEPT_DIALOGS : SAFE_DIALOGS;
    let ms;
    try { ms = await this.act(act); }
    finally { this.dialogPolicy = SAFE_DIALOGS; }
    await this.settle();
    const events = this.events.splice(0);
    const scrolled = action === "scroll" ? { scrolled: act.scrolled, ...(act.scrolled ? {} : { info: "nothing moved: already at the end, or nothing scrollable there; pass an element to scroll the box that contains it" }) } : {};
    return { action, element: brief(el), ms, ...scrolled, url: this.page.url(), title: await this.page.title().catch(() => ""), ...(events.length ? { events } : {}) };
  }

  // Work toward one goal.
  // status: done | likely_done (verify) | needs_confirmation | needs_login | error | blocked | stuck | ambiguous | max_actions
  async do(goal, opts = {}) {
    const { allowIrreversible = false, irreversibleAt = 0.6 } = opts;
    this.heldDialog = null;
    this.dialogPolicy = allowIrreversible ? ACCEPT_DIALOGS : this.dialogGuard(goal, irreversibleAt);
    try { return await this.runGoal(goal, opts); }
    finally { this.dialogPolicy = SAFE_DIALOGS; }
  }

  // Policy for confirm/prompt dialogs during do(): accept unless Jev thinks accepting is hard to undo.
  dialogGuard(goal, irreversibleAt) {
    return async d => {
      if (SAFE_DIALOGS(d)) return true;
      let p = 1;   // if Jev can't answer, treat the dialog as irreversible and hand it back
      try {
        const { answers } = await this.call({ task: { goal }, dialog: { type: d.type(), message: d.message().slice(0, 500) } }, { q: { type: "noul", instructions: "Would accepting `dialog` have an effect outside this browser that is hard to undo, such as placing an order, paying, sending a message, deleting data or publishing?" } });
        p = answers.q.noul;
      } catch {}
      if (p < irreversibleAt) return true;
      this.heldDialog = { message: d.message().slice(0, 200), p_irreversible: +p.toFixed(2) };
      return false;
    };
  }

  async runGoal(goal, { values = {}, maxActions = 10, doneAt = 0.5, minTarget = 0.3, allowIrreversible = false, irreversibleAt = 0.6, log = () => {} } = {}) {
    const t0 = Date.now(); const calls0 = this.stats.calls;
    this.secrets ??= new Set();
    for (const [k, v] of Object.entries(values)) if (SECRET_KEY.test(k) && String(v).length >= 4) this.secrets.add(String(v));
    const history = []; const rounds = [];
    let prevPage = null, waits = 0, page = null, status = "max_actions", info, pending, retried = false;
    const seen = new Map(), dismissed = new Map();   // url -> dismiss attempts
    this.promptText = values.prompt;
    for (let round = 0; round <= maxActions; round++) {
      await this.settle();
      page = await this.snapshot();
      if (this.events.length) history.push(...this.events.splice(0).map(e => ({ event: e })));
      const webmcp = await this.webmcpTools();
      const a = await this.decide(page, goal, values, history.slice(-12), round ? pageDiff(redactPage(prevPage), redactPage(page)) : undefined, webmcp);
      prevPage = page;
      const act = this.resolve(page, a, values, webmcp);
      const done = Math.max(a.done.noul, a.done_change?.noul ?? 0);
      const r = {
        round, done: +done.toFixed(2), done_plain: +a.done.noul.toFixed(2), done_change: +(a.done_change?.noul ?? 0).toFixed(2),
        blocked: +a.blocked.noul.toFixed(2), error_shown: +a.error.noul.toFixed(2), login: +a.login.noul.toFixed(2), irreversible: +a.irreversible.noul.toFixed(2),
        tool: act.tool, p_tool: +act.p_tool.toFixed(2), target: act.target, p_target: +act.p_target.toFixed(2), el: actLabel(act),
        value: act.valueKey, elements: page.elements.length, stages: a.stages, candidates: act.candidates,
      };
      rounds.push(r);
      log(`  r${round}: ${act.tool}(${r.p_tool}) -> ${act.target != null ? `#${act.target} ` : ""}${r.el} (${r.p_target})${act.valueKey ? ` value=${act.valueKey}` : ""}  done=${r.done} err=${r.error_shown} login=${r.login} irrev=${r.irreversible}${a.use_tool ? ` use_tool=${a.use_tool.noul.toFixed(2)}` : ""}  [${page.elements.length} els${a.stages === 2 ? ", 2-stage" : ""}]`);

      if (round > 0 ? done >= doneAt && done < 0.85 && act.tool !== "none" : done >= 0.9) {
        // "done" and "next action" disagree: settle it with a stricter single question. In round 0
        // nothing has been done yet, so any "done" is checked (labels like a "Done" button mislead it).
        const c = await this.call({ page, task: { goal, history: history.slice(-12) } }, { complete: { type: "noul", instructions: "Is everything `task.goal` asks for already finished on `page`, so that no further action (such as pressing a submit, search or continue button) is needed?" } });
        r.confirm = +c.answers.complete.noul.toFixed(2);
        log(`     confirm=${r.confirm}`);
        if (r.confirm >= 0.65) { status = "done"; break; }
        if (r.confirm >= 0.45) { status = "likely_done"; info = "the page looks done but Jev is unsure; verify with a check, snapshot or screenshot"; break; }
        if (act.tool === "none" && a.use_tool?.noul >= 0.5) {
          // not done after all, and a page tool fits the next step: use it
          Object.assign(act, this.resolve(page, { ...a, tool: { ...a.tool, choice: "webmcp" } }, values, webmcp));
          r.tool = act.tool; r.el = actLabel(act);
        }
        if (a.irreversible.noul >= irreversibleAt && guarded(act)) {
          // the goal looks mostly done and the next step is hard to undo: stop rather than overstep
          status = "done"; info = "stopped before an action that looks irreversible and may go beyond this goal";
          pending = { action: act.tool, element: actLabel(act), p_irreversible: r.irreversible };
          break;
        }
      } else if (done >= (round > 0 ? doneAt : 0.9) && (done >= 0.85 || act.tool === "none" || round === 0)) { status = "done"; break; }
      if (round === maxActions) break;
      if (a.login.noul >= 0.7 && !Object.keys(values).length) {
        // no credentials to type: hand back instead of clicking through sign-in (incl. third-party SSO)
        status = "needs_login"; info = "the page wants a sign-in and no values were given; log in (e.g. in a headed persistent profile) or pass credentials in values"; break;
      }
      if (round > 0 && a.error.noul >= 0.7) { status = "error"; info = "the page shows an error after the last action"; break; }
      if (act.tool === "none" && round === 0 && !retried) {
        // content that appears after a delay (modals, late renders): look once more before giving up
        retried = true; await sleep(1500); round--; rounds.pop(); continue;
      }
      if (act.tool === "none" && round > 0 && done >= 0.35 && a.error.noul < 0.5 && a.blocked.noul < 0.5) {
        // Jev sees nothing left to do after acting, but "done" is soft: let the caller verify
        status = "likely_done"; info = "no further action seems needed but Jev is unsure the goal is met; verify with a check, snapshot or screenshot"; break;
      }
      if (act.tool === "none") { status = a.blocked.noul >= 0.5 ? "blocked" : "stuck"; break; }
      if (a.blocked.noul >= 0.85) { status = "blocked"; break; }
      if (act.tool === "wait") {
        if (++waits > 6) { status = "stuck"; info = "page never finished loading"; break; }
        await this.settle({ max: 4000 }); await sleep(600); history.push({ action: "wait" }); continue;
      }
      if ((TARGETED.has(act.tool) || act.tool === "webmcp") && act.p_target < minTarget) { status = "ambiguous"; info = "target confidence too low; refine the goal or act on a candidate directly"; break; }
      const seenKey = `${act.tool}|${actLabel(act)}|${["type", "select", "upload"].includes(act.tool) ? act.valueKey : ""}|${page.url}|${page.text}|${JSON.stringify(page.elements)}`;
      seen.set(seenKey, (seen.get(seenKey) ?? 0) + 1);
      if (seen.get(seenKey) >= 3) { status = "stuck"; info = "repeating the same action on the same page without progress"; break; }
      const seq = [...history.filter(h => h.action).map(h => `${h.action}|${h.element}|${h.value ?? ""}`), `${act.tool}|${actLabel(act)}|${["type", "select", "upload"].includes(act.tool) ? act.valueKey ?? "" : ""}`];
      if (repeatsBlock(seq, 2, 3) || repeatsBlock(seq, 3, 3) || repeatsBlock(seq, 1, 8)) { status = "stuck"; info = "repeating the same sequence of actions; the goal may already be done — check the page"; break; }

      // follow-up questions only for the chosen action
      if (act.tool === "select" && act.value == null && act.el?.options?.length) {
        const { answers } = await this.call({ page, task: { goal }, dropdown: act.el }, { opt: { type: "choice", instructions: "Which option of `dropdown.options` should be chosen for `task.goal`?", criteria: Object.fromEntries(act.el.options.map(o => [o, null])) } });
        act.value = answers.opt.choice; act.valueKey = undefined;
      }
      if (act.tool === "press_key") {
        const { answers } = await this.call({ page: { url: page.url, title: page.title, text: page.text, dialogs: page.dialogs }, task: { goal, history: history.slice(-6) } }, { key: { type: "choice", instructions: "Which keyboard key should be pressed next for `task.goal`?", criteria: Object.fromEntries(KEYS.map(k => [k, null])) } });
        act.key = answers.key.choice;
        const tgt = act.el; if (!tgt || !(FIELDISH(tgt) || tgt.tag.startsWith("input"))) act.target = null;   // page-level key press
      }
      if (act.tool === "drag") {
        const others = page.elements.filter(e => e.i !== act.target).slice(0, MAX_SINGLE);
        if (!others.length) { status = "stuck"; info = "nothing on the page to drop onto"; break; }
        const { answers } = await this.call({ page: { ...page, elements: others }, task: { goal, dragging: brief(act.el) } }, { dest: { type: "choice", instructions: "Onto which entry of `page.elements` (by its `i`) should `task.dragging` be dropped for `task.goal`?", criteria: Object.fromEntries(others.map(e => [String(e.i), null])) } });
        act.destination = +answers.dest.choice;
        r.destination = brief(page.elements.find(e => e.i === act.destination));
      }
      if (act.tool === "webmcp" && !act.args) act.args = await this.webmcpArgs(page, goal, history.slice(-12), act, values);
      if (guarded(act) && !allowIrreversible && a.irreversible.noul >= irreversibleAt) {
        status = "needs_confirmation"; info = "the next action looks hard to undo; call again with allow_irreversible to proceed";
        pending = { action: act.tool, element: actLabel(act), ...(act.argKeys ? { args: act.argKeys } : {}), ...(act.key ? { key: act.key } : {}), p_irreversible: r.irreversible };
        break;
      }

      const h = { action: act.tool, element: actLabel(act) };
      if (act.argKeys && Object.keys(act.argKeys).length) h.args = act.argKeys;
      if (act.tool === "select" && act.value != null) h.option = act.value;
      if (act.valueKey && ["type", "select", "upload"].includes(act.tool)) h.value = act.valueKey;
      if (act.key) h.key = act.key;
      if (r.destination) h.destination = r.destination;
      if (this.highlight && act.target != null) await this.showDecision(act, r).catch(() => {});
      try { r.act_ms = await this.act(act); if (act.result != null) h.result = act.result; }
      catch (e) { h.error = actionError(e); r.error = h.error; log(`  ! ${h.error}`); }
      history.push(h);
      // A modal/banner covers the target: if an uncovered control plainly says "close", dismiss it
      // so the next round can retry (Jev keeps picking the covered target otherwise). At most two
      // attempts per URL; if the target is still covered afterwards, say so in the history.
      if (h.error?.startsWith("click blocked") && (dismissed.get(page.url) ?? 0) < 2) {
        // re-read the page: the overlay often appeared after the snapshot this round decided on
        const now = await this.snapshot().catch(() => null);
        const closer = now && pickCloser(now.elements, now.url);
        if (closer) {
          dismissed.set(now.url, (dismissed.get(now.url) ?? 0) + 1);
          const d = { action: "dismiss_overlay", element: `${closer.tag} "${String(closer.text || closer.label || closer.hint).slice(0, 50)}"` };
          const before = this.page.url();
          try {
            await this.act({ tool: "click", target: closer.i }); await this.settle({ max: 2000 });
            if (this.page.url() !== before) d.navigated = this.page.url();
            else {
              const after = await this.snapshot().catch(() => null);
              const target = after?.elements.find(e => brief(e) === brief(act.el) && (e.near ?? "") === (act.el?.near ?? ""));
              if (target?.covered) d.still_covered = true;
            }
          } catch (e) { d.error = actionError(e); }
          log(`  ~ dismiss_overlay ${d.element}${d.error ? ` ! ${d.error}` : ""}${d.still_covered ? " (target still covered)" : ""}`);
          history.push(d);
        }
      }
      if (this.heldDialog) {
        status = "needs_confirmation"; info = "the action opened a confirmation dialog that looks hard to undo, so it was dismissed; call again with allow_irreversible to accept it";
        pending = { action: h.action, element: h.element, dialog: this.heldDialog.message, p_irreversible: this.heldDialog.p_irreversible };
        break;
      }
    }
    this.shown = page;
    if (this.events.length) history.push(...this.events.splice(0).map(e => ({ event: e })));
    const out = { status, goal, url: this.page.url(), title: await this.page.title().catch(() => ""), actions: history, rounds, jev_calls: this.stats.calls - calls0, ms: Date.now() - t0 };
    if (info) out.info = info;
    if (pending) out.pending = pending;
    out.done_score = +(rounds.at(-1)?.done ?? 0);
    if (!["done", "likely_done"].includes(status)) {
      out.page_text = page?.text?.slice(0, 600);
      if (["ambiguous", "stuck", "max_actions"].includes(status)) out.candidates = rounds.at(-1)?.candidates;
    }
    return out;
  }

  async showDecision(act, r) {
    const label = `${act.tool}${act.valueKey ? ` ← ${act.valueKey}` : ""}${act.key ? ` ${act.key}` : ""}  p=${r.p_target}  done=${r.done}`;
    const loc = this.locate(act.target);
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
    await loc.evaluate((el, label) => {
      const r = el.getBoundingClientRect();
      const box = document.createElement("div");
      box.setAttribute("data-jev-overlay", "");
      Object.assign(box.style, { position: "fixed", left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px`, border: "3px solid #e5484d", borderRadius: "6px", zIndex: 2147483647, pointerEvents: "none" });
      const tag = document.createElement("div");
      tag.textContent = label;
      Object.assign(tag.style, { position: "absolute", left: "-3px", top: r.top > 30 ? "-26px" : `${r.height + 6}px`, background: "#e5484d", color: "#fff", font: "600 12px/1 system-ui", padding: "5px 7px", borderRadius: "4px", whiteSpace: "nowrap" });
      box.appendChild(tag); document.documentElement.appendChild(box);
      setTimeout(() => box.remove(), 1400);
    }, label);
    await sleep(900);
  }

  // WebMCP tools the current page registered (name, description, inputSchema, annotations).
  async webmcpTools() {
    return this.page.evaluate(() => window.__jevWebmcp?.list() ?? []).catch(() => []);
  }

  // Run one of the page's WebMCP tools. The page's own code runs; no Jev call, no element picking.
  async webmcpCall(name, args = {}, { timeout = 30_000 } = {}) {
    const t0 = Date.now();
    const r = await this.runWebmcp(name, args, timeout);
    await this.settle({ max: 4000 });   // a tool may navigate or re-render
    const out = { tool: name, url: this.page.url(), ms: Date.now() - t0 };
    if (r.error) out.error = r.error; else out.result = webmcpText(r.result);
    if (this.events.length) out.events = this.events.splice(0);
    return out;
  }

  async screenshot({ path, fullPage = false } = {}) { return this.page.screenshot({ path, fullPage }); }
  async close() { await this.context.close().catch(() => {}); if (this.ownBrowser) await this.browser.close().catch(() => {}); }
}
