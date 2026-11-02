-- Runs on every connection the MCP server opens (passed via --init-sql).
-- Lets the agent ATTACH the public Hugging Face Iceberg catalogs in ../public_iceberg_datasets.sql
-- (and read Iceberg tables in object storage), in addition to the tables in data/workshop.duckdb.
-- INSTALL is a no-op once the extension is cached for this DuckDB version.
INSTALL iceberg; LOAD iceberg; INSTALL httpfs; LOAD httpfs;
-- No CREATE SECRET here on purpose: the public buckets work anonymously, and secret DDL
-- races ("Catalog write-write conflict") when an agent fires several tool calls at once.
