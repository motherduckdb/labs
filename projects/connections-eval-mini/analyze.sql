-- ==========================================================================
-- Analyze eval results with DuckDB
--
-- Run interactively:
--   duckdb
--   .read analyze.sql
--
-- Or copy individual queries into a DuckDB session / Python script.
-- ==========================================================================

-- Load exchange logs
CREATE OR REPLACE VIEW exchanges AS
SELECT * FROM read_json_auto('logs/connections_eval_*.jsonl')
WHERE message = 'exchange';

-- Load run summaries
CREATE OR REPLACE VIEW summaries AS
SELECT * FROM read_json_auto('logs/connections_eval_*.jsonl')
WHERE message = 'summary';

-- One summary row per completed run_id
CREATE OR REPLACE VIEW completed_summaries AS
SELECT * EXCLUDE (row_num)
FROM (
    SELECT *,
        ROW_NUMBER() OVER (
            PARTITION BY run_id
            ORDER BY timestamp DESC
        ) AS row_num
    FROM summaries
)
WHERE row_num = 1
  AND COALESCE(status, 'completed') = 'completed';
-- Exchange rows from completed runs only
CREATE OR REPLACE VIEW completed_exchanges AS
SELECT e.*
FROM exchanges e
JOIN (SELECT run_id FROM completed_summaries) r USING (run_id);

-- Load controllog (if present)
CREATE OR REPLACE VIEW cl_postings AS
SELECT * FROM read_json_auto('logs/controllog/*/postings.jsonl');


-- ==========================================================================
-- 1. MODEL LEADERBOARD
-- Which model performs best?
-- ==========================================================================

SELECT
    model,
    puzzles_solved || '/' || puzzles_attempted AS solved,
    ROUND(puzzles_solved::FLOAT / puzzles_attempted * 100, 1) AS "solve_%",
    '$' || ROUND(total_cost, 4) AS cost,
    '$' || ROUND(total_cost / puzzles_attempted, 4) AS "$/puzzle",
    total_tokens AS tokens,
    ROUND(avg_time_sec, 1) || 's' AS avg_time
FROM completed_summaries
ORDER BY "solve_%" DESC, "$/puzzle" ASC;


-- ==========================================================================
-- 2. PUZZLE DIFFICULTY
-- Which puzzles are hardest across all models?
-- ==========================================================================

WITH puzzle_runs AS (
    SELECT
        puzzle_id, model, run_id,
        MAX(guess_index) AS guesses,
        MAX(CASE WHEN result = 'CORRECT' THEN 1 ELSE 0 END) AS won
    FROM completed_exchanges
    GROUP BY puzzle_id, model, run_id
)
SELECT
    puzzle_id,
    COUNT(*) AS runs,
    SUM(won) AS wins,
    ROUND(SUM(won)::FLOAT / COUNT(*) * 100) || '%' AS solve_rate,
    ROUND(AVG(guesses), 1) AS avg_guesses
FROM puzzle_runs
GROUP BY puzzle_id
ORDER BY solve_rate ASC;


-- ==========================================================================
-- 3. COST ANALYSIS
-- How much does each model cost per puzzle?
-- ==========================================================================

SELECT
    model,
    '$' || ROUND(SUM(COALESCE(cost, 0)), 4) AS total_cost,
    '$' || ROUND(SUM(COALESCE(cost, 0)) / COUNT(DISTINCT puzzle_id), 4) AS cost_per_puzzle,
    SUM(COALESCE(prompt_tokens, 0)) AS prompt_tok,
    SUM(COALESCE(completion_tokens, 0)) AS completion_tok,
    ROUND(AVG(latency_ms)) || 'ms' AS avg_latency
FROM completed_exchanges
GROUP BY model, run_id
ORDER BY total_cost;


-- ==========================================================================
-- 4. GAME REPLAY
-- See the actual guesses for a specific puzzle and model
-- (edit the WHERE clause to pick your run)
-- ==========================================================================

SELECT
    puzzle_id,
    guess_index,
    guess,
    result,
    confidence,
    latency_ms || 'ms' AS latency,
    '$' || ROUND(COALESCE(cost, 0), 4) AS cost
FROM completed_exchanges
-- WHERE model = 'sonnet-4'   -- uncomment and edit to filter
ORDER BY run_id DESC, puzzle_id, guess_index
LIMIT 50;


-- ==========================================================================
-- 5. CONTROLLOG: TRIAL BALANCE
-- Double-entry accounting check — every row should be zero
-- ==========================================================================

SELECT
    account_type,
    unit,
    ROUND(SUM(delta_numeric), 6) AS balance
FROM cl_postings
GROUP BY account_type, unit
ORDER BY account_type;
