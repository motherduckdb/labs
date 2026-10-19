-- State for the self-healing healer. Idempotent: scripts/setup.py runs it on every deploy.
CREATE DATABASE IF NOT EXISTS heal;
CREATE DATABASE IF NOT EXISTS heal_lake;
CREATE DATABASE IF NOT EXISTS heal_chaos;
USE heal;  -- column DEFAULTs may not name a catalog, so the sequences below resolve against heal

CREATE SEQUENCE IF NOT EXISTS heal.main.incident_seq START 1;
CREATE SEQUENCE IF NOT EXISTS heal.main.event_seq START 1;

-- Structured HEAL_EVENT lines, written by healkit inside each pipeline run (also printed to the log).
CREATE TABLE IF NOT EXISTS heal.main.pipeline_events (
    event_uid VARCHAR PRIMARY KEY,
    ts TIMESTAMPTZ, pipeline VARCHAR, flight_id UUID, run_number BIGINT, run_id VARCHAR, sha VARCHAR,
    kind VARCHAR,           -- error | test | info
    severity VARCHAR,       -- error | warn | info
    asset VARCHAR, test VARCHAR, resource VARCHAR, error_type VARCHAR, http_status INTEGER,
    message VARCHAR, frames VARCHAR[], detail JSON, run_config JSON
);

-- One normalized failure per FAILED run / error event / healer fault (checker writes).
CREATE TABLE IF NOT EXISTS heal.main.events (
    event_id BIGINT PRIMARY KEY DEFAULT nextval('event_seq'),
    ts TIMESTAMPTZ DEFAULT now(), source VARCHAR,   -- run | heal_event | healer
    pipeline VARCHAR, flight_id UUID, run_number BIGINT, sha VARCHAR,
    error_class VARCHAR, norm_msg VARCHAR, top_frames VARCHAR[], asset VARCHAR, resource VARCHAR,
    fingerprint VARCHAR, raw_excerpt VARCHAR, incident_id BIGINT, attach_reason VARCHAR,
    event_uid VARCHAR UNIQUE
);

CREATE TABLE IF NOT EXISTS heal.main.fingerprints (
    fingerprint VARCHAR PRIMARY KEY, incident_id BIGINT, norm_msg VARCHAR, embedding FLOAT[512],
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Every pair judged at L4/L5, so a pair is only ever judged once.
CREATE TABLE IF NOT EXISTS heal.main.pair_judgments (
    fingerprint VARCHAR, incident_id BIGINT, jev_p DOUBLE, llm_verdict VARCHAR, decision VARCHAR,
    ts TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (fingerprint, incident_id)
);

CREATE TABLE IF NOT EXISTS heal.main.incidents (
    incident_id BIGINT PRIMARY KEY DEFAULT nextval('incident_seq'),
    created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
    status VARCHAR,           -- open watching investigating proposed merged verifying resolved regressed escalated
    root_id BIGINT,           -- set on symptom incidents (unused when symptoms attach as events)
    pipeline VARCHAR, pipelines VARCHAR[], class VARCHAR, category VARCHAR, disposition VARCHAR,
    severity VARCHAR, level VARCHAR, title VARCHAR, fingerprint VARCHAR, resource VARCHAR,
    event_count INTEGER DEFAULT 1, first_sha VARCHAR, last_event_at TIMESTAMPTZ,
    lease_owner VARCHAR, lease_expires TIMESTAMPTZ, attempts INTEGER DEFAULT 0,
    cost_usd DOUBLE DEFAULT 0, gh_issue INTEGER, gh_pr INTEGER, fix_sha VARCHAR, merged_at TIMESTAMPTZ,
    green_runs INTEGER DEFAULT 0, red_runs INTEGER DEFAULT 0, muted BOOLEAN DEFAULT false,
    guide_id UUID, resolved_at TIMESTAMPTZ, scenario VARCHAR, notes VARCHAR
);

CREATE TABLE IF NOT EXISTS heal.main.incident_transitions (
    incident_id BIGINT, ts TIMESTAMPTZ DEFAULT now(), from_status VARCHAR, to_status VARCHAR, reason VARCHAR, actor VARCHAR
);

CREATE TABLE IF NOT EXISTS heal.main.fixer_runs (
    fixer_run_id VARCHAR PRIMARY KEY, incident_id BIGINT, attempt INTEGER, flight_run_number BIGINT,
    started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ, status VARCHAR, level VARCHAR, model VARCHAR,
    approver_model VARCHAR, cost_usd DOUBLE, approver_rounds INTEGER, outcome VARCHAR, branch VARCHAR,
    pr_number INTEGER, summary JSON
);

-- Every command, guard verdict and approver verdict of a fixer run.
CREATE TABLE IF NOT EXISTS heal.main.actions (
    fixer_run_id VARCHAR, seq INTEGER, ts TIMESTAMPTZ DEFAULT now(), kind VARCHAR,  -- tool | mdsql | guard | approver | cost | note
    command VARCHAR, verdict VARCHAR, detail JSON
);

CREATE TABLE IF NOT EXISTS heal.main.watermarks (name VARCHAR PRIMARY KEY, value VARCHAR, updated_at TIMESTAMPTZ DEFAULT now());
-- Flight runs the checker has already handled (runs can finish out of order, so a single high-water
-- mark per flight is not enough; the watermark only skips the long-settled history).
CREATE TABLE IF NOT EXISTS heal.main.processed_runs (
    flight_id UUID, run_number BIGINT, component VARCHAR, status VARCHAR, sha VARCHAR, processed_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (flight_id, run_number)
);

CREATE TABLE IF NOT EXISTS heal.main.classifications (
    ts TIMESTAMPTZ DEFAULT now(), task VARCHAR, subject VARCHAR, label VARCHAR, confidence DOUBLE,
    jev_label VARCHAR, jev_confidence DOUBLE, fallback_ran BOOLEAN, fallback_label VARCHAR, model VARCHAR, cost_usd DOUBLE
);

CREATE TABLE IF NOT EXISTS heal.main.guide_index (
    guide_id UUID PRIMARY KEY, version INTEGER, topic VARCHAR, category VARCHAR, fingerprint VARCHAR, class VARCHAR,
    pipeline VARCHAR, outcome VARCHAR, incident_id BIGINT, title VARCHAR, description VARCHAR,
    embedding FLOAT[512], helpful_count INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS heal.main.guide_reads (
    incident_id BIGINT, fixer_run_id VARCHAR, guide_id UUID, guide_version INTEGER, read_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS heal.main.guide_links (
    from_guide_id UUID, to_guide_id UUID, to_version INTEGER, how_used VARCHAR, reason VARCHAR, incident_id BIGINT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS heal.main.heartbeats (component VARCHAR, ts TIMESTAMPTZ DEFAULT now(), run_number BIGINT, sha VARCHAR, detail JSON);

CREATE TABLE IF NOT EXISTS heal.main.control (key VARCHAR PRIMARY KEY, value VARCHAR, updated_at TIMESTAMPTZ DEFAULT now(), updated_by VARCHAR);
INSERT OR IGNORE INTO heal.main.control (key, value, updated_by) VALUES
    ('kill_switch', 'off', 'setup'), ('daily_spend_cap_usd', '50', 'setup'), ('max_concurrent_fixers', '3', 'setup'),
    ('dispatch_paused', 'off', 'setup'), ('checker_force_fail', 'off', 'setup'), ('max_attempts', '2', 'setup'),
    ('autonomy_cap', 'L1', 'setup'),          -- campaign-wide ceiling: the suite runs at L3, then L2, then L1
    ('approver_rounds', '2', 'setup'), ('budget_usd', '10', 'setup');

-- Commit sha each Flight run actually executed, plus the last-good code cache used when GitHub is down.
CREATE TABLE IF NOT EXISTS heal.main.code_versions (
    ts TIMESTAMPTZ DEFAULT now(), component VARCHAR, flight_id UUID, run_number BIGINT, ref VARCHAR, sha VARCHAR, source VARCHAR
);
-- Direct mode (no GitHub write access yet): an approved fix is a patch here instead of a merged PR.
-- The loader applies `active` patches for its ref, in patch_id order, on top of the git checkout.
-- proposed = L3, waiting for a human (UPDATE ... SET status = 'active' to merge); reverted = rolled back;
-- migrated = turned into a real PR later (see GITHUB_TODO.md).
CREATE SEQUENCE IF NOT EXISTS heal.main.patch_seq START 1;
CREATE TABLE IF NOT EXISTS heal.main.code_patches (
    patch_id BIGINT PRIMARY KEY DEFAULT nextval('patch_seq'), created_at TIMESTAMPTZ DEFAULT now(),
    incident_id BIGINT, ref VARCHAR, base_sha VARCHAR, paths VARCHAR[], patch VARCHAR, status VARCHAR,
    level VARCHAR, fixer_run_id VARCHAR, title VARCHAR, body VARCHAR, activated_at TIMESTAMPTZ, reverted_at TIMESTAMPTZ, reason VARCHAR
);
CREATE TABLE IF NOT EXISTS heal.main.code_cache (ref VARCHAR PRIMARY KEY, sha VARCHAR, tarball BLOB, cached_at TIMESTAMPTZ DEFAULT now());

CREATE SCHEMA IF NOT EXISTS heal.eval;
CREATE TABLE IF NOT EXISTS heal.eval.scenario_runs (
    campaign VARCHAR, scenario VARCHAR, level VARCHAR, started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ,
    injected_at TIMESTAMPTZ, detected_at TIMESTAMPTZ, resolved_at TIMESTAMPTZ, incident_ids BIGINT[],
    expected JSON, observed JSON, scores JSON, passed BOOLEAN, cost_usd DOUBLE, notes VARCHAR
);
CREATE TABLE IF NOT EXISTS heal.eval.pair_labels (a VARCHAR, b VARCHAR, same_root BOOLEAN, source VARCHAR);

-- World config: the stand-in for upstream behaviour during scenarios. Pipelines read it through healkit.chaos.
CREATE TABLE IF NOT EXISTS heal_chaos.main.world (
    pipeline VARCHAR, knob VARCHAR, value VARCHAR, runs_remaining INTEGER, scenario VARCHAR,
    created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (pipeline, knob)
);
