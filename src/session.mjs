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
import { ENUMERATE } from "./page-script.mjs";
import { FIELDISH, SELECTISH, FILEISH, brief, pageDiff, repeatedElements, formatPage, formatDiff, redactPage } from "./page-model.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
// `back` is not offered to Jev (it proposed it after successful steps); callers can still use it via act().
export const KEYS = ["Escape", "Tab", "Space", "Backspace", "Delete", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageDown", "PageUp", "Home", "End"];
const TARGETED = new Set(["click", "type", "press_enter", "select", "hover", "right_click", "drag", "upload"]);
const GUARDED = new Set(["click", "press_enter", "press_key"]);
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

export class JevBrowser {
  // userDataDir -> persistent profile (logins survive restarts); browser -> share one Chromium.
  // highlight -> outline each target with Jev's decision before acting (for watching a headed run).
  static async launch({ headed = false, slowMo = 0, viewport = { width: 1280, height: 800 }, storageState, browser, userDataDir, highlight = false } = {}) {
    let context, own = false;
    try {
    if (userDataDir) {
      context = await chromium.launchPersistentContext(userDataDir, { headless: !headed, slowMo, viewport });
    } else {
      own = !browser;
      browser ??= await chromium.launch({ headless: !headed, slowMo });
      context = await browser.newContext({ viewport, storageState });
    }
    } catch (e) {
      if (/Executable doesn't exist|browserType\.launch/i.test(String(e.message)) && /install/i.test(String(e.message))) throw new Error("Chromium for Playwright is not installed. Run: npx playwright install chromium");
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
    const track = r => ["fetch", "xhr", "document"].includes(r.resourceType()) && this.inflight.set(r, Date.now());
    const untrack = r => this.inflight.delete(r);
    context.on("request", track); context.on("requestfinished", untrack); context.on("requestfailed", untrack);
    context.on("page", p => { if (this._page && p !== this._page) { this.events.push(`new tab opened: ${p.url()}`); this.page = p; } });
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

  async open(url) {
    const t0 = Date.now();
    await this.page.goto(url, { waitUntil: "commit", timeout: 30_000 });
    await this.page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    await this.settle();
    return { url: this.page.url(), title: await this.page.title(), ms: Date.now() - t0 };
  }

  async snapshot() {
    const main = this.page.mainFrame();
    const frames = [main, ...main.childFrames().filter(f => !f.isDetached())];
    let start = 0; const elements = []; let base; this.frames = new Map();
    for (const [n, f] of frames.entries()) {
      let r;
      try { r = await f.evaluate(ENUMERATE, { start, frame: n || undefined }); } catch { continue; }
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
    const prev = this.shown;
    const page = await this.snapshot();
    this.shown = page;
    if (!diff) return formatPage(page, render);
    // redact before diffing: state() in pageDiff prints value=, which would leak a typed password
    const d = pageDiff(redactPage(prev), redactPage(page));
    if (!d) return `(no previous snapshot to diff against; showing the full page)\n${formatPage(page, render)}`;
    return formatDiff(page, d, render);
  }

  async call(state, questions) {
    const r = await jev(state, questions);
    this.stats.calls++; this.stats.jev_ms += r.ms; this.stats.tokens += r.tokens;
    return r;
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

  async decide(page, goal, values, history, lastChange) {
    const task = { goal, ...(Object.keys(values).length ? { values } : {}), history, ...(lastChange ? { last_change: lastChange } : {}) };
    const withValues = Object.keys(values).length ? ", with the given `task.values`" : "";
    const common = {
      done: { type: "noul", instructions: `Does \`page\` show that \`task.goal\` has been achieved${withValues}? Judge from \`page.text\` and \`page.elements\`.` },
      done_change: { type: "noul", instructions: `Does \`page\` show that \`task.goal\` has been achieved${withValues}? Judge from \`page.text\`, \`page.elements\` and \`task.last_change\` (what the last action changed).` },
      blocked: { type: "noul", instructions: "Is there something on `page` that stops progress on `task.goal` and cannot be handled by clicking or typing (captcha, access denied, error page)?" },
      error: { type: "noul", instructions: "Does `page` show an error or rejection message (e.g. invalid credentials, a validation error, not found) caused by the actions in `task.history`?" },
      login: { type: "noul", instructions: "Is `page` a sign-in or sign-up screen, or asking the user to log in, before `task.goal` can continue?" },
      irreversible: { type: "noul", instructions: "Would the next action toward `task.goal` on `page` have an effect outside this browser that is hard to undo, such as placing an order, paying, sending a message, deleting data or publishing?" },
      tool: { type: "choice", instructions: "What is the next action toward `task.goal` on `page`, given what `task.history` already did?", criteria: TOOLS },
    };
    if (Object.keys(values).length) common.value = { type: "choice", instructions: "If the next action toward `task.goal` types, selects or uploads something, which of `task.values` should it use? Prefer values not yet entered on `page`.", criteria: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v).slice(0, 200)])) };
    const targetQ = { type: "choice", instructions: "Which entry of `page.elements` (by its `i`) should the next action toward `task.goal` act on?" };

    if (page.elements.length <= MAX_SINGLE && JSON.stringify(page).length <= MAX_STATE_CHARS) {
      targetQ.criteria = Object.fromEntries(page.elements.map(e => [String(e.i), null]));
      const r = await this.call({ page, task }, { ...common, ...(page.elements.length ? { target: targetQ } : {}) });
      return { ...r.answers, stages: 1 };
    }
    // Two stages: groups of consecutive elements, then elements in the likeliest groups.
    const groups = [];
    for (let k = 0; k < page.elements.length; k += GROUP) {
      const els = page.elements.slice(k, k + GROUP);
      groups.push({ g: groups.length, summary: els.map(e => (e.label || e.text || e.placeholder || e.href || e.tag).slice(0, 24)).join(" | ").slice(0, 700) });
    }
    const lite = { url: page.url, title: page.title, text: page.text, metrics: page.metrics, dialogs: page.dialogs, groups };
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
    return { ...r1.answers, target: r2.answers.target, stages: 2, groups_considered: pick };
  }

  // Resolve independent tool/target/value answers into one consistent action.
  resolve(page, a, values) {
    let tool = a.tool.choice;
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
      case "scroll": await this.page.mouse.wheel(0, 700); break;
      case "wait": await sleep(1000); break;
      case "back": await this.page.goBack({ timeout: 10_000 }).catch(() => {}); break;
      case "none": break;
      default: throw new Error(`unknown action ${act.tool}`);
    }
    return Date.now() - t;
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
    this.dialogPolicy = acceptDialog ? ACCEPT_DIALOGS : SAFE_DIALOGS;
    let ms;
    try { ms = await this.act({ tool: action, target: el?.i, value, key, destination: dest }); }
    finally { this.dialogPolicy = SAFE_DIALOGS; }
    await this.settle();
    const events = this.events.splice(0);
    return { action, element: brief(el), ms, url: this.page.url(), title: await this.page.title().catch(() => ""), ...(events.length ? { events } : {}) };
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
    const history = []; const rounds = [];
    let prevPage = null, waits = 0, page = null, status = "max_actions", info, pending, retried = false;
    const seen = new Map();
    this.promptText = values.prompt;
    for (let round = 0; round <= maxActions; round++) {
      await this.settle();
      page = await this.snapshot();
      if (this.events.length) history.push(...this.events.splice(0).map(e => ({ event: e })));
      const a = await this.decide(page, goal, values, history.slice(-12), round ? pageDiff(prevPage, page) : undefined);
      prevPage = page;
      const act = this.resolve(page, a, values);
      const done = Math.max(a.done.noul, a.done_change?.noul ?? 0);
      const r = {
        round, done: +done.toFixed(2), done_plain: +a.done.noul.toFixed(2), done_change: +(a.done_change?.noul ?? 0).toFixed(2),
        blocked: +a.blocked.noul.toFixed(2), error_shown: +a.error.noul.toFixed(2), login: +a.login.noul.toFixed(2), irreversible: +a.irreversible.noul.toFixed(2),
        tool: act.tool, p_tool: +act.p_tool.toFixed(2), target: act.target, p_target: +act.p_target.toFixed(2), el: brief(act.el),
        value: act.valueKey, elements: page.elements.length, stages: a.stages, candidates: act.candidates,
      };
      rounds.push(r);
      log(`  r${round}: ${act.tool}(${r.p_tool}) -> #${act.target} ${r.el} (${r.p_target})${act.valueKey ? ` value=${act.valueKey}` : ""}  done=${r.done} err=${r.error_shown} login=${r.login} irrev=${r.irreversible}  [${page.elements.length} els${a.stages === 2 ? ", 2-stage" : ""}]`);

      if (round > 0 && done >= doneAt && done < 0.85 && act.tool !== "none") {
        // "done" and "next action" disagree: settle it with a stricter single question
        const c = await this.call({ page, task: { goal, history: history.slice(-12) } }, { complete: { type: "noul", instructions: "Is everything `task.goal` asks for already finished on `page`, so that no further action (such as pressing a submit, search or continue button) is needed?" } });
        r.confirm = +c.answers.complete.noul.toFixed(2);
        log(`     confirm=${r.confirm}`);
        if (r.confirm >= 0.65) { status = "done"; break; }
        if (r.confirm >= 0.45) { status = "likely_done"; info = "the page looks done but Jev is unsure; verify with a check, snapshot or screenshot"; break; }
        if (a.irreversible.noul >= irreversibleAt && GUARDED.has(act.tool)) {
          // the goal looks mostly done and the next step is hard to undo: stop rather than overstep
          status = "done"; info = "stopped before an action that looks irreversible and may go beyond this goal";
          pending = { action: act.tool, element: brief(act.el), p_irreversible: r.irreversible };
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
      if (TARGETED.has(act.tool) && act.p_target < minTarget) { status = "ambiguous"; info = "target confidence too low; refine the goal or act on a candidate directly"; break; }
      const seenKey = `${act.tool}|${brief(act.el)}|${["type", "select", "upload"].includes(act.tool) ? act.valueKey : ""}|${page.url}|${page.text}|${JSON.stringify(page.elements)}`;
      seen.set(seenKey, (seen.get(seenKey) ?? 0) + 1);
      if (seen.get(seenKey) >= 3) { status = "stuck"; info = "repeating the same action on the same page without progress"; break; }
      const seq = [...history.filter(h => h.action).map(h => `${h.action}|${h.element}|${h.value ?? ""}`), `${act.tool}|${brief(act.el)}|${["type", "select", "upload"].includes(act.tool) ? act.valueKey ?? "" : ""}`];
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
      if (GUARDED.has(act.tool) && !allowIrreversible && a.irreversible.noul >= irreversibleAt) {
        status = "needs_confirmation"; info = "the next action looks hard to undo; call again with allow_irreversible to proceed";
        pending = { action: act.tool, element: brief(act.el), ...(act.key ? { key: act.key } : {}), p_irreversible: r.irreversible };
        break;
      }

      const h = { action: act.tool, element: brief(act.el) };
      if (act.tool === "select" && act.value != null) h.option = act.value;
      if (act.valueKey && ["type", "select", "upload"].includes(act.tool)) h.value = act.valueKey;
      if (act.key) h.key = act.key;
      if (r.destination) h.destination = r.destination;
      if (this.highlight && act.target != null) await this.showDecision(act, r).catch(() => {});
      try { r.act_ms = await this.act(act); }
      catch (e) { h.error = actionError(e); r.error = h.error; log(`  ! ${h.error}`); }
      history.push(h);
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

  async screenshot({ path, fullPage = false } = {}) { return this.page.screenshot({ path, fullPage }); }
  async close() { await this.context.close().catch(() => {}); if (this.ownBrowser) await this.browser.close().catch(() => {}); }
}
