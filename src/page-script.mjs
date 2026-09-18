// Runs inside each frame. Lists interactive elements in DOM order, tags each with data-jev-i,
// and returns what a person would see: labels, state, viewport text, open dialogs, page metrics.
// Must stay self-contained: Playwright serialises it into the page.
export const ENUMERATE = ({ start, frame }) => {
  const SEL = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=menuitem], [role=menuitemcheckbox], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=option], [role=combobox], [role=textbox], [role=searchbox], [role=slider], [contenteditable=""], [contenteditable=true], [onclick], [oncontextmenu], [ondblclick], [draggable=true], [tabindex]:not([tabindex="-1"])';
  const clean = (s, n = 80) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const all = [];
  const walk = root => { for (const el of root.querySelectorAll("*")) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
  walk(document);
  for (const el of all) if (el.hasAttribute("data-jev-i")) el.removeAttribute("data-jev-i");

  const visible = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    // transparent checkboxes/radios/file inputs are usually styled replacements that still take clicks
    return st.visibility !== "hidden" && st.display !== "none" && (+st.opacity > 0.05 || /^(checkbox|radio|file)$/.test(el.type));
  };
  const byIds = ids => clean((ids || "").split(/\s+/).map(id => document.getElementById(id)?.innerText).filter(Boolean).join(" "));
  const sibText = el => {
    let t = "";
    for (let n = el.nextSibling; n && t.trim().length < 40; n = n.nextSibling) {
      if (n.nodeType === 1 && n.matches("input, select, textarea, button, br, label, div, p, li")) break;
      t += n.textContent;
    }
    return clean(t, 60);
  };
  const labelOf = el => clean(byIds(el.getAttribute("aria-labelledby")) || [...(el.labels || [])].map(l => l.innerText).join(" ") || el.getAttribute("aria-label") || "");

  const out = []; let i = start; const seen = new Set();
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    let pick = el.matches(SEL);
    if (!pick && !["html", "body", "label", "svg", "path"].includes(tag) && el.parentElement) {
      // JS-bound clickables (div/span/th with a click handler) usually show a pointer cursor
      const cur = getComputedStyle(el).cursor;
      pick = cur === "pointer" && getComputedStyle(el.parentElement).cursor !== "pointer" && !el.closest("a, button, [role=button]");
    }
    // table headers (often sortable) and sizeable images (hover targets, image links' content)
    if (!pick && (tag === "th" && el.closest("thead") || tag === "img" && !el.closest("a, button"))) {
      const r = el.getBoundingClientRect(); pick = tag === "th" || (r.width >= 24 && r.height >= 24);
    }
    if (!pick || el.closest('[aria-hidden="true"], [inert], [data-jev-overlay]')) continue;
    const type = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : null;
    let hit = el;
    let hidden = false;
    if (!visible(el)) {
      // custom checkboxes/radios hide the real input behind a visible label;
      // file inputs are often display:none behind a styled button but still accept files
      const lab = (type === "checkbox" || type === "radio") && [...(el.labels || [])].find(visible);
      if (lab) hit = lab;
      else if (type === "file") hidden = true;
      else continue;
    }
    // visible() keeps styled checkbox/radio replacements on purpose, but the real input
    // often cannot take the click itself: opacity:0 under its own label, or the 1px
    // clip-rect "visually hidden" recipe with the swatch container painted on top.
    // The label is the real control in both cases, so act on it.
    if (hit === el && (type === "checkbox" || type === "radio")) {
      const st = getComputedStyle(el), r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const top = cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight ? document.elementFromPoint(cx, cy) : null;
      const unclickable = +st.opacity <= 0.05 || r.width <= 2 || r.height <= 2
        || st.clip !== "auto" || st.clipPath !== "none"
        || (top && top !== el && [...(el.labels || [])].some(l => l === top || l.contains(top)));
      if (unclickable) { const lab = [...(el.labels || [])].find(visible); if (lab) hit = lab; }
    }
    if (seen.has(hit)) continue; seen.add(hit);

    const role = el.getAttribute("role");
    const o = { i };
    o.tag = type ? `input:${type}` : (role && !["a", "button", "select", "textarea"].includes(tag) ? `${tag}[${role}]` : tag);
    if (frame) o.frame = frame;
    if (hidden) o.hidden = true;
    const isField = ["input", "select", "textarea"].includes(tag) || ["textbox", "searchbox", "combobox"].includes(role) || el.isContentEditable;
    if (isField) {
      const label = labelOf(el); if (label) o.label = label;
      const ph = el.getAttribute("placeholder"); if (ph) o.placeholder = clean(ph, 60);
      if (!label && !ph && el.name) o.name = el.name;
      if (tag === "select") {
        o.value = clean(el.selectedOptions?.[0]?.text, 40);
        o.options = [...el.options].slice(0, 25).map(op => clean(op.text, 30));
      } else if (type === "checkbox" || type === "radio") {
        o.checked = el.checked;
        if (!o.label && hit !== el) o.label = clean(hit.innerText);
        if (!o.label) { const t = sibText(el); if (t) o.label = t; }
        if (el.value && el.value !== "on") o.value = clean(el.value, 30);
      } else if (["submit", "button", "reset"].includes(type)) {
        o.text = clean(el.value || label);
      } else {
        const v = el.isContentEditable && tag !== "input" ? el.innerText : el.value;
        if (v) o.value = clean(v, 60);
      }
      const list = el.getAttribute("list"); if (list) o.suggestions = [...(document.getElementById(list)?.options || [])].slice(0, 10).map(op => op.value);
    } else {
      const img = el.querySelector("img[alt], svg title");
      const text = (tag === "img" ? clean(el.getAttribute("alt")) : clean(el.innerText)) || labelOf(el) || clean(el.getAttribute("title")) || clean(img?.getAttribute?.("alt") || img?.textContent);
      if (text) o.text = text;
      const label = labelOf(el); if (label && label !== text) o.label = label;
    }
    const href = el.getAttribute("href");
    if (href && !href.startsWith("javascript")) {
      try { const u = new URL(href, location.href); o.href = clean(u.origin === location.origin ? u.pathname + u.search + u.hash : u.href, 80); } catch { o.href = clean(href, 80); }
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") o.disabled = true;
    if (el.getAttribute("aria-busy") === "true") o.busy = true;
    const srt = el.getAttribute("aria-sort") || String(el.className?.baseVal ?? el.className ?? "").match(/sort\w*?(asc|desc|up|down)/i)?.[1];
    if (srt && srt !== "none") o.sorted = /asc|up/i.test(srt) ? "ascending" : /desc|down/i.test(srt) ? "descending" : srt;
    if (el.hasAttribute("aria-expanded")) o.expanded = el.getAttribute("aria-expanded") === "true";
    if (el.getAttribute("aria-checked")) o.checked = el.getAttribute("aria-checked") === "true";
    if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current") || el.getAttribute("aria-pressed") === "true" || /\b(selected|active)\b/.test(el.className?.baseVal ?? el.className ?? "")) o.active = true;

    // short surrounding text for icon-only / generic / field controls
    const own = o.text || o.label || o.placeholder || "";
    if (own.length < 16 || isField) {
      let p = hit.parentElement;
      for (let k = 0; p && k < 5; k++, p = p.parentElement) {
        const t = clean(p.innerText, 400);
        if (t && t !== own) { if (t.length <= 100) o.near = t; break; }
      }
      const row = hit.closest("li, tr, [role=row], [role=listitem]");
      const m = row?.className && String(row.className.baseVal ?? row.className).match(/\b(completed|done|selected|active|checked|disabled|error|expanded)\b/i);
      if (m) o.row_state = m[1];
    }
    // covered: something else (a modal, overlay, banner) is on top of the element's center
    const rr = hit.getBoundingClientRect(), cx = rr.left + rr.width / 2, cy = rr.top + rr.height / 2;
    if (!hidden && cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) {
      const top = (hit.getRootNode()?.elementFromPoint ? hit.getRootNode() : document).elementFromPoint(cx, cy);
      if (top && top !== hit && !hit.contains(top) && !top.contains(hit) && !(top.tagName === "LABEL" && top.control === el)) o.covered = true;
    }
    hit.setAttribute("data-jev-i", String(i));
    out.push(o); i++;
  }
  const dlg = [...document.querySelectorAll('dialog[open], [role=dialog], [role=alertdialog], [aria-modal="true"]')].filter(visible).map(d => clean(d.innerText, 400)).filter(Boolean);
  // overlays that aren't marked up as dialogs: a fixed layer covering most of the viewport at its center
  for (let n = document.elementFromPoint(innerWidth / 2, innerHeight / 2); n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    const st = getComputedStyle(n), r = n.getBoundingClientRect();
    if ((st.position === "fixed" || st.position === "sticky") && r.width * r.height >= 0.6 * innerWidth * innerHeight) {
      const t = clean(n.innerText, 400);
      if (t && !dlg.includes(t)) dlg.push(t);
      break;
    }
  }
  // text the user can currently see, in DOM order
  let seenText = "";
  if (document.body) {
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange(); const vh = innerHeight;
    for (let n = tw.nextNode(); n && seenText.length < 2500; n = tw.nextNode()) {
      if (!n.textContent.trim() || !n.parentElement || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(n.parentElement.tagName)) continue;
      range.selectNodeContents(n); const r = range.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh || r.width === 0) continue;
      seenText += " " + n.textContent;
    }
    seenText = clean(seenText, 2500);
  }
  const full = document.body?.innerText ?? "";
  return {
    url: location.href, title: document.title,
    text: seenText,
    metrics: { scroll_y: Math.round(scrollY), page_height: document.documentElement.scrollHeight, text_length: full.length },
    dialogs: dlg, elements: out, next: i,
  };
};


// Runs inside each frame. The whole document's readable text, cut at structural boundaries
// (headings, sections, list items, table rows, paragraphs) so each piece can be judged on its
// own. ENUMERATE's `text` is viewport-only by design; this is everything a reader would scroll
// through, which is what `browser_read` has to rank. Oversized leaves and runs of tiny blocks
// are left for normalizeBlocks() in src/prune.mjs, so the splitting rules stay offline-testable.
// Must stay self-contained: Playwright serialises it into the page.
export const EXTRACT_BLOCKS = ({ maxBlock = 1200, maxChars = 400_000, frame } = {}) => {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "OBJECT", "AUDIO", "VIDEO"]);
  const clean = s => (s || "").replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const blocks = [];
  const path = [];                       // current heading path, indexed by heading level - 1
  let chars = 0, truncated = false;

  const emit = (text, tag) => {
    if (!text) return;
    if (chars >= maxChars) { truncated = true; return; }
    const section = path.filter(Boolean).join(" > ");
    blocks.push({ text, tag, ...(section ? { section } : {}), ...(frame ? { frame } : {}) });
    chars += text.length;
  };

  const walk = el => {
    if (chars >= maxChars) { truncated = true; return; }
    // SVG and MathML keep their tagName's original case and have no innerText at all
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag) || typeof el.innerText !== "string" || el.closest('[aria-hidden="true"], [inert]')) return;
    // innerText falls back to textContent on an element that is not rendered, so a display:none
    // subtree would come back as readable text even though body.innerText (and therefore
    // metrics.text_length) leaves it out. An unrendered element has no client rects; the
    // display:contents exception is rendered through its children and must still be walked.
    // checkVisibility() is not usable for this: it calls MDN's <main> invisible although that
    // element holds the whole article.
    if (!el.getClientRects().length && getComputedStyle(el).display !== "contents") return;

    const h = /^H([1-6])$/.exec(tag);
    if (h) {
      const t = clean(el.innerText).slice(0, 200);
      const lvl = +h[1];
      path.length = lvl - 1;
      path[lvl - 1] = t;
      emit(t, "heading");
      return;
    }
    // textContent is a free size proxy; innerText (which costs layout) is only taken once we
    // have decided this element is a block rather than a container to descend into. A small
    // container still has to be descended into when it wraps a heading (Wikipedia puts every
    // <h2> in its own div), otherwise the heading path never advances past the title.
    if (el.textContent.length <= maxBlock && !el.querySelector("h1, h2, h3, h4, h5, h6")) { emit(clean(el.innerText), tag.toLowerCase()); return; }

    const kids = [...el.children].filter(c => !SKIP.has(c.tagName.toUpperCase()));
    if (!kids.length) { emit(clean(el.innerText), tag.toLowerCase()); return; }
    // Loose text nodes between element children are content too, and would be lost otherwise.
    let loose = "";
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { loose += n.textContent; continue; }
      if (n.nodeType !== 1) continue;
      const t = clean(loose); loose = "";
      if (t) emit(t, "text");
      walk(n);
    }
    const t = clean(loose);
    if (t) emit(t, "text");
  };

  if (document.body) walk(document.body);
  return {
    url: location.href, title: document.title,
    blocks, truncated,
    total_chars: document.body?.innerText?.length ?? 0,
  };
};
