# How it works

Two loops: the **runtime** loop that answers a data question, and the **improvement**
loop that tunes the skill + context from the eval logs.

## 1. Answering a data question (runtime)

The agent always has the compact `SKILL.md` in its prompt; the heavy domain knowledge
is pulled on demand through the **MotherDuck context MCP server's guides** (topic/uuid
model: the six `dabstep/<domain>` topics are pre-seeded in the prompt, so the agent goes
straight to `list_guides(topic)` for a domain's guides + descriptions → `get_guide(uuid)`
for the full body), then it explores the schema and verifies SQL through the same MCP
server's data tools, and submits. `controllog` captures the full trace for later inspection.

```mermaid
flowchart TD
    Q["Question + guidelines"] --> AG
    SKILL["SKILL.md — always in the prompt:<br/>procedure + where knowledge lives + key rules<br/>+ the six dabstep/&lt;domain&gt; topics"] -.->|injected| AG
    AG["Agent loop<br/>gemini-3-flash · reasoning low"]

    AG -->|"1 · list_guides(topic='dabstep/&lt;domain&gt;')"| DOM["guides: uuid + description"]
    DOM -->|"2 · get_guide(uuid)"| BODY["full guide body"]
    BODY -.->|knowledge| AG
    STORE[("MotherDuck guides — dabstep/&lt;domain&gt;<br/>27-item semantic layer<br/>(published via asm guides-load)")] -.serves.-> DOM & BODY

    AG -->|"3 · list_tables / list_columns"| MD[("MotherDuck MCP<br/>payments · fees · merchants · lookups")]
    AG -->|"4 · query — verify SQL"| MD
    AG -->|"5 · submit_answer(sql)"| FINAL["final SQL → rows"]
    FINAL --> SCORE["score.py — strict DABStep scorer"]
    SCORE --> VERDICT{"correct?"}
    FINAL -.-> LOG[("controllog<br/>events + postings + full tool-call trace")]
    SCORE -.-> LOG
```

## 2. Improving the system (from the logs)

Each eval writes per-question JSONL plus `controllog` events/postings.
`controllog-viz` renders trace cards (the `list_guides(topic)`/`get_guide(uuid)` path the
agent took, its SQL, and predicted vs gold). Every miss is triaged into one of three
buckets, fixed at the **template-family** level (validated against *all* variations,
not one gold), re-run for stability, and merged.

```mermaid
flowchart TD
    RUN["asm evaluate --split test<br/>reasoning low · concurrency 15"] --> OUT["results/*.jsonl<br/>+ controllog/{events,postings}"]
    OUT --> VIZ["controllog-viz review / dashboard<br/>trace cards: list_guides/get_guide path, SQL, pred vs gold"]
    VIZ --> TRIAGE{"triage each miss"}

    TRIAGE -->|"context gap<br/>(wrong/missing rule)"| FIXC["edit the context item<br/>context/items/*.md<br/>then re-publish: asm guides-load"]
    TRIAGE -->|"model-variance /<br/>didn't load the rule"| FIXS["promote rule to always-on SKILL<br/>+ sharpen guide description / list_guides"]
    TRIAGE -->|"gold noise<br/>(our SQL provably right)"| BAD["add to data/bad_golds.json<br/>(set aside)"]

    FIXC --> VAL["validate vs the WHOLE template family<br/>(not a single gold)"]
    FIXS --> VAL
    VAL --> RERUN["re-run failures ×N (stability)"]
    BAD --> RERUN
    RERUN -->|stable| COMMIT["commit → PR → merge"]
    RERUN -->|still failing| TRIAGE
    COMMIT --> RUN
```

**Core lesson from the tuning:** high-leverage rules must live in the *always-on*
`SKILL.md`, not only in fetch-gated context items — a low/no-reasoning model will skip
a rule it never loaded. See `docs/error-fixes.md` for the full per-template analysis.
