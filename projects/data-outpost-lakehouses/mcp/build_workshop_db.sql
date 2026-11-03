-- Builds data/workshop.duckdb: a small local DuckDB file for the MCP exercises, copied from the
-- public Iceberg table nvidia.personas_brazil (1M synthetic Brazilian personas) in the
-- Hugging Face Faceberg catalog https://kszucs-catalog.hf.space (no credentials needed).
-- Run from the workshop folder:  uvx --from duckdb-cli==1.5.6 duckdb data/workshop.duckdb -f mcp/build_workshop_db.sql
-- The copy reads 9 of the 22 columns (about 200 Hugging Face requests, well under the
-- anonymous limit of 3,000 per 5 minutes). If the catalog Space is asleep, wake it first:
-- curl -s https://kszucs-catalog.hf.space/v1/config
-- or, on any OS including Windows:
-- uv run --python 3.13 python -c "import urllib.request; print(urllib.request.urlopen('https://kszucs-catalog.hf.space/v1/config', timeout=120).read().decode())"
INSTALL iceberg; LOAD iceberg; INSTALL httpfs; LOAD httpfs;

ATTACH IF NOT EXISTS 'https://kszucs-catalog.hf.space' AS hf (
    TYPE iceberg,
    ENDPOINT 'https://kszucs-catalog.hf.space',
    AUTHORIZATION_TYPE 'none'
);

-- Pin the copy to the table's current Iceberg snapshot, so it reads one consistent version and
-- you can tell later which version you have (see copy_info below).
SET VARIABLE snapshot = (SELECT max_by(snapshot_id, sequence_number)
                         FROM iceberg_snapshots(hf.nvidia.personas_brazil));

-- One transaction: if the download fails halfway, the file keeps its previous tables.
BEGIN;

-- All 1,000,000 personas: the demographic columns plus the one-sentence summary. The long
-- persona texts (professional, sports, arts, travel, culinary, ...) stay in the remote table.
CREATE OR REPLACE TABLE personas AS
SELECT uuid, sex, age, marital_status, education_level, occupation, municipality, state,
       persona
FROM hf.nvidia.personas_brazil AT (VERSION => getvariable('snapshot'));

-- A small lookup table to join on: each state's abbreviation (UF) and region.
CREATE OR REPLACE TABLE states AS
SELECT * FROM (VALUES
    ('Acre', 'AC', 'Norte'), ('Amapá', 'AP', 'Norte'), ('Amazonas', 'AM', 'Norte'),
    ('Pará', 'PA', 'Norte'), ('Rondônia', 'RO', 'Norte'), ('Roraima', 'RR', 'Norte'),
    ('Tocantins', 'TO', 'Norte'),
    ('Alagoas', 'AL', 'Nordeste'), ('Bahia', 'BA', 'Nordeste'), ('Ceará', 'CE', 'Nordeste'),
    ('Maranhão', 'MA', 'Nordeste'), ('Paraíba', 'PB', 'Nordeste'),
    ('Pernambuco', 'PE', 'Nordeste'), ('Piauí', 'PI', 'Nordeste'),
    ('Rio Grande do Norte', 'RN', 'Nordeste'), ('Sergipe', 'SE', 'Nordeste'),
    ('Distrito Federal', 'DF', 'Centro-Oeste'), ('Goiás', 'GO', 'Centro-Oeste'),
    ('Mato Grosso', 'MT', 'Centro-Oeste'), ('Mato Grosso do Sul', 'MS', 'Centro-Oeste'),
    ('Espírito Santo', 'ES', 'Sudeste'), ('Minas Gerais', 'MG', 'Sudeste'),
    ('Rio de Janeiro', 'RJ', 'Sudeste'), ('São Paulo', 'SP', 'Sudeste'),
    ('Paraná', 'PR', 'Sul'), ('Rio Grande do Sul', 'RS', 'Sul'), ('Santa Catarina', 'SC', 'Sul')
) AS t(state, uf, region);

-- What was copied, from which snapshot, and when. Compare snapshot_id with the source's
-- current snapshot to tell whether the copy is stale.
CREATE OR REPLACE TABLE copy_info AS
SELECT 'personas' AS table_name,
       'hf.nvidia.personas_brazil (Iceberg, https://kszucs-catalog.hf.space)' AS source,
       getvariable('snapshot') AS snapshot_id,
       now() AS copied_at;

COMMENT ON TABLE personas IS 'Local copy of 9 columns of hf.nvidia.personas_brazil (Iceberg, https://kszucs-catalog.hf.space; Hugging Face dataset nvidia/Nemotron-Personas-Brazil). Values are in Portuguese.';
COMMENT ON TABLE states IS 'Brazilian states: name (joins personas.state), abbreviation (uf) and region';
COMMENT ON TABLE copy_info IS 'Source, Iceberg snapshot and time of each copied table';

COMMIT;

DETACH hf;
SELECT table_name, estimated_size AS approx_rows FROM duckdb_tables() ORDER BY 1;
