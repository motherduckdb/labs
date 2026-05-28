# MotherDuck Labs

Experimental projects, prototypes, and explorations from the MotherDuck team.

> **Heads up:** Everything in this repo is experimental. Code here is not production-supported, may change without notice, and is published primarily for inspiration, reference, and community tinkering.

## Projects

Each experiment lives in its own directory under [`projects/`](./projects/). Browse the list below or dive into a folder for project-specific READMEs.

<!-- BEGIN PROJECT LIST -->
| Project | What it is |
|---|---|
| [`agentic-sql-mini`](./projects/agentic-sql-mini/) | Minimal A/B harness for the catalog-context-for-agents experiment — can descriptive column names alone replace prose docs as an agent's information source? |
| [`bird-bench`](./projects/bird-bench/) | Text-to-SQL evaluation framework using the BIRD Mini-Dev benchmark with MotherDuck as the execution backend. |
| [`connections-eval-mini`](./projects/connections-eval-mini/) | Evaluate AI models on NYT Connections puzzles. Built for the Seattle Startup Summit evals workshop. |
| [`controllog`](./projects/controllog/) | Controllable logging library for AI/agentic systems — events + balanced postings, JSONL transport, optional MotherDuck upload. Shared dep of `agentic-sql-mini`, `bird-bench`, and `connections-eval-mini`. |
| [`controllog-viz`](./projects/controllog-viz/) | Static HTML views for `controllog` datasets (JSONL or MotherDuck via one DuckDB layer) — a per-run review with a chain-of-thought conversation explorer and a cross-run dashboard with a run × question progression/regression matrix. |
| [`metadata_generator`](./projects/metadata_generator/) | Generate rich metadata for MotherDuck databases — profile statistics, LLM-generated descriptions, and SQL `COMMENT` statements. Used as a dep by `bird-bench`. |
| [`react-components`](./projects/react-components/) | Open-source React components extracted from MotherDuck's website and docs — embed a public Dive, embed a private Dive, and an in-browser MotherDuck SQL editor. |
<!-- END PROJECT LIST -->

## Structure

```
labs/
├── README.md          # This file
├── LICENSE            # MIT
└── projects/
    └── <project>/     # Self-contained experiment with its own README
```

Each project directory is self-contained: own README, own dependencies, own runtime. There is no shared build system — projects can use whatever language or stack makes sense.

## Contributing

These are experiments — issues and discussions are welcome, but expect a slower cadence than production repos. If you want to add a new experiment:

1. Create a folder under `projects/<your-experiment>/`.
2. Include a `README.md` covering: what it does, why it exists, how to run it, and known limitations.
3. Open a PR.

## License

[MIT](./LICENSE) — see the LICENSE file for the full text. Individual projects may carry their own license; check the project directory.
