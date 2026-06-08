# How it works

Two loops: the **runtime** loop that answers a data question, and the **improvement**
loop that tunes the skill + context from the eval logs.

## 1. Answering a data question (runtime)

The agent always has the compact `SKILL.md` in its prompt; the heavy domain knowledge
is pulled on demand through `fetch_context` (progressive disclosure: domains →
one-line summaries → full bodies), then it explores the schema, verifies SQL, and
submits. `controllog` captures the full trace for later inspection.

```mermaid
flowchart TD
    Q["Question + guidelines"] --> AG
    SKILL["SKILL.md — always in the prompt:<br/>procedure + where knowledge lives + key rules"] -.->|injected| AG
    AG["Agent loop<br/>gemini-3-flash · reasoning low"]

    AG -->|"1 · fetch_context()"| DOM["6 domains"]
    DOM -->|"2 · fetch_context(domains=[...])"| SUMM["item one-line summaries"]
    SUMM -->|"3 · fetch_context(ids=[...])"| BODY["full item bodies"]
    BODY -.->|knowledge| AG
    STORE[("context/items/*.md<br/>27-item semantic layer")] -.serves.-> DOM & SUMM & BODY

    AG -->|"4 · list_tables / list_columns"| MD[("MotherDuck / DuckDB<br/>payments · fees · merchants · lookups")]
    AG -->|"5 · query — verify SQL"| MD
    AG -->|"6 · submit_answer(sql)"| FINAL["final SQL → rows"]
    FINAL --> SCORE["score.py — strict DABStep scorer"]
    SCORE --> VERDICT{"correct?"}
    FINAL -.-> LOG[("controllog<br/>events + postings + full tool-call trace")]
    SCORE -.-> LOG
```

## 2. Improving the system (from the logs)

Each eval writes per-question JSONL plus `controllog` events/postings.
`controllog-viz` renders trace cards (the `fetch_context` path the agent took, its
SQL, and predicted vs gold). Every miss is triaged into one of three buckets, fixed
at the **template-family** level (validated against *all* variations, not one gold),
re-run for stability, and merged.

```mermaid
flowchart TD
    RUN["asm evaluate --split test<br/>reasoning low · concurrency 15"] --> OUT["results/*.jsonl<br/>+ controllog/{events,postings}"]
    OUT --> VIZ["controllog-viz review / dashboard<br/>trace cards: fetch_context path, SQL, pred vs gold"]
    VIZ --> TRIAGE{"triage each miss"}

    TRIAGE -->|"context gap<br/>(wrong/missing rule)"| FIXC["edit the context item<br/>context/items/*.md"]
    TRIAGE -->|"model-variance /<br/>didn't load the rule"| FIXS["promote rule to always-on SKILL<br/>+ sharpen summary / fetch_context"]
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
