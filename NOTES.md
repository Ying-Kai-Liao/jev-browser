# jev-browser: design notes

Started 2026-09-16 in Jev-playground, moved to this repo 2026-09-17. `src/session.mjs` drives a real browser. Code reads the page, Jev makes each small decision,
Playwright acts. Claude (or any LLM) hands it one goal at a time. The benchmark is in
`bench/` (`node bench/run.mjs --set all`); current numbers are in RESULTS.md.

## Verdict

Jev is a good companion model for the *perceive-and-pick* half of browser work. It answers
several questions about a page in ~300 ms. Its probabilities are reliable enough to act on
without a second check. It is a poor planner and it cannot write text. So the split that
works is:

| who        | owns                                                                   |
|------------|------------------------------------------------------------------------|
| Claude     | the plan (one outcome per step), every string to type, what to do when Jev reports it can't |
| Jev        | per-round choices: which element, which action, which value, done / error / blocked |
| code       | describing the page, waiting for pages to settle, loop limits, deltas and counts, typing |

From Claude's side, working with it feels like handing off to a fast, literal junior. I say
"log in with these values" and get back `done` plus where I ended up. I never read a page
snapshot. What I need most from it is an **honest status**, even more than speed. After the
fixes below it never reported a false "done" in the last two full runs. The main friction
is that Jev can't explain itself. When something fails, the round-by-round log of
probabilities is the only way to find out why, so keep that log.

## Round 1 numbers (Jev-playground, before this repo)

36 tasks across 14 categories: forms, widgets, dynamic pages, a single-page app,
hover/confirm dialogs/modals, big pages (Wikipedia, GitHub), iframes, shadow DOM, a React
dropdown, new tabs, infinite scroll, two end-to-end checkouts, a private staging login, and 6 tasks
built to fail.

| run      | what changed                                                    | correct | false "done" |
|----------|-----------------------------------------------------------------|---------|--------------|
| v2-run1  | general rewrite (settle, labels, values, 2-stage, sessions)     | 20/26   | 2            |
| v2-run2  | + checkbox text, images/headers, counts, error stop, cycles, real typing | 25/26 | 0      |
| v2-run3/4| same code, repeated                                             | 25/26   | 0            |
| v3-run1  | + 10 hard tasks, viewport text, metrics, sort state             | 33/36   | 1            |
| v3-run2  | + confirm question when answers disagree, transparent checkboxes | 34/36  | 0            |

v3-run2 in detail: **181 Jev calls averaging 305 ms and 2.7k input tokens each**. Jev is 25% of
wall time; the rest is page loading and settling. Median confidence in the chosen element is 0.97.
Two-stage selection handled a 2,265-element page. Typical tasks take 2–4 calls and 1–8 s;
a 5-step checkout takes 14–18 calls and 13–19 s.

## What it's good at

- **Picking the element.** Right element on everything from 4-element forms to Wikipedia
  articles, including iframes and shadow DOM (once code lists those elements).
- **Matching given values to fields.** One goal "Log in" or "fill in the checkout" plus a
  `values` dict. Jev picks field + value each round. A 5-field form plus a radio button plus
  submit worked as a single goal.
- **Judging state from visible evidence**: logged in, modal closed, option chosen, result
  appeared, new tab open. Over 556 rounds, `done ≥ 0.85` never appeared on an unfinished page.
- **Knowing it can't.** Drag-and-drop, right-click, file upload, a nonexistent page, a disabled
  field and a wrong password all ended as `stuck` or `error`, never `done`.
- **Linear multi-page flows even as one goal.** "Log in, buy the backpack, complete checkout"
  passed in 14 calls, because each page only allows the next step.

## Where it breaks

- **Ordered sub-goals whose evidence disappears.** "Add two todos, complete one, clear
  completed" failed in every run: it can't plan or track which sub-step it is on. The same
  actions as 5 separate steps pass. Claude must break these goals down.
- **Open-ended goals.** "Scroll to load more" has no stopping point: `done` swings 0.2↔0.84
  until the action limit. Make it measurable instead.
- **Comparing many values**: is this table sorted, are there exactly 3 of X, did anything else
  change. It said "done" with 2 of 3 elements until code added `repeated_elements` counts. It
  couldn't confirm a sort without a sort marker. It checked a second todo it wasn't asked to and
  didn't notice.
- **Missing information in the page description.** 8 of the ~11 fixes this session were
  code gaps in how the page is described, not Jev mistakes:
  - a login form not yet loaded when first read
  - checkbox names given as loose text instead of labels
  - transparent styled checkboxes
  - images and `<th>` headers not listed
  - text that wasn't in view
  - no sort markers
  - no counts
  - date pickers undoing Playwright's `fill`

## Design rules

1. **Jev decides; it never generates.** Anything free-form comes in as candidates. A "tool
   call" is one question per argument in a single request (`choice` for enums and candidate
   strings, `noul` for booleans). Code assembles the JSON, and every field gets its own confidence.
2. **One request per round, many questions**: `done`, `done_change`, `error`, `blocked`, `tool`,
   `target`, `value`. Fan-out is cheap; separate calls aren't.
3. **Options are plain indices; the objects live in `state` in page order.** Neighbouring
   elements give context (from the earlier grounding experiment).
4. **Short, plain instructions.** Adding "filling in a form is not the same as submitting it"
   dropped a true-done from 0.70 to 0.54. Two wordings asked side by side and max-combined
   beat one clever wording.
5. **Disagreement between answers is the uncertainty signal.** When `done` is 0.5–0.85 but
   `tool` still proposes an action, ask one stricter question ("…no further action such as
   pressing a submit/search button is needed?"). This fixed the GitHub false "done":
   the confirmation scored 0.06, the controller clicked Search, and "done" then reached 0.94.
6. **Give Jev summaries code can compute, not raw lists to compare**: `last_change` (elements
   added/removed, URL, new text), `metrics` (page height, text length, element count),
   `repeated_elements` counts, `sorted`, `checked`, `disabled`, `busy`.
7. **Show what a person would see.** Real labels (`<label>`, `aria-labelledby`, adjacent text),
   text in view rather than the first N characters, open dialogs listed separately.
8. **Code owns timing.** Settle = no fetch/XHR in flight + no DOM mutation for 400 ms (8 s cap).
   Also give Jev a `wait` action for spinners.
9. **Code owns loop safety.** Cycle detection over (page, action), stop on `error ≥ 0.7`,
   max actions, and `type` with nothing to type turns into a click.
10. **Return distributions, not guesses.** Low element confidence means `status: ambiguous`
    plus the top 3 candidates, so Claude resolves it.

## Interface for Claude (recommended)

```
open(url)                          -> { url, title }
do(goal, values?)                  -> { status: done|likely_done|needs_confirmation|error|stuck|blocked|ambiguous|max_actions,
                                        url, actions[], page_text?, candidates? }
check(question)                    -> probability          # verify side effects, read state
choose(question, options)          -> { choice, probabilities }
read(question, {budgetChars})      -> { content, kept_blocks, dropped_blocks, … }   # read a long page
```

Guidance for the planner writing goals:
- One observable outcome per step ("Mark 'buy milk' completed", not "…and then clear").
- Put every string in `values`; name the keys meaningfully (`email`, `postal_code`).
- Make open-ended goals measurable ("until at least 3 new paragraphs are shown").
- After steps with side effects, `check()` what must *not* have changed.
- Treat `stuck`/`error`/`ambiguous` as the point where Claude takes over, not a crash.

## Round 2: standalone repo (2026-09-17)

Built: the MCP server with a persistent session, drag / right-click / key press / upload, the
irreversible-action pause, `likely_done`, offline fixture tests and a context-cost estimate.
Current result: 38/41 in two identical runs, 0 false "done" claims (RESULTS.md). What we learned:

11. **Ask the risky question in the same fan-out, and gate in code.** `irreversible` costs one
    more noul per round. At ≥0.6 on a click/Enter/key, it flagged only "Finish" (place order)
    across ~200 rounds. Logins, submits, "Add to cart" and "Continue" stayed ≤0.23.
12. **A step can overstep into the next one.** "Fill in checkout info and continue" landed on the
    order overview, and Jev couldn't recognise that as the end (confirmation 0.18–0.43 with every
    wording tried, including naming the button). The fix was a code rule, not a prompt: when
    `done` is mid-range, the confirmation says no, and the proposed action is irreversible →
    stop, report the step done, and list the action as `pending`.
13. **Some uncertainty can't be tuned away, so surface it.** Accepted confirmation scores of
    0.51–0.57 were wrong 3 times and 0.59–0.60 right twice. No threshold separates them, so
    0.45–0.65 now returns `likely_done` and the caller verifies.
14. **Mention `values` in the done question, but only when there are values, and not in the
    confirmation.** "Add a todo item" + `{todo: "walk the dog"}` added the todo five times until
    `done` said "…with the given `task.values`" (0.38 → 0.52). Adding the same clause when no
    values exist made "add until 3" flaky. Adding it to the confirmation broke logins (the
    values vanish after success: 0.13) and GitHub search (0.06 → 0.52, a false done).
15. **Don't offer actions a step rarely needs.** Jev proposed `back` right after successful
    logins (0.49–0.64) and looped. Removing it from Jev's options fixed that; the caller can still
    use it via `browser_act`.
16. **Loop guards need the right unit.** The same action on an unchanged page (3×), a repeated
    2–3-action block (3×, needs different actions inside), and one action repeated (8×). The first
    single-action limit (5) cut off legitimate scrolling.
17. **Show order changes.** After drag-and-drop the page has the same elements in a new order, so
    the change summary looked empty and `done` stayed at 0.27. With a `reordered` before/after entry,
    drag passes.
18. **Row context belongs in the change summary.** A new todo shows up as another `Toggle Todo`
    checkbox; only its `near` text says "walk the dog".
19. **Two element-listing fixes found by fixture tests, not the benchmark:** surrounding-text lookup
    skipped parents shorter than the element's own label, and broken images render 18 px tall
    (the size rule is right to drop them).
20. **The calling LLM reads far less.** Per task the median is 5× less page content than a
    Playwright-MCP-style loop; on big pages it's 100–2,000×. Jev reads a similar amount instead,
    at ~300 ms per call.

## Round 3: real sites and flaky steps (2026-09-17)

21. **The change summary was actively misleading on the flaky add-item step.** The typed value
    showed up as "removed", elements whose surrounding text changed showed up as removed and
    added again, and word-level new text lost repeated words ("walk dog"). After pairing
    elements (name + surrounding text, then name alone), reporting value/check edits as `changed`,
    and diffing text as phrases, `done` for the second added todo went 0.29 → 0.59 and the step
    passed 5/5 with no re-typing. The "not done" states stayed ≤0.23.
22. **When Jev picks "no action" after acting and `done` is only 0.35–0.5, the goal was reached** in
    every saved case (5/5), so that now returns `likely_done` instead of `stuck`.
23. **Login walls need their own status.** On x.com logged out, "open Following" led to X's login page, then
    to "Continue with Google" and Google's sign-in tab. A `login` noul plus "no credentials in
    `values`" now returns `needs_login` before any click (1–2 calls).
24. **Modals aren't always marked up as dialogs.** X's log-in modal is a full-screen fixed `div`.
    Code now hit-tests each on-screen element (`covered: true`), reports large fixed overlays as
    dialogs, and turns Playwright's "intercepts pointer events" into "click blocked by an overlay".
    With that, Jev closed the modal with Escape by itself and finished the step.
25. **Headless can be blocked silently.** x.com renders nothing in headless Chromium, and settling
    reports the empty page as quiet after 0.7 s. Use headed mode for such sites; `open()` doesn't detect this yet.

## Round 4: reading a page, not acting on it (2026-09-19)

The question was whether Jev could do content *structuring* or content *pruning*. Jev never
generates text, so structuring is out: it can rank, filter and classify into a fixed
code-supplied taxonomy, and nothing else. Pruning is in. The measurement came first, because
the honest answer might have been "not worth it".

**What `browser_snapshot` actually costs today** (1280×800, chars → tokens at /4):

| page | elements | snapshot chars | snapshot tokens | `page.text` | whole document |
|---|---|---|---|---|---|
| Wikipedia, *World War II* | 4,545 | 27,653 | 6,913 | 2,432 | 179,208 chars (44.8k tok) |
| MDN, *Using the Fetch API* | 212 | 14,978 | 3,745 | 1,365 | 15,256 chars (3.8k tok) |
| Wikipedia search results | 66 | 6,617 | 1,654 | 1,487 | 5,626 chars (1.4k tok) |
| Hacker News front page | 227 | 17,007 | 4,252 | 2,417 | 3,957 chars (1.0k tok) |
| BBC News front page | 117 | 9,666 | 2,417 | 738 | 7,996 chars (2.0k tok) |
| saucedemo (control) | 3 | 396 | 99 | 160 | 161 chars (40 tok) |

26. **The snapshot is already small, so there is nothing there worth pruning.** 99–6,913 tokens
    across every page measured, and that is structural: `formatPage` caps elements at 400 and
    `page.text` at 2,500 chars. Asking Jev to shrink that would cost 700 ms–1.5 s to save a few
    thousand tokens. **Do not prune the snapshot.**
27. **The gap is the other 98% of the document.** On the WW2 article the snapshot shows 2,432 of
    179,208 chars — 1.4%. A caller who wants to *read* the page has no way to get the rest except
    scroll-and-snapshot, which is ~74 rounds at 6.9k tokens. So `browser_read` ranks the full
    document text, which `browser_snapshot` never had, rather than re-cutting what it already has.
28. **The threshold: rank only above 8,000 chars of extracted text, and only above the caller's
    own budget.** Under either, the whole page is already about the size a pruned one would be,
    and the round trip is pure loss. Hacker News (3.8k), the BBC front page (7.9k) and saucedemo
    (0.2k) all fall below it and come back whole with no Jev call; the WW2 article (178.5k) and
    the MDN page (15.1k) are ranked.
29. **One noul per block, 40 blocks per request.** 191 blocks of the WW2 article took 5 requests
    and 3.3 s (36–46k state chars, 11–21k input tokens each). One request per block would have
    been 191 round trips. Same lesson as rule 2: fan-out is cheap, separate calls are not.
30. **The scores separate cleanly, and they sit low.** For "When and why did Japan surrender?":
    p50 = 0.07, p90 = 0.25, max = 0.99, with the surrender paragraphs at 0.93–0.99 and the nav
    chrome and footer at 0.02. Two other question/page pairs behaved the same (MDN POST body:
    p50 0.14, top 0.88; WW2 casualties: p50 0.05, top 0.97). These are not calibrated around
    0.5, so a 0.5 cut would be a *strict* filter, not a neutral one.
31. **Keep at ≥ 0.35 — bias to keep.** A wrongly dropped block is invisible to the caller, the
    same class of failure as a false `done`, and this project has held 0 false-done across its
    bench. 0.35 sits well below the relevant band and above the p90 tail: 12 blocks / 11.8k chars
    kept out of 178.5k, 15×. Anything unscored — a block the gate skipped, or a whole batch whose
    request failed — is kept, never dropped.
32. **Split quality was most of the work, and three bugs were only visible on real pages.**
    (a) Wikipedia wraps every `<h2>` in its own small `<div>`, so a container that fits in one
    block still has to be descended into when it holds a heading, or the section path never
    advances past the title. (b) `innerText` falls back to `textContent` on an element that is
    not rendered, so a `display:none` subtree comes back as readable text even though
    `body.innerText` excludes it; an unrendered element has no client rects, which is the test
    that works (`checkVisibility()` is not — it calls MDN's `<main>` invisible although that
    element holds the whole article, which silently cost 14k of MDN's 15k chars). (c) SVG and
    MathML keep their tagName's case and have no `innerText` at all.
33. **Report the loss in two kinds.** "not relevant" (Jev ranked it out) and "over budget" (it
    lost to a better-scoring block) are different problems for the caller: the second is fixed by
    raising `max_chars`. Gaps are marked in place with `[… N blocks / M chars dropped …]` so a
    missing passage is never a silent truncation.
34. **A new tool, not a flag on `browser_snapshot`.** `browser_snapshot` is the take-over-and-act
    surface and has to stay lossless — dropping an actionable element there would break the
    caller. Keeping the two apart removes that failure mode by construction.

Not done: structuring. Jev cannot emit a heading, a summary or a schema, and a fixed taxonomy
over blocks was not worth its complexity until something asks for it.

## Next

- Try it as a real Claude Code MCP server on everyday tasks and log where Claude has to take over.
- Ordered sub-goals: let the caller pass `goal` as a list and have code walk it, asking Jev
  "which of these is the first not yet done?" (a choice Jev handles well) instead of one long goal.
- Verification for comparisons (sorted, exactly one changed): code-computed facts in state
  (column order, a list of what changed) rather than asking Jev to compare.
- Calibration: log (probability, outcome) pairs from real use to tune `doneAt`, the confirmation
  band and `irreversibleAt` on more than a few dozen samples.
- Cross-origin iframes that Playwright can't evaluate in, canvas apps, and captchas are out of scope.
