/**
 * Gemini dive-guide supplement.
 *
 * The dive-authoring guide is served by the MotherDuck MCP as
 * `get_dive_guide({client})`. mdw-turbo runs on Gemini 3 Flash, where fetching
 * the stock guide and passing it through once produced a persistent 30-42%
 * failure rate on `save_dive` / `update_dive` / `edit_dive_content` (their
 * issue #149). quackbot originally worked around that by intercepting
 * `get_dive_guide` on Gemini profiles and returning a ~40K-token local override
 * (the full guide re-ordered Gemini-first plus two full reference dives).
 *
 * Phase 0 of MCP_MIGRATION_PLAN.md (2026-07-23) found the stock
 * `client:'other'` guide had since absorbed almost all of that override
 * (useSQLQuery/@motherduck/react-sql-query, the full REQUIRED_DATABASES section,
 * the N() helper, the phase model, the design system). Phase 3 then benchmarked
 * three arms through the real agentic loop on the forced Gemini model
 * (scripts/bench-dive-guide.ts, 27 runs against prod):
 *
 *   - stock alone dropped `REQUIRED_DATABASES` on 5/9 runs;
 *   - stock + this supplement kept it on 9/9 with the best first-attempt save
 *     success (7/9) and the fewest retries;
 *   - the full override matched on REQUIRED_DATABASES but had the WORST
 *     first-attempt success (4/9) and ~2.6× the prompt-token cost.
 *
 * So the override was replaced by "stock guide + this supplement", appended on
 * Gemini profiles by the agentic loop's `get_dive_guide` handling (see
 * src/core/agentic-loop.ts). This file is now just that supplement: the
 * guardrails the stock guide still lacks, written as hard rules with one
 * negative example each (~1.5K tokens).
 */

/**
 * The thin supplement — the guardrails the *stock* `get_dive_guide({client:'other'})`
 * still lacks, APPENDED to that stock guide text on Gemini profiles.
 *
 * The single place this CONTRADICTS the stock guide is the "never print dive
 * source in chat" rule: the stock guide tells non-rendering clients to "output
 * the code as text". quackbot must suppress that, so rule 1 below is written to
 * override it explicitly.
 */
export function buildGeminiDiveSupplement(): string {
  return GEMINI_DIVE_SUPPLEMENT;
}

const GEMINI_DIVE_SUPPLEMENT = `---

## quackbot hard rules (Gemini) — these OVERRIDE anything above

The guide above is the general dive spec. The rules below are the ones that
most often break a Gemini-authored dive in this environment. Where a rule here
conflicts with the guide above, **this section wins**. Read it before you write
any dive source.

### 1. NEVER print dive source in chat (overrides the guide's "output the code as text")

The guide above tells clients without an inline renderer to "output the code as
text". **Do NOT do that here.** The dive source travels exclusively through the
\`save_dive\` / \`update_dive\` / \`edit_dive_content\` tool calls — never through
your chat reply.

- ❌ Pasting the component in a \`\`\`tsx fenced block, or quoting \`useSQLQuery\` /
  \`REQUIRED_DATABASES\` fragments into prose, or showing a "here's the code"
  preview before saving.
- ✅ Describe the dive in one plain-English sentence ("a 3-KPI strip over a
  monthly-trips line chart"), then call \`save_dive\` with the source as the tool
  argument. After it returns, report only the title and the \`dive_app_url\`.

Only paste source if the user says the literal words "show me the code".

### 2. \`export default function\` is a hard validator requirement

The validator looks for \`export default function ComponentName()\`. A named
export, an anonymous arrow default, or \`module.exports\` all fail validation.

\`\`\`tsx
export default function SalesOverview() { ... }   // ✅
const SalesOverview = () => { ... }; export default SalesOverview;  // ❌ rejected
\`\`\`

### 3. The SQL hook is \`useSQLQuery\` from \`@motherduck/react-sql-query\` — nothing else

This is the single largest historical cause of dive-write failure. The runtime
resolves exactly one SQL hook; plausible-looking alternatives all reject:

\`\`\`tsx
import { useSQLQuery } from "@motherduck/react-sql-query";  // ✅ the only correct form

import { useQuery } from "@motherduck/wasm-client";   // ❌ package not in the sandbox
import { useQuery } from "@tanstack/react-query";     // ❌ different library, not loaded
import { MotherDuck } from "@motherduck/client";      // ❌ Node SDK, not browser-side
\`\`\`

If you catch yourself typing \`useQuery\` or \`@motherduck/wasm-client\`, stop and
rewrite the import.

### 4. \`REQUIRED_DATABASES\` parser edge cases that silently blank the dive

The guide covers the happy path. These three malformed shapes pass a human read
but the runtime regex rejects them — the array parses as empty and every query
against the share renders blank, with no error:

\`\`\`tsx
// ❌ string array without objects — regex won't match, array stays empty
export const REQUIRED_DATABASES = ["sample_data"];

// ❌ missing the \`export\` keyword — the regex only matches \`export const REQUIRED_DATABASES = [\`
const REQUIRED_DATABASES = [{ type: 'share', path: 'md:_share/…', alias: 'sample_data' }];

// ❌ dynamic value (template literal / function call / spread / getter) — rejected
//    as a security measure, silently yields an empty list
export const REQUIRED_DATABASES = [{ type: 'share', path: \\\`md:_share/\\\${name}\\\`, alias }];
\`\`\`

It must be a **literal** array of objects with string-valued \`path\` and \`alias\`,
declared with \`export const\`, **exactly once**. A second
\`REQUIRED_DATABASES\` declaration lower in the file is a syntax error and the dive
will not transpile — if you copy a starter entry from context, replace it, do
not append a second one.

### 5. \`useDiveState\` is stubbed in the inline preview

In the embedded preview (what \`view_dive\` renders inline), \`useDiveState\` is
stubbed to plain \`useState\`: no URL persistence, and two callsites with the same
key do NOT share state. Production MotherDuck behaves as the guide documents.
Build against the production semantics; treat the preview as visual-only, and
don't "fix" a preview that doesn't round-trip state — it's the stub, not a bug.

### 6. Before \`edit_dive_content\`, call \`read_dive\` in the SAME turn

\`edit_dive_content\` matches \`old_string\` against the CURRENT dive content. A
snapshot from earlier in the thread is stale — the edit fails with "old_string
not found". Always \`read_dive(id)\` in the same turn immediately before editing;
for a wholesale rewrite prefer \`update_dive\` with the full new content.

### 7. Troubleshooting (read on a failed save/edit)

| Symptom | Likely cause | Fix |
|---|---|---|
| Validator: unresolved import | \`@motherduck/wasm-client\` / \`useQuery\` | \`useSQLQuery\` from \`@motherduck/react-sql-query\` (rule 3) |
| Save rejected: no default export | named/arrow/module.exports default | \`export default function\` (rule 2) |
| Dive renders blank, no error | empty \`REQUIRED_DATABASES\` or unguarded BigInt/DATE in JSX | fix the declaration (rule 4); wrap numerics with \`N()\`, format dates in SQL |
| Saved dive queries return empty | unqualified table names | \`"db"."schema"."table"\` everywhere |
| \`edit_dive_content\`: "old_string not found" | stale snapshot | \`read_dive\` this turn first (rule 6) |
| \`data.rows\` undefined | wrong access pattern | \`data\` IS the row array — \`Array.isArray(data) ? data : []\` |
`;
