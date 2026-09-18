// Pure helpers over the page model returned by the page script. No browser, no network.

export const FIELDISH = e => !!e && (/^(input:(text|email|password|search|tel|url|number|date|datetime-local|month|week|time|color|range)|textarea)/.test(e.tag) || /\[(textbox|searchbox|combobox)\]/.test(e.tag) || (e.tag.startsWith("div[") && e.value !== undefined));
export const SELECTISH = e => !!e && (e.tag === "select" || !!e.options);
export const FILEISH = e => !!e && e.tag === "input:file";

export function brief(e) {
  if (!e) return "?";
  const name = e.label || e.text || e.placeholder || e.name || e.near || e.href || "";
  return `${e.tag} "${String(name).slice(0, 50)}"`;
}

// Word runs inserted in b relative to a (LCS over words), e.g. "walk the dog", "2 items".
export function insertedText(a, b, max = 300) {
  const A = a.split(" ").slice(0, 600), B = b.split(" ").slice(0, 600), n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const runs = []; let cur = [], i = 0, j = 0;
  while (j < m) {
    if (i < n && A[i] === B[j]) { if (cur.length) { runs.push(cur.join(" ")); cur = []; } i++; j++; }
    else if (i < n && dp[i + 1][j] >= dp[i][j + 1]) i++;
    else { cur.push(B[j]); j++; }
  }
  if (cur.length) runs.push(cur.join(" "));
  return runs.join(" | ").slice(0, max);
}

// What changed between two page models: elements added / removed / changed (value, checked,
// active, sorted), reordering, URL, metrics, and inserted text. Duplicates count (two "Toggle
// Todo" checkboxes are two elements); a change in surrounding text alone is not a change.
export function pageDiff(a, b) {
  if (!a) return undefined;
  const ident = e => `${brief(e)}${e.near && e.near !== (e.label || e.text) ? ` near "${e.near.slice(0, 40)}"` : ""}`;
  const base = e => brief(e);
  const state = e => [e.checked !== undefined ? `checked=${e.checked}` : "", e.value ? `value="${e.value}"` : "", e.active ? "active" : "", e.sorted ? `sorted=${e.sorted}` : ""].filter(Boolean).join(" ");
  const show = e => `${ident(e)}${state(e) ? ` ${state(e)}` : ""}`;
  // pair elements: first same name + same surrounding text, then same name in order.
  // Unpaired ones are added/removed; paired ones may have changed state.
  const left = [...a.elements], d = { added: [], removed: [], changed: [] }, pairs = [], rest = [];
  for (const e of b.elements) {
    const k = left.findIndex(x => ident(x) === ident(e));
    if (k >= 0) pairs.push([left.splice(k, 1)[0], e]); else rest.push(e);
  }
  for (const e of rest) {
    const k = left.findIndex(x => base(x) === base(e));
    if (k >= 0) pairs.push([left.splice(k, 1)[0], e]); else d.added.push(show(e));
  }
  for (const [old, e] of pairs) if (state(old) !== state(e)) d.changed.push(`${ident(e)}: ${state(old) || "(empty)"} -> ${state(e) || "(empty)"}`);
  for (const e of left) d.removed.push(show(e));
  for (const k of ["added", "removed", "changed"]) { if (d[k].length) d[k] = d[k].slice(0, 15); else delete d[k]; }
  if (!d.added && !d.removed) {
    // same elements, different order (drag-and-drop, sorting): show the part that moved
    const ka = a.elements.map(show), kb = b.elements.map(show);
    const first = ka.findIndex((k, i) => k !== kb[i]);
    if (first >= 0 && ka.length === kb.length && !d.changed) {
      let last = ka.length - 1; while (last > first && ka[last] === kb[last]) last--;
      d.reordered = { before: ka.slice(first, Math.min(last + 1, first + 10)), after: kb.slice(first, Math.min(last + 1, first + 10)) };
    }
  }
  if (a.url !== b.url) d.url = `${a.url} -> ${b.url}`;
  for (const k of Object.keys(b.metrics ?? {})) if (a.metrics?.[k] !== b.metrics[k]) (d.metrics ??= {})[k] = `${a.metrics?.[k]} -> ${b.metrics[k]}`;
  const ins = insertedText(a.text, b.text); if (ins) d.new_text = ins;
  return d;
}

export function repeatedElements(elements) {
  const counts = {};
  for (const e of elements) { const k = brief(e); counts[k] = (counts[k] ?? 0) + 1; }
  const rep = Object.entries(counts).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 10);
  return rep.length ? Object.fromEntries(rep) : undefined;
}

// A snapshot is the one observation the calling LLM pays for in full, so rendering it is where
// the cheap, deterministic narrowing lives: everything below only changes what is printed, never
// what was collected, and costs no Jev call.
export const REDACTED = "[redacted]";
export const MAX_CHARS_DEFAULT = 10000;
export const MAX_CHARS_CAP = 20000;
const NARROW_HINT = "narrow with filter, interactive or diff";

const secret = e => e.tag === "input:password" && e.value !== undefined && e.value !== "";

// A snapshot must never echo a typed password back to the caller. Redacting here rather than in
// the collector keeps the page model (and what Jev is shown, which never leaves the process)
// intact, so element matching in currentElement() still sees the real value.
export function redactPage(page) {
  if (!page?.elements?.some(secret)) return page;
  return { ...page, elements: page.elements.map(e => secret(e) ? { ...e, value: REDACTED } : e) };
}

const FILTERABLE = ["label", "text", "placeholder", "name", "href"];

function elementLine(e, urls) {
  const f = [];
  for (const k of ["label", "text", "placeholder", "name"]) if (e[k]) f.push(`${k === "text" ? "" : k + "="}"${e[k]}"`);
  if (e.value !== undefined && e.value !== "") f.push(`value="${e.value}"`);
  if (e.options) f.push(`options=[${e.options.slice(0, 8).join(", ")}${e.options.length > 8 ? ", …" : ""}]`);
  for (const k of ["checked", "disabled", "busy", "expanded", "active", "hidden", "covered"]) if (e[k] !== undefined) f.push(`${k}=${e[k]}`);
  if (e.sorted) f.push(`sorted=${e.sorted}`);
  // href is the largest share of the output on a link-heavy page and the caller acts on element
  // numbers, not URLs, so it is off unless asked for — except when it is the only thing that
  // identifies the element (icon-only links would otherwise render as a bare `[7] a`).
  if (e.href && (urls || !(e.label || e.text || e.placeholder || e.name || e.near))) f.push(`href=${e.href}`);
  if (e.near && !e.text) f.push(`near="${e.near}"`);
  if (e.frame) f.push(`frame=${e.frame}`);
  return `[${e.i}] ${e.tag} ${f.join(" ")}`;
}

const capOf = maxChars => maxChars === Infinity ? Infinity : Math.max(0, Math.min(maxChars ?? MAX_CHARS_DEFAULT, MAX_CHARS_CAP));

// Compact, line-per-element rendering for an LLM that takes over from Jev.
// interactive: drop the page's prose (dialogs stay — they carry the status/error text).
// filter: keep only elements whose label/text/placeholder/name/href contains the substring.
// urls: print href= on every element line (default off).
// maxChars: size of the rendered snapshot, capped at MAX_CHARS_CAP; Infinity for no limit.
export function formatPage(page, { maxElements = 400, interactive = false, filter = "", urls = false, maxChars = MAX_CHARS_DEFAULT } = {}) {
  page = redactPage(page);
  const head = [`url: ${page.url}`, `title: ${page.title}`];
  if (page.dialogs?.length) head.push(`dialogs: ${page.dialogs.join(" || ")}`);
  if (!interactive) head.push(`visible text: ${page.text}`);

  // page.elements is interactive-only by construction (see SEL in page-script.mjs), so `filter`
  // narrows within it rather than re-filtering what is already filtered.
  const needle = String(filter ?? "").toLowerCase();
  const kept = needle ? page.elements.filter(e => FILTERABLE.some(k => String(e[k] ?? "").toLowerCase().includes(needle))) : page.elements;
  const hiddenByFilter = page.elements.length - kept.length;
  head.push(`elements (${kept.length}${hiddenByFilter ? ` of ${page.elements.length}; ${hiddenByFilter} hidden by filter "${filter}"` : ""}):`);

  const rendered = kept.map(e => elementLine(e, urls));
  const fullLen = [...head, ...rendered].join("\n").length;
  const cap = capOf(maxChars);
  const allowed = rendered.slice(0, maxElements);
  let n = allowed.length;
  if (fullLen > cap || n < kept.length) {
    // leave room for the trailer so the result still fits under the cap
    const budget = Math.max(0, cap - 220);
    let used = head.join("\n").length;
    n = 0;
    while (n < allowed.length && used + 1 + allowed[n].length <= budget) { used += 1 + allowed[n].length; n++; }
  }
  const lines = [...head, ...rendered.slice(0, n)];
  if (n < kept.length) lines.push(`… truncated: ${kept.length - n} of ${kept.length} element lines and ${fullLen - lines.join("\n").length} chars dropped; ${NARROW_HINT}, or raise max_chars (now ${cap}, cap ${MAX_CHARS_CAP}).`);
  return lines.join("\n");
}

// Renders what pageDiff() found, for a caller that asked for a diff instead of a whole page.
// Element numbers are deliberately absent: they come from the elements a snapshot lists, and a
// diff lists none, so acting needs a full snapshot.
export function formatDiff(page, d, { maxChars = MAX_CHARS_DEFAULT } = {}) {
  const lines = [`url: ${page.url}`, `title: ${page.title}`];
  if (page.dialogs?.length) lines.push(`dialogs: ${page.dialogs.join(" || ")}`);
  const body = [];
  for (const k of ["added", "removed", "changed"]) if (d[k]?.length) body.push(`${k} (${d[k].length}):`, ...d[k].map(x => `  ${x}`));
  if (d.reordered) body.push("reordered:", `  before: ${d.reordered.before.join(" | ")}`, `  after: ${d.reordered.after.join(" | ")}`);
  if (d.url) body.push(`url changed: ${d.url}`);
  if (d.metrics) body.push("metrics:", ...Object.entries(d.metrics).map(([k, v]) => `  ${k}: ${v}`));
  if (d.new_text) body.push(`new text: ${d.new_text}`);
  lines.push(body.length ? "changes since the previous snapshot:" : "no changes since the previous snapshot.", ...body);
  lines.push("(a diff carries no element numbers; take a snapshot with diff:false to act with browser_act)");

  const cap = capOf(maxChars);
  const text = lines.join("\n");
  if (text.length <= cap) return text;
  const cut = text.slice(0, Math.max(0, cap - 120));
  return `${cut}\n… truncated: ${text.length - cut.length} chars dropped; raise max_chars (now ${cap}, cap ${MAX_CHARS_CAP}).`;
}
