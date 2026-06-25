# Would a Malloy MCP change the result? No — and what the actual lever is

Follow-on to `RESULTS.md`. Research only; nothing was run.

**TL;DR.** The experiment found agent-authored Malloy loses to tuned markdown+SQL
on every axis (accuracy, tokens, authoring reliability). Routing Malloy through an
official MCP would not change that. The cost isn't in the tooling around
generation — it's in the generation target itself. The lever is the agent's
**output language**.

## Why not the MCP

The hypothesis was that a purpose-built MCP offers better agent-facing tooling
(source introspection, compile + validation with good errors, run/preview) and
that authoring friction sank the substrate. But `src/tools.ts` already provides
all three — `list_malloy_files`/`get_file`, `malloy_lint`, `run_malloy` — backed
by the same `@malloydata/malloy` compiler the MCPs use. PLAN.md says it outright:
"compile-error feedback is the substitute."

Of the three real servers, `publisher` is the most capable (mature, headless,
MotherDuck-attachable; its one genuine upgrade is error text rewritten as
field-aware suggestions). `malloyyo` — the repo named in the brief — is early and
serves its model over an OAuth web endpoint, wrong for a batch eval. But the
capability gap is small either way, because better error phrasing sits *downstream*
of the model's mistake. It can't close a 29-point gap.

## The lever: a SQL prior, negatively transferred

The agent's errors aren't confusion. They're SQL habits applied to Malloy:

- `select` in a grouping query (Malloy needs `group_by:` + `aggregate:`)
- `calculate:` for a sum (that's a window op)
- an aggregate in `where:` instead of `having:`
- function-call casts instead of `field::type`

A model fluent in SQL writes SQL-shaped Malloy that looks right and compiles to
nonsense. The surface is close enough to invite transfer; the rules differ enough
to punish it. The compiler names every one of these, and the agent repeats them
anyway, because it's fighting its own prior.

That mechanism explains the whole matrix:

- gemini collapses (70%) — weakest Malloy prior, worst transfer
- premium survives but loses (88%) — better prior, still taxed
- the baseline is near-perfect at the **same cheap model** (99.8%) — it answers in
  SQL, which is native

Same model, same data, same tuned knowledge layer. The only variable is the
language the agent has to emit.

## What would actually move it

1. **Keep Malloy, but *select* views instead of authoring them.** Malloy's real
   asset is reuse: the fee logic encoded once in named views. If the agent's job
   were "pick the right view, add one `+ {where}`" rather than compose from
   scratch, the error-prone surface shrinks. This is the one place an MCP helps
   (Publisher's `getContext` aids view discovery), but it's bounded by Malloy reuse
   traps — e.g. a view's `order_by` is silently dropped under `+ {limit}`. Real
   points, not parity.
2. **Keep the Malloy layer for knowledge, answer in SQL.** Likely recovers most of
   the accuracy and the 2.5× token gap. But it's a different experiment: roughly
   the baseline's recipe with a Malloy layer in place of markdown.
3. **Template hardening.** T02 is 19 of 49 premium misses. This is what
   `layer-improve` already does; it caps near 93%, short of the baseline's 99.8%.
4. **Retrieval instead of whole-file `get_file` dumps.** Attacks the token axis
   only, not accuracy.

## The uncomfortable part

The experiment's own finding already said it: the substrate is the bottleneck, not
the model. Every fix that keeps the rule "the answer must be Malloy" is bounded
below the baseline, because that rule *is* the cost. The only lever that reaches
parity relaxes it. So the experiment was, in effect, a clean measurement of how
expensive it is to make an LLM answer in a language it wasn't steeped in — a useful
result, just not the one the hypothesis was after.
