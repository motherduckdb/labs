# Optimization capstone — what moved, what didn't, and every idea dispositioned

Capstone for the Phase-2/3 optimization pass. It (1) states the substrate verdict with
the numbers the session produced, (2) ledgers what shipped, and (3) gives a grounded
disposition for **every** idea in the optimization-loop backlog and the Malloy-knowledge
notes. The throughline: most backlog ideas target **authoring knowledge** or **submission
token cost**, but profiling showed the bottleneck is neither — so several are correct
solutions to a non-dominant problem.

## TL;DR

- **The substrate is barely used; SQL carries the load.** Share-of-logic (authored Malloy
  chars / authored Malloy+SQL) is **config-dependent and often low** — 15% / 87% / 53%
  across three held-out runs — and only **~12–17 of 83 layer views are ever referenced**.
- **Efficiency is tapped without trading accuracy.** Every lever routes through *fewer
  turns* or *smaller prefix*; both are low-yield (the prefix is cross-task cached) or
  accuracy-costly (the author-first A/B: −24% tokens but −5.6 pts).
- **Fixing the layer's defect doesn't move the score.** A full rebuild fixed the c3 AVG
  defect (gate 18→1) but was net-negative (−2 train, dropped the counterfactual surfaces)
  — because the agent routes around the layer via SQL anyway.
- **Net shipped:** steer-instead-of-escalate (PR #74), usage-report (PR #75), unused-tool
  prune (branch). Layer rebuild parked (`docs/layer-rebuild-outcome.md`).

## 1. The substrate verdict (quantified)

| metric | finding | source |
|---|---|---|
| share-of-logic | 15% (2334Z) · 87% (1819Z) · 53% (0155Z) — **config-dependent**, often SQL-dominated | usage-report |
| view utilization | **12–17 of 83** views ever referenced (86% dead weight) | usage-report |
| answer mix | sql 57% / authored 32% / view-selection 11% (2334Z) | usage-report |
| view-selection cost | the **most expensive** answer path (99k tok vs authored 84k), **not** more accurate (91% vs 96%) | answer-path economics |
| prompt-token composition | **static prefix 68%** (skill 4.3k + primer 2.1k + glossary 2.2k + tools ~1k), get_file 15%, list_views 10%; run_malloy/query echoes ~1–3% | per-tool token attribution |
| cost composition | cache-write ~46% · cache-read ~31% · output ~22% (cache hit ~89% on sonnet) | JSONL cache fields |
| escalation rescue | opus-vs-sonnet-fixer indistinguishable; the steer (opus-free) matched at lower cost | 3-arm A/B |
| layer rebuild | fixes the AVG defect (gate 18→1) but **net −2 train**; full regen is **lossy** (dropped counterfactuals) | rebuild + train smoke |

## 2. Session ledger

| change | status |
|---|---|
| steer-instead-of-escalate (opus-free in-place steer) | **PR #74** (pushed) |
| usage-report (substrate-value metrics) | **PR #75** (pushed) |
| drop unused MCP tools (`list_databases`, `ask_docs_question`) | committed, `agentic-malloy-prune-unused-mcp-tools` (unpushed) |
| author-first skill A/B | parked (−5.6 pts; load-bearing browse) |
| layer rebuild `a2a8a381` | parked, `agentic-malloy-layer-rebuild` (net-negative; `docs/layer-rebuild-outcome.md`) |

## 3. Optimization-loop backlog — every idea dispositioned

| # | idea | status / finding |
|---|---|---|
| 1 | **Malloy MCP** | **Not pursued.** Knowledge-access lever, but authoring isn't the bottleneck — the SQL escape-hatch proof (cheap model transcribed the *same* wrong recipe into SQL) shows knowledge isn't the gap. |
| 2 | **Enforce linter before submit** (so the model gets fixed Malloy back) | **Already shipped.** `lintMalloy` runs before every compile/run/submit (`tools.ts`); the *fixed* source is what compiles, and the applied fixes are surfaced to the model. |
| 3 | **"fix Malloy" tool / incremental submission** (write-to-file, edit) | **Not pursued — premise off.** `submit_answer` already takes only the per-query `source` (not a "full model"), and `get_file` is cached (re-reads stub). Token attribution: submission/run_malloy echoes are **~1%** — the saving is negligible. |
| 4 | **Validate the linter runs when building** | **Confirmed shipped.** The 2A build gates (`layerSourceGate`) run in the build loop and feed findings back to the builder (`layer-build.ts:473`); every view is compiled+executed by the P0 gate. |
| 5 | **List-views tool** | **Shipped (#71) — but a net cost.** view-selection is the *most expensive* path, not more accurate; the catalog browse is paid by **83% of tasks for an 11% payoff**, and the catalog can misroute (root-cause §4). Built ≠ beneficial. |
| 6 | **LSP (Malloy VS Code)** | **Not pursued.** Heavy lift; authoring competence isn't the gap. Lowest ROI on the list. |
| 7 | **Malloy docs tool** (git/scrape/SQLite-search; use in builder+eval) | **Not pursued as a tool.** Over-engineered for the observed need; the lightweight version — a curated mental-model + cookbook + error recipes baked into the **primer/skill** — covers it without a tool or extra round-trips (see §5). |
| 8 | **Recommend smaller Malloy files** | **Low priority / cautionary.** The rebuild *did* restructure files and the lesson was the opposite risk: full regen is **lossy**. Modularity guidance in the build prompt is fine but won't move the metric. |
| 9 | **More succinct list-files; why list_files runs 3×** | **Characterized, minor.** The "3× browse" is the wasted-exploration pattern — 72% of tasks browse `list_views`/`get_file` without using a view. Real, but the bigger story is the prefix (68%); succinct list-files is a small lever. The author-first A/B tested skipping the browse (−24% tok / −5.6 pts). |
| 10 | **More linter rules: reorder sources; where→having** | **where→having already shipped** (linter rule 7c, auto-split). **reorder-sources** not built — cosmetic, no correctness/cost value. |
| 11 | **Reduce overfitting: builder refactor/summarize pass** | **Risky, not pursued.** The rebuild shows a from-scratch refactor is lossy (drops capabilities). The no-leakage + train-gate constraints already guard overfitting. |
| 12 | **error_recipe_lookup tool (code→recipe; "Idea #2")** | **Partially shipped, not as a tool.** The triggers are a *small recurring set* of compile errors; the right home is the **skill/primer** (and the `stuckAuthorSteer` already feeds recipe-like guidance on the 2-consecutive-error trigger — PR #74). A separate deterministic tool is lower-value than inlining the recipes (§5/§6). |
| 13 | **Compress the compiler output** (`{code, one-line, 3 lines, recipe}`) | **Low token value, modest friction value.** Compiler-error echoes are ~1% of tokens, so compression saves little; the *recipe* attached to the error (from §6) is what would cut error loops — and that belongs in the skill, not the wire format. |

## 4. The finding that recontextualizes the list

Items 1, 3, 6, 7, 12, 13 are all **authoring-knowledge or submission-token** levers. The
session's evidence says both are non-dominant:

- **Authoring isn't the gap** — the agent authors competently; when Malloy fights it, it
  bails to SQL and is *fine* (sql path ~89% accurate). More Malloy knowledge/tooling
  wouldn't change the misses, which are semantic (AVG-vs-SUM) or convention, not syntax.
- **Submission/error tokens are ~1–3%** — the token cost is the **static prefix (68%)** and
  the **get_file/list_views browse (25%)**, neither of which these ideas touch.

So the backlog's center of gravity is mis-aimed at the measured bottleneck. The levers that
*are* real — prefix size and turn count — are the ones we found are either cached-cheap or
accuracy-costly to pull. That's why "efficiency is tapped."

## 5. The Malloy-knowledge notes (mental model · cookbook · error recipes)

These are **good content in the wrong container**. The mental model (§1), pattern cookbook
(§5), and error-recipe table (§6) should live in **`docs/malloy/malloy-primer.md` +
`src/skill.md`** (the answer-time context), not a docs tool — the author model then has them
inline with zero round-trips. Caveat from the token attribution: the prefix is already 68%
of prompt volume, so additions must earn their keep; it's cross-task **cached** (cheap
reads), so ~1–2k of high-value recipe content is affordable if it cuts error loops.

**§6 recipes mapped to current coverage** (so we add only what's missing):

| recipe | current coverage |
|---|---|
| `Illegal reference, query expected` (`run: src`) | **auto-fixed** — linter prefixes bare pipelines with `run:` |
| `select-of-view` / `group-by-aggregate` (select in a reduction) | **auto-fixed** — linter splits `select:`→`group_by:`+`aggregate:` (rule 7d) + skill rules |
| `aggregate-in-where` → `having:` | **auto-fixed** — linter rule 7c |
| `function-not-found` for list fns (`list_contains`/`len`) | **auto-fixed** — linter adds `!boolean`/`!number` raw-escape |
| `restricted-construct-forbidden` / raw `duckdb.sql(...)` | **handled** — rejected + steered to `submit_sql` |
| `field-not-found` (`'X' is not defined`) | **partial** — `stuckAuthorSteer` says "don't guess; call `list_columns`" (PR #74); not mechanical |
| `invalid-symmetric-aggregate` (bare `max()`/`min()` needs arg/path) | **not covered** — the *rebuild itself* hit this (c4); good candidate for a new lint or a primer recipe |
| `Unsupported keyword 'as'` (SQL aliasing) | **not covered** — trivially mechanical (`as`→`is`); add a lint rule |
| fanout (`Cannot compute <fn> across join_many`) | **primer covers join_many**; not mechanical — keep as a primer recipe |
| `output-name-conflict`, `join-with-without-primary-key`, `no-matching-function-overload`, ANTLR `no viable alternative` | **not covered** — judgment-needed; fold the §6 rows into the primer |

**Actionable residue from §5/§6 (small, general, allowed):** (a) add two mechanical lint
rules — `as`→`is` and bare `max()/min()` → require an arg/path; (b) fold the
not-auto-fixed §6 rows + the §1 mental model into the primer as a condensed recipe block.
Both are cheap and substrate-general. Neither will move the headline score (the misses
aren't syntax), but they cut authoring friction/turns.

## 6. Residual work (all optional — the experiment is well-characterized)

1. **Surgical c3 fix** (instead of the lossy full regen): a targeted `layer-improve` edit
   that adds a SUM/total-fee ACI surface + fixes meta routing **without** dropping the
   counterfactual sources. Fixes the substrate honestly; **won't move the score** (SQL
   masks it).
2. **Fold §1/§6 into the primer + 2 mechanical lint rules** (§5 above) — cheap friction win.
3. **Decide the open PRs/branches** — merge #74 (steer) + #75 (usage-report); fold the
   tool-prune in; the layer-rebuild branch stays parked as a documented dead-end.

The honest bottom line: the substrate's value isn't being realized — SQL + a tuned skill
carry the benchmark, the layer is mostly unused, and the remaining levers are either
cached-cheap, accuracy-costly, or score-neutral. This is a natural stopping point.
