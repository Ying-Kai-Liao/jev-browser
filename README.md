# jev-browser

Browser automation where an LLM plans and **Jev** decides.

> Unofficial project, not affiliated with TypeSafe. It calls the TypeSafe System One API
> with your own API key.

The calling LLM (Claude, via MCP) says what outcome it wants, one step at a time, and hands
over any text to type. For each round of a step, code describes the page. Then one ~300 ms
[Typesafe System One](https://docs.typesafe.ai) request asks Jev several questions at once:
which element, which action, which value, and is the step done / blocked / showing an error /
about to do something irreversible. Playwright performs the action. The LLM never reads page
snapshots unless it chooses to take over.

```
Claude ── browser_do("Log in", {email, password}) ──▶ jev-browser
                                                       │  loop until done / stuck / needs confirmation
                                                       │   1. settle   (network + DOM quiet)
                                                       │   2. describe (elements, labels, state, visible text, diff, counts)
                                                       │   3. Jev      (done? error? irreversible? tool? target? value?)
                                                       │   4. act      (Playwright)
Claude ◀── { status: "done", url, actions[], done_score } ─┘
```

https://github.com/user-attachments/assets/2e688df9-4985-4854-8ebe-ba97c9d13d68

Jev only answers with probability distributions: yes/no (`noul`), pick one option (`choice`)
or a rating (`score`). It never writes text. So everything free-form comes from the caller as
candidates, and code turns disagreement or low confidence into a status the LLM can act on.

## Results

42 tasks in 16 categories on live sites (see [RESULTS.md](RESULTS.md)):

- **40/42 correct in the latest run, 0 false "done" claims** (38/41 twice before the latest
  fixes). Remaining misses: counting ("add until 3", flagged `likely_done`) and verifying a sort.
- **~300 ms per Jev call**, 2–4 calls for most steps; a 5-step checkout takes ~14 s end to end.
- **Pause before irreversible actions**: across ~200 rounds it flagged only saucedemo's
  "Finish" (place order) button.
- **Less page content for the LLM** than a Playwright-MCP-style loop on the same tasks
  (estimate): median 5× per task, ≈8k vs ≈557k tokens in total. Big pages dominate the total:
  a Wikipedia article is ~149k snapshot tokens. On tiny pages there is no saving. The page
  reading moves to Jev.

Works on: forms, native and custom dropdowns, checkboxes and radios (including styled
replacements), dynamic loading, modals, JS dialogs, hover, right-click, drag and drop, key
presses, file upload, iframes, shadow DOM, new tabs, pages with 2,000+ elements (two-stage
selection), and non-English UIs.

Known limits, so write steps around them:
- **Ordered sub-goals in one step** ("add two todos, complete one, clear completed") → split
  into one outcome per step.
- **Open-ended goals** ("scroll to load more") → make them measurable or check yourself.
- **Judgements that compare many values** (is this table sorted, did exactly one thing change)
  → verify with `browser_check` or `browser_snapshot`.

## Quick start (MCP, from npm)

```bash
npx playwright install chromium          # once
claude mcp add jev-browser -e TYPESAFE_API_KEY=your-key -- npx -y -p jev-browser jev-browser-mcp
```

Any MCP client works the same way: command `npx`, args `-y -p jev-browser jev-browser-mcp`,
env `TYPESAFE_API_KEY`. Add `JEV_BROWSER_HEADED=1` to watch it work.

## Setup (from source)

```bash
git clone https://github.com/Ying-Kai-Liao/jev-browser && cd jev-browser
npm install
npm run setup                    # downloads Chromium for Playwright
cp .env.example .env             # add TYPESAFE_API_KEY
npm test                         # offline tests (no network, no key)
npm run test:e2e                 # MCP server end to end (network + key)
```

### Use from Claude Code (MCP, from source)

```bash
claude mcp add jev-browser -- node /absolute/path/to/jev-browser/bin/jev-browser-mcp.mjs
```

From a source checkout the server reads `TYPESAFE_API_KEY` from the repo's `.env`.

| tool | purpose |
|---|---|
| `browser_open(url)` | navigate and wait for the page to settle |
| `browser_do(goal, values?, max_actions?, allow_irreversible?, explain?)` | work toward one outcome; returns a status |
| `browser_check(question)` | yes/no about the page → `p_yes` |
| `browser_choose(question, options)` | pick among given options → distribution |
| `browser_snapshot(diff?, interactive?, filter?, urls?, max_chars?)` | compact numbered element list, for taking over; the options below narrow it |
| `browser_act(action, element, value?, key?, destination?, accept_dialog?)` | act on an element directly, no model; confirm/prompt dialogs are dismissed unless `accept_dialog` |
| `browser_read(question, max_chars?)` | the page text that helps answer a question; Jev drops the rest |
| `browser_screenshot(full_page?)` | PNG image |
| `browser_close()` | end the session |

### Reading a page: `browser_read`

`browser_snapshot` is the take-over-and-act surface: numbered elements, plus the text **in the
viewport**. That is the right trade for acting, and it is already small (99–6,900 tokens on
every page measured, because elements are capped at 400 and the text at 2,500 chars). It is a
poor way to *read*, though — a Wikipedia article is ~179k chars of text, so a snapshot shows
about 1.4% of it and the rest costs a scroll-and-snapshot loop.

`browser_read(question)` is the understand-the-content surface. Code extracts the whole
document's text and cuts it at headings and sections; Jev rates every block against the
question in batches of 40; code returns the blocks that help, in document order, inside a
character budget. Jev ranks, it never writes — the text you get back is the page's own.

| | `browser_snapshot` | `browser_read` |
|---|---|---|
| gives you | numbered elements + viewport text | document text relevant to a question |
| use it to | act (with `browser_act`) | read, quote, answer |
| model calls | none | 1 per ~50k chars, ~1 s each |
| lossless | yes | no — drops blocks, and says which |

**When it pays.** Long articles, documentation and reference pages. On the WW2 article,
"When and why did Japan surrender?" returned 11.8k of 178.5k chars — 15× less — in 3.4 s over
5 Jev calls, keeping the atomic-bomb and surrender paragraphs.

**When it doesn't.** Short pages, apps and forms. Below a 8,000-char floor (and below your own
`max_chars`) it returns the page whole and never calls Jev at all, because paying ~1 s to prune
a 2k-token page is a loss. Hacker News, a BBC front page and saucedemo all land under the floor.

It is **biased to keep**: a block Jev cannot rate — or a whole batch whose request failed — is
kept, and whatever is left out is counted and marked in place with `[… N blocks dropped …]`.
Nothing is ever silently cut. Use `browser_snapshot` if you need the page as the caller
normally sees it.

```bash
node examples/read-demo.mjs                                   # WW2 article, default question
node examples/read-demo.mjs "https://…" "what do you want?"   # needs a key
```

`browser_do` statuses:

| status | meaning / what the caller should do |
|---|---|
| `done` | goal reached |
| `likely_done` | the page looks done but Jev is unsure: verify before moving on |
| `needs_login` | a sign-in wall and no credentials in `values`; log in yourself (headed + `JEV_BROWSER_PROFILE`) or pass credentials |
| `needs_confirmation` | next action, or a confirm dialog it opened (then dismissed), looks irreversible (order, pay, send, delete); see `pending`, re-call with `allow_irreversible: true` only if the user wants it |
| `error` | the page shows an error after the last action (e.g. wrong password); see `page_text` |
| `stuck` / `max_actions` | no progress; see `info`, `page_text`, `candidates` |
| `ambiguous` | low confidence in the target; pick from `candidates` with `browser_act` |
| `blocked` | captcha, access denied, error page |

`browser_snapshot` options. A snapshot is the one page the calling LLM reads in full, so every
option narrows what gets rendered. All of them are pure formatting: nothing is collected
differently and none of them costs a Jev call.

| option | default | effect |
|---|---|---|
| `diff` | `false` | only what changed since the previous snapshot, using the same diff the `browser_do` loop feeds Jev. With no previous snapshot you get a full one and a note saying so. A diff carries no element numbers: take a full snapshot to act. |
| `interactive` | `false` | drop the `visible text:` block; element lines and dialog/status text stay. The element list is interactive-only already, so this narrows the prose, not the elements. |
| `filter` | — | keep only elements whose label, text, placeholder, name or href contains the substring, case-insensitive; the header says how many were hidden |
| `urls` | `false` | print `href=` on element lines. **Off by default** — on a link-heavy page link targets are the largest single share of the output, and `browser_act` takes element numbers, not URLs. A link with nothing else to identify it keeps its href. |
| `max_chars` | `10000` | size of the rendered snapshot, hard cap 20000. When it truncates, the last line says how many element lines and characters were dropped and which option would narrow it. |

A typed password is never printed: `input:password` values render as `[redacted]`, in a snapshot
and in a diff. Measured on a Wikipedia article (1,840 elements), a default snapshot went from
26,919 to 9,926 characters (~6,700 → ~2,500 estimated tokens); `filter` brings it to ~800 and
`diff` after a scroll to ~50.

Env: `JEV_BROWSER_HEADED=1` shows the browser, `JEV_BROWSER_PROFILE=/dir` keeps a persistent
profile (logins survive restarts), `JEV_BROWSER_LOG=1` prints per-round decisions to stderr.

### Library

```js
// npm install jev-browser && npx playwright install chromium
import { JevBrowser } from "jev-browser";

const b = await JevBrowser.launch({ headed: true });
await b.open("https://www.saucedemo.com/");
await b.do("Log in", { values: { username: "standard_user", password: "secret_sauce" } });
await b.do("Add the Sauce Labs Backpack to the cart");
const p = await b.check("Does the cart badge show 1 item?");   // 0..1
await b.close();
```

### Watch it

```bash
node examples/x-profile-demo.mjs     # headed, read-only x.com walkthrough with decision highlights
```

Each action is outlined in red with Jev's choice and scores before it happens (`highlight: true`,
on by default in the MCP server when `JEV_BROWSER_HEADED=1`). Some sites, x.com included, serve a
blank page to headless Chromium: use headed mode there.

### CLI

```bash
node bin/jev-browser.mjs do https://the-internet.herokuapp.com/login "Log in" username=tomsmith 'password=SuperSecretPassword!'
node bin/jev-browser.mjs run examples/flows/todomvc.json --headed
```

## Writing good steps

- One observable outcome per step: "Log in", "Open the Pull requests tab", "Mark 'buy milk' completed".
- Every string goes in `values` with a meaningful key (`email`, `postal_code`, `file`).
- Treat `likely_done`, `needs_confirmation`, `ambiguous` and `stuck` as your turn: check,
  snapshot or ask the user, don't just retry.
- After steps with side effects, `browser_check` what must *not* have changed.

## Cost: what the caller pays and what Jev spends

`bin/jev-cost.mjs` measures both sides of the trade this project claims to make, on a page you
name. Every snapshot, every tool result and every Jev call is measured as it happens — nothing
is measured once and multiplied.

```bash
npm run cost                                              # the built-in saucedemo + wikipedia cases
npm run cost -- --url https://example.com/ --goal "Log in" --value user=ada --value pw=secret
npm run cost -- --json > run.json                         # machine-readable
npm run cost -- --report run.json                         # re-print the table from a saved run
node bin/jev-cost.mjs --help                              # every flag
```

Per scenario it reports **caller tokens** (the text crossing the MCP boundary: every tool result
plus the arguments the caller had to write, at chars ÷ 4 — an approximation, and the report says
so), **Jev tokens and calls** (the API's own `usage.input_tokens`, exact), and wall-clock
seconds. The scenarios are run on the same page toward the same goal so they compare: a
Playwright-MCP-style baseline that takes a fresh `page.ariaSnapshot({ mode: "ai" })` after every
action, `browser_do`, each `browser_snapshot` option against the default, and `browser_read`
against dumping the whole document.

The `net` column is caller tokens saved minus Jev tokens spent, one for one, and it goes negative
when a scenario loses — on a small page Jev's spend and latency can outweigh the saving, and the
tool prints that as a loss. Measured numbers and what they say about the older estimate are in
[RESULTS.md](RESULTS.md).

A run needs network and `TYPESAFE_API_KEY`, and costs API credits. `npm test` stays offline: the
ledger arithmetic is pure and tested in `test/cost.test.mjs`.

## Benchmark

```bash
node bench/run.mjs --set all            # base, hard, guard (+ bench/tasks.local.mjs if present)
node bench/run.mjs --only ti-login,drag
node bench/context-cost.mjs bench/results/<run>.json   # older one-sided estimate; see npm run cost
```

Private sites and credentials go in `bench/tasks.local.mjs` (git-ignored), exporting `LOCAL`.

## Layout

```
src/session.mjs      JevBrowser: settle, snapshot, decide (1 or 2 stages), resolve, act, do, check, choose
src/page-script.mjs  runs in each frame: elements, labels, state, visible text, metrics, dialogs
src/page-model.mjs   pure helpers: diff between pages, counts, compact rendering
src/prune.mjs        pure helpers: split page text into blocks, batch, rank, reassemble
src/jev.mjs          System One API client
src/flow.mjs         JSON flow runner
bin/                 CLI and MCP server
bin/jev-cost.mjs     two-sided token ledger: caller tokens vs Jev tokens, measured per scenario
bench/               tasks with ground-truth checks, runner, context-cost estimate
test/                offline fixture tests, MCP end-to-end test
NOTES.md             design notes: what works with Jev, what doesn't, and why
```

## Releasing

CI runs the offline tests on every push and pull request. To publish, bump the version and push
the tag; `.github/workflows/release.yml` tests, publishes to npm with provenance and creates a
GitHub release:

```bash
npm version patch            # or minor / major: commits and tags vX.Y.Z
git push --follow-tags
```

Publishing uses npm trusted publishing, set up once with
`npx npm@latest trust github jev-browser --file release.yml --repo Ying-Kai-Liao/jev-browser --allow-publish`.

## License

MIT
