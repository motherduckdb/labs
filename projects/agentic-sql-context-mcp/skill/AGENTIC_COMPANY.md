# Agentic Company analysis skill

## Required workflow

1. Read the single guide under `agentic-company/manual` before exploring data. Treat it as shared
   operating context, not as a query recipe.
2. Translate the question into a population, event-time/cohort rule, cutoff, measure, grain,
   ranking, tie-break, and output shape. Keep these choices consistent across every CTE.
3. Use `list_tables` and `list_columns` to locate authoritative public records. Never use the
   private `ground_truth` or `sim` schemas.
4. Aggregate each fact to its native business key before joining facts of different grains. Check
   row counts and intermediate totals when a join could fan out or a lifecycle has revisions.
5. Run exploratory SQL until the result is supported by the manual and records. Apply the stated
   cutoff to what was knowable, preserve signs, use deterministic tie-breaks, and round only the
   final reported value.
6. Call `submit_answer` exactly once with read-only SQL whose result has precisely the shape in the
   question guidelines. Return only requested answer columns and ordering—no commentary columns.

## Analysis discipline

- Distinguish placement, shipment, receipt, posting, payment, start, publication, and snapshot
  dates. Filter on the date for the event the question actually names.
- For "latest" or "as of" language, select the latest eligible revision at the business grain;
  do not sum revisions.
- For ratios, aggregate the numerator and denominator first unless an average of entity rates is
  explicitly requested. Exclude zero-denominator entities.
- When a question fixes an earlier cohort but asks for outcomes through the snapshot cutoff, keep
  the cohort date rule separate from the outcome cutoff.
- If ambiguity remains, prefer the record closest to the measured business event and verify the
  choice against adjacent tables rather than guessing from column names.
