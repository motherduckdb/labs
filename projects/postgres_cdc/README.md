# postgres_cdc

Packages the **MotherDuck Postgres-CDC replicator** end to end: source code as a
git submodule, a CI build that runs **on labs**, and a MotherDuck **Flight** that
pulls the resulting binary from the labs release.

## Layout

```
projects/postgres_cdc/
├── etl/                                  # git submodule -> Alex-Monahan/etl @ motherduck-minimal
├── flight/
│   ├── flight_postgres_cdc.py            # MotherDuck Flight (pull-model resolver)
│   └── flight_postgres_cdc_requirements.txt
└── README.md
.github/workflows/postgres_cdc-build.yml  # CI build (must live at repo root per GH Actions)
```

### 1. Submodule → the fork

`projects/postgres_cdc/etl` is a git submodule pointing at the
[`Alex-Monahan/etl`](https://github.com/Alex-Monahan/etl) fork of Supabase ETL,
tracking branch **`motherduck-minimal`** and pinned to a specific commit. This is
the MotherDuck-minimal replicator source (a ducklake-only `etl-replicator`).

Update the pin with:

```bash
git submodule update --remote projects/postgres_cdc/etl
git add projects/postgres_cdc/etl && git commit -m "bump etl submodule"
```

### 2. CI on labs builds the submodule + publishes the release

[`.github/workflows/postgres_cdc-build.yml`](../../.github/workflows/postgres_cdc-build.yml)
triggers on push to the `postgres_cdc` branch (and `workflow_dispatch`). It:

- checks out with `submodules: recursive`,
- builds on `ubuntu-22.04` (glibc 2.35, for Flight compatibility),
- honors the submodule's pinned Rust toolchain (`rustup show` → 1.95.0),
- builds `cargo build --release -p etl-replicator --no-default-features --features ducklake`
  inside the submodule, strips + gzips the binary,
- computes `SHA256SUMS` (of the `.gz`) and a `latest.json` manifest
  (`sha`, `run_id`, `run_url`, `built_at`, `asset`, `sha256`), and
- on success, **recreates** the labs GitHub Release tag
  [`postgres_cdc-replicator`](https://github.com/motherduckdb/labs/releases/tag/postgres_cdc-replicator)
  so the tag always tracks the latest green build, publishing
  `etl-replicator-linux-amd64.gz` + `SHA256SUMS` + `latest.json`.

The build is ducklake-only: no protobuf, no sccache/failpoints/LTO.

### 3. The Flight pulls the latest green labs build

[`flight/flight_postgres_cdc.py`](flight/flight_postgres_cdc.py) uses a
**pull-model** `resolve_binary()`: instead of a hardcoded URL, it asks the
GitHub API for the newest **successful** run of the build workflow on labs, then
downloads the release asset and verifies it two ways before ever spawning the
replicator:

1. `latest.json.sha` **must equal** the head SHA of the latest green run
   (rejects a stale-release race), and
2. the downloaded `.gz` **must** match `latest.json.sha256` (and cross-checks
   `SHA256SUMS`).

It is configured for labs via these keys (Flight `config`, all overridable):

| key | value |
| --- | --- |
| `BUILD_REPO` | `motherduckdb/labs` |
| `BUILD_WORKFLOW` | `postgres_cdc-build.yml` |
| `BUILD_BRANCH` | `postgres_cdc` |
| `RELEASE_TAG` | `postgres_cdc-replicator` |

It then replicates a small PlanetScale `tpch` table (`region`, 5 rows) into a
native MotherDuck database (`postgres_cdc_labs`) via the in-place DuckLake
destination (`catalog_url: md:<database>`), and proves backfill landed by
comparing the destination row count to the source count. Non-destructive: it
never modifies the source table.

#### Rollback with `PIN_SHA`

Set the `PIN_SHA` config/env key to a specific commit SHA to bypass the "latest
green" API lookup and pin the resolver to that build (it still verifies the
checksum against `latest.json`). Leave it unset to always track the newest green
labs build.
