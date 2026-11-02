# 5. Use MotherDuck with motherduck.com/try

[motherduck.com/try](https://motherduck.com/try) is a no-login way to see MotherDuck. It opens
a limited AI chat whose agent explores data in a free, temporary MotherDuck organization. The
page says the chat is "limited to a few messages, made for experimenting". For real work it
points you to connecting your own AI client, which is
[section 7](../07-remote-mcp/README.md).

## What you can do there

From the page as of 2026-11-02:

- Start without logging in.
- Pick a sample dataset (for example NYC taxi trips or Hacker News activity), or paste a
  public `s3://` or `https://` URL to a Parquet or CSV file.
- Ask questions in plain language. The agent runs the SQL on MotherDuck.

The Parquet files you queried locally in sections 2 and 4 are public, so you can paste one
here and compare. For example:
`https://us-prd-motherduck-open-datasets.s3.amazonaws.com/hacker_news/parquet/comments_stories/stories/dt=2024-12-21/data0.parquet`.

> TODO: Add the workshop's exact steps for this section: which dataset to pick, what to ask,
> and what attendees should see. These haven't been tested in a workshop run.

> TODO: Confirm whether the /try chat can attach the Hugging Face Iceberg catalog from
> section 3 (`CREATE DATABASE ... (TYPE ICEBERG)` over `nvidia.personas_brazil`, as in
> [section 8](../08-end-to-end/README.md)) or a frozen DuckLake attached over `https://`.
> MotherDuck's cloud supports the
> [iceberg](https://motherduck.com/docs/integrations/file-formats/apache-iceberg/) and
> [ducklake](https://motherduck.com/docs/integrations/file-formats/ducklake/) extensions, but
> the /try page only mentions Parquet and CSV.

## Keep what you build

The organization behind /try is temporary. To keep it, claim it:
[6. Claim the MotherDuck organization](../06-claim-org/README.md).

## References

- [motherduck.com/try](https://motherduck.com/try)
- [MotherDuck documentation](https://motherduck.com/docs/getting-started/)

Next: [6. Claim the MotherDuck organization](../06-claim-org/README.md).
