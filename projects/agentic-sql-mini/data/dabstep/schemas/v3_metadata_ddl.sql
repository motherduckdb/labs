-- v3 metadata schema: DDL for guides, fragments, annotations, gap_signals, and maintenance_log tables.
-- Split from v3_metadata.sql. Contains only CREATE TABLE statements.
-- Applied against the metadata database ({data_db}_metadata).
-- No pre-built views — views are earned through the learning loop.
--
-- Guide content is seeded separately by seed_guide() from
-- data/dabstep/enrichment/guide_database.md (single source of truth).

CREATE OR REPLACE TABLE guides (
    id INTEGER PRIMARY KEY,
    db_name VARCHAR NOT NULL,
    section_name VARCHAR DEFAULT 'core',
    schema_name VARCHAR,
    table_name VARCHAR,
    column_name VARCHAR,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE OR REPLACE TABLE fragments (
    id INTEGER PRIMARY KEY,
    db_names VARCHAR[] NOT NULL,
    schema_names VARCHAR[],
    table_names VARCHAR[],
    column_names VARCHAR[],
    description TEXT NOT NULL,
    sql TEXT,
    trust_level VARCHAR DEFAULT 'rumor',
    score INTEGER DEFAULT 0,
    retrieval_count INTEGER DEFAULT 0,
    correct_retrieval_count INTEGER DEFAULT 0,
    tags VARCHAR[],
    related_fragment_ids INTEGER[],
    source_question_id VARCHAR,
    created_at TIMESTAMPTZ DEFAULT now(),
    maintained_at TIMESTAMPTZ,
    view_status VARCHAR,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_by_transaction_id VARCHAR,
    fragment_type VARCHAR DEFAULT 'general',
    examples TEXT,
    graduated_to_view VARCHAR,
    graduated_to_annotation_id INTEGER,
    graduated_to_guide_section VARCHAR,
    superseded_by_fragment_id INTEGER,
    bundle_id VARCHAR,
    is_seed BOOLEAN DEFAULT FALSE,
    zero_retrieval_windows INTEGER DEFAULT 0,
    related_views VARCHAR[]
);

-- Annotations: domain knowledge that feeds into metadata-generator comment generation.
-- When the learning loop discovers something about a table/column, it writes an
-- annotation here. Next time metadata-generator runs, it reads these annotations
-- and merges them into the SQL COMMENTs.
CREATE OR REPLACE TABLE annotations (
    id INTEGER PRIMARY KEY,
    db_name VARCHAR NOT NULL,
    schema_name VARCHAR DEFAULT 'main',
    table_name VARCHAR NOT NULL,
    column_name VARCHAR,
    annotation TEXT NOT NULL,
    source VARCHAR DEFAULT 'learning_loop',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Gap signals: knowledge gaps discovered by the Shaman during learn/maintain cycles.
-- Bridges learn and maintain with explicit gap tracking.
CREATE OR REPLACE TABLE gap_signals (
    id INTEGER PRIMARY KEY,
    db_name VARCHAR NOT NULL,
    signal TEXT NOT NULL,
    signal_type VARCHAR NOT NULL DEFAULT 'missing',  -- 'missing' or 'refinement'
    related_fragment_ids INTEGER[],                   -- fragments this signal relates to
    source VARCHAR NOT NULL,         -- "learn:<question_id>" or "maintain:<transaction_id>"
    resolved BOOLEAN DEFAULT FALSE,
    resolved_by VARCHAR,             -- fragment_id, view_name, etc.
    question_id VARCHAR,             -- which question triggered this signal
    sql TEXT,                        -- SQL discovered during learning
    gold_answer VARCHAR,             -- expected answer for the question
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE OR REPLACE TABLE maintenance_log (
    id INTEGER,
    transaction_id VARCHAR NOT NULL,
    operation VARCHAR NOT NULL,
    fragment_id INTEGER NOT NULL,
    action VARCHAR NOT NULL,
    before_state JSON,
    after_state JSON,
    created_at TIMESTAMPTZ DEFAULT now(),
    error_detail VARCHAR
);
