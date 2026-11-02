-- Public Hugging Face datasets served as Iceberg tables by Faceberg REST catalogs,
-- queryable from DuckDB with NO credentials (https://github.com/huggingface/faceberg).
-- Tested 2026-11-02 with the DuckDB CLI 1.5.6 from uv (uv tool install duckdb-cli==1.5.6),
-- iceberg extension 890b78a9c, httpfs 4bc690d.
-- Run:  uvx --from duckdb-cli==1.5.6 duckdb -f public_iceberg_datasets.sql
-- The catalogs are personal demo Spaces on free hardware. If a Space is asleep, the first
-- request wakes it: curl -s https://kszucs-catalog.hf.space/v1/config
-- or, on any OS including Windows:
-- uv run --python 3.13 python -c "import urllib.request; print(urllib.request.urlopen('https://kszucs-catalog.hf.space/v1/config', timeout=120).read().decode())"
INSTALL iceberg; LOAD iceberg; INSTALL httpfs; LOAD httpfs;
.timer on

-- Attach the catalog. AUTHORIZATION_TYPE 'none' because it is public (no token, no secret).
ATTACH 'https://kszucs-catalog.hf.space' AS hf (
    TYPE iceberg,
    ENDPOINT 'https://kszucs-catalog.hf.space',
    AUTHORIZATION_TYPE 'none'
);

-- One schema per Hugging Face org, one table per dataset (11 tables).
SELECT schema, name FROM (SHOW ALL TABLES) ORDER BY ALL;

------------------------------------------------------------------------------
-- 1. nvidia.personas_brazil: 1M synthetic Brazilian personas (22 columns, values in Portuguese)
--    The same table MotherDuck reads in section 8 and data/workshop.duckdb copies locally.
------------------------------------------------------------------------------
DESCRIBE hf.nvidia.personas_brazil;

-- Where do the personas live? The five largest states (reads 2 of 22 columns).
SELECT state, count(*) AS personas, round(avg(age), 1) AS avg_age
FROM hf.nvidia.personas_brazil
GROUP BY ALL ORDER BY personas DESC LIMIT 5;

-- How does education vary with age?
SELECT education_level, count(*) AS personas, round(avg(age), 1) AS avg_age
FROM hf.nvidia.personas_brazil
GROUP BY ALL ORDER BY avg_age;

-- An agent-style question: three personas for user interviews (which 3 can vary).
SELECT municipality, age, persona
FROM hf.nvidia.personas_brazil
WHERE state = 'Santa Catarina' AND sex = 'Feminino' AND age BETWEEN 25 AND 34
  AND education_level = 'Superior completo'
LIMIT 3;

------------------------------------------------------------------------------
-- 2. A small table: SWE-bench Verified, 500 real GitHub issues coding agents are graded on
------------------------------------------------------------------------------
SELECT repo, count(*) AS tasks,
       count(*) FILTER (difficulty IN ('1-4 hours', '>4 hours')) AS over_1h
FROM hf."princeton-nlp"."SWE-bench_Verified"
GROUP BY ALL ORDER BY tasks DESC LIMIT 5;

------------------------------------------------------------------------------
-- 3. Another catalog: the IMDb reviews dataset in lhoestq's Faceberg catalog
------------------------------------------------------------------------------
ATTACH 'https://lhoestq-my-catalog.hf.space' AS lq (
    TYPE iceberg,
    ENDPOINT 'https://lhoestq-my-catalog.hf.space',
    AUTHORIZATION_TYPE 'none'
);
SELECT split, label, count(*) AS reviews
FROM lq.stanfordnlp.imdb
GROUP BY ALL ORDER BY ALL;
