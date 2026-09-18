# Results (2026-09-17)

Model `jev-latest` (resolved to jev-1.13.0). Headless Chromium 1280×800, 3 tasks in parallel.
Commands: `node bench/run.mjs --set all`, `node bench/context-cost.mjs <run.json>`.
A task is **correct** when every step returns its expected status (`done`/`likely_done`, or
`needs_confirmation` for the guard test) and its ground-truth check passes. Tasks built to
fail are correct when no step claims done. **False done** = a step said `done` while its
ground-truth check failed.

## Latest: r10 (after the add-item, overlay and login fixes)

42 tasks (a `login-wall` task was added): **40/42 correct, 0 false done**, 202 Jev calls, 286 ms
average. Misses: `ti-add-remove` stopped at 2 of 3 buttons but returned `likely_done`, not
`done`; `ti-sort-table` is still `stuck`. `todomvc-coarse` and `infinite-scroll` now pass. The
tables below are from the earlier r6/r7 pair (41 tasks) and are kept for comparison.

## Two full runs, same code (r6, r7)

| run | correct | false done | likely_done | Jev calls | avg ms/call | input tokens/call | wall time (41 tasks, 3 parallel) |
|-----|---------|------------|-------------|-----------|-------------|-------------------|------------------|
| r6  | 38/41   | 0          | 0           | 211       | 290         | 2,890             | 251 s            |
| r7  | 38/41   | 0          | 0           | 208       | 299         | 2,801             | 248 s            |

Both runs failed the same 3 tasks, and each of those failures is a known model limit, not a flake:

| task | status | what happened |
|---|---|---|
| todomvc-coarse | stuck | one step with ordered sub-goals (add 2, complete 1, clear); the same actions pass as 5 steps |
| ti-sort-table | stuck | the table was sorted, but nothing marks sort state; Jev can't judge order from rows (0.21) |
| infinite-scroll | stuck | "scroll to load more" has no end point; content did load, `done` swung 0.2↔0.84 |

In r6, 190 rounds: median target confidence 0.97; 7 rounds needed two-stage selection (largest
page 2,273 elements). Actions performed: click 61, type 41, scroll 9, wait 6, select 4,
press_enter 4, and one each of hover, drag, right_click, press_key, upload.

## By category (r6 + r7)

| category | correct | calls/task | s/task |
|---|---|---|---|
| form (login, number, 5-field form as one goal and as 7 steps) | 8/8 | 7.0 | 5.1 |
| widget (select, checkboxes) | 4/4 | 3.0 | 5.4 |
| dynamic (delayed load, enable-then-type, add until 3) | 6/6 | 5.0 | 7.6 |
| spa (TodoMVC by steps / one goal) | 2/4 | 9.5 | 5.2 |
| interaction (hover, JS confirm, delayed modal, sort) | 6/8 | 2.3 | 5.2 |
| navigation (HN, books) | 4/4 | 3.5 | 4.8 |
| large-page (Wikipedia search/link, GitHub tabs/search) | 8/8 | 4.3 | 8.2 |
| e2e (saucedemo checkout by steps / one goal, a private staging login run from tasks.local.mjs) | 6/6 | 12.3 | 13.1 |
| negative (bad password, missing page, disabled field, missing option) | 8/8 | 2.8 | 4.4 |
| iframe (form, jQuery date picker) | 4/4 | 3.3 | 2.8 |
| shadow-dom | 2/2 | 2.0 | 1.1 |
| custom-widget (react-select) | 2/2 | 3.0 | 5.3 |
| tabs (new window) | 2/2 | 2.0 | 4.7 |
| lazy (infinite scroll) | 0/2 | 11.0 | 9.4 |
| actions (drag, right-click, key press, upload) | 8/8 | 2.8 | 4.4 |
| guard (login and form not paused; checkout paused at Finish) | 6/6 | 8.3 | 7.1 |

## Irreversible-action pause

Every round asks `irreversible` (would the next action have a hard-to-undo effect outside the
browser?). In tasks run *without* the pause, the rounds where it would have fired (≥0.6 on a
click/Enter/key) were only:

- r6: saucedemo-fine `Finish` (0.66, 0.77), saucedemo-coarse `Finish` (0.70)
- r7: saucedemo-fine `Finish` (0.77), saucedemo-coarse `Finish` (0.72)

Logins, form submits, "Add to cart", "Checkout", "Continue", upload and drag never reached it.

## Page content the calling LLM reads (estimate)

Playwright-MCP style = one AI aria snapshot (`page.ariaSnapshot({mode: "ai"})`) of the task's
start page per action, plus the initial one. jev-browser = the `browser_do` results. Tokens ≈ characters / 4.

| | total over 40 tasks (r6) | median task |
|---|---|---|
| Playwright-MCP style, to the LLM | ≈557k tokens | — |
| jev-browser, to the LLM | ≈8.3k tokens | 5.4× less |
| read by Jev instead | ≈602k tokens | |

The gap comes from big pages: Wikipedia link (≈149k-token snapshot, ~2,300×), GitHub (~270×),
HN and books (~115–180×). Small test pages save 2–8×. The iframe and shadow-DOM pages
cost *more* (0.3–0.4×), because their snapshots are tiny. This does not measure how many
actions an LLM would take on its own.

## Measured two-sided ledger (2026-09-19)

The section above is an estimate: `bench/context-cost.mjs` measures one aria snapshot on each
task's start page and reuses its size for every action, and it reports Jev's own spend as a
trailing column that is never subtracted from the saving. `bin/jev-cost.mjs` measures every
snapshot, every tool result and every Jev call as it happens, and puts both sides in one table:

```
npm run cost                                    # the two cases below
npm run cost -- --url <url> --goal "<goal>"     # any page
npm run cost -- --json > run.json && npm run cost -- --report run.json
```

Model `jev-latest`, headless Chromium 1280×800, one run, 2026-09-19. **Caller tokens** are the
text crossing the MCP boundary — every tool result plus the arguments the caller had to write —
at chars ÷ 4, an approximation. **Jev tokens** are the API's own `usage.input_tokens`, exact.
`net` = caller tokens saved against the row's baseline − Jev tokens spent, counted one for one;
it is the pessimistic reading, since a Jev token is much cheaper than a caller token.

```
══ saucedemo ══ https://www.saucedemo.com/
   goal: "Log in"   question: "Which usernames can be used to log in, and what is the password?"

group   scenario                                 caller tok  jev tok calls      s   vs base        net
------------------------------------------------------------------------------------------------------
act     playwright-mcp (baseline)                     1,928        —     —   0.05     1.00×          0
open    browser_open                                     86        0     0   1.75         —          —
observe browser_snapshot (baseline)                     110        0     0   0.00     1.00×          0
observe browser_snapshot --interactive                   70        0     0   0.00     1.57×         40
observe browser_snapshot --filter                        95        0     0   0.00     1.16×         15
observe browser_snapshot --urls                         112        0     0   0.00     0.98×         -2
observe browser_snapshot --max-chars 2000               114        0     0   0.00     0.96×         -4
read    browser_read (whole doc) (baseline)             157        0     0   0.00     1.00×          0
read    browser_read (ranked)                           152        0     0   0.00     1.03×          5
act     browser_do                                      110    7,383     4   2.89     17.5×     -5,565
observe browser_snapshot (after action) (baseli…        607        0     0   0.21     1.00×          0
observe browser_act scroll                               45        0     0   0.00         —          —
observe browser_snapshot --diff                          62        0     0   0.01     9.79×        545
------------------------------------------------------------------------------------------------------
TOTAL                                                 3,648    7,383     4   4.93     17.5×     -5,565

  LOSS on this page: browser_do (-5,565 tokens), browser_snapshot --max-chars 2000 (-4),
                     browser_snapshot --urls (-2)

══ wikipedia ══ https://en.wikipedia.org/wiki/Alan_Turing
   goal: "Open the linked article about Bletchley Park"
   question: "What did Alan Turing do at Bletchley Park during the Second World War?"

group   scenario                                 caller tok  jev tok calls      s   vs base        net
------------------------------------------------------------------------------------------------------
act     playwright-mcp (baseline)                   267,662        —     —   0.41     1.00×          0
open    browser_open                                    158        0     0   2.45         —          —
observe browser_snapshot (baseline)                   2,491        0     0   1.21     1.00×          0
observe browser_snapshot --interactive                2,497        0     0   0.12     1.00×         -6
observe browser_snapshot --filter                       805        0     0   0.12     3.09×      1,686
observe browser_snapshot --urls                       2,484        0     0   0.11     1.00×          7
observe browser_snapshot --max-chars 2000               699        0     0   0.11     3.56×      1,792
read    browser_read (whole doc) (baseline)          28,042        0     0   0.05     1.00×          0
read    browser_read (ranked)                         3,270   41,334     4   2.77     8.58×    -16,562
act     browser_do                                       81   44,259     4   8.57     3,304×    223,322
observe browser_snapshot (after action) (baseli…      2,489        0     0   0.10     1.00×          0
observe browser_act scroll                               50        0     0   0.00         —          —
observe browser_snapshot --diff                          67        0     0   0.07     37.1×      2,422
------------------------------------------------------------------------------------------------------
TOTAL                                               310,795   85,593     8  16.11     3,304×    223,322

  LOSS on this page: browser_read (ranked) (-16,562 tokens), browser_snapshot --interactive (-6)
```

The `playwright-mcp` row is one real `page.ariaSnapshot({ mode: "ai" })` per navigation and per
action, taken on the page as it then was. Its Jev columns are `—`: a Playwright-MCP run has no
cheap model, and the Jev calls used here only walked the page into each state (saucedemo 6 calls
/ 9,847 tokens, wikipedia 4 / 44,569) — they are excluded. Its seconds are the measured
snapshot time only; a real run also pays the caller model's own latency, which this cannot
measure, so the number is a floor and not a comparison.

### How this compares to the estimate above

**The caller-side ratio holds up; the conclusion drawn from it does not.** The estimate put the
Wikipedia-link task at ~2,300×; measured, it is 3,304×. That is the same order of magnitude, so
the headline was not inflated by the reuse assumption. What the estimate never did was subtract
Jev's own spend, and once it is subtracted the small-page case is a **loss**: logging in to
saucedemo costs the caller 110 tokens instead of 1,928 — a 17.5× win on the expensive model —
while spending 7,383 tokens on the cheap one, for a net of **−5,565**. On the same page the trade
also costs 2.89 s of `browser_do` against 0.05 s of aria snapshotting.

**Reusing one snapshot size is wrong in both directions, and badly wrong when the page changes.**
The four aria snapshots of the saucedemo walk measured 140, 146, 150 and **1,400** tokens: the
page after login is ten times the login form. The estimate's method (4 × the start page) gives
560 tokens against the measured 1,928 — **3.4× low**. On Wikipedia the same method gives 2 ×
149,370 = 298,740 against the measured 267,662 — **12% high**, because the second page is smaller
than the first.

**`browser_read` is a loss on a long article at today's settings.** Answering from the Alan
Turing page costs the caller 3,270 tokens ranked against 28,042 for the whole document — 8.6×
less — but the ranking spends 41,334 Jev tokens across 4 requests, for a net of **−16,562**. It
is still the right tool when the caller's context is the binding constraint; it is not a saving
in total tokens.

**The new `browser_snapshot` options are free, and only pay on large pages.** On Wikipedia
`--max-chars 2000` is 3.6× cheaper, `--filter` 3.1×, and `--diff` after one scroll 37×; on
saucedemo they move 70–114 tokens and `--urls` and `--max-chars` are a couple of tokens *worse*
than the default. `--interactive` is 1.57× on saucedemo but 1.00× on Wikipedia, where the
element list, not the prose, is what fills the budget. None of them calls Jev.

Two pages is not a benchmark. These numbers say what these two pages cost, not what a median
task costs; run `npm run cost -- --url …` on the page you care about.
