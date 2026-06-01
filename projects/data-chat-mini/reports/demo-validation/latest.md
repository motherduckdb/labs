# Demo Validation Report

- Run: 2026-06-01T06-39-48-399Z-mock
- Mode: mock
- Dataset: nba_box_scores_v2
- Completed: 2026-06-01T06:39:48.572Z
- Assertions: 19/19
- Unresolved P1/P2: 0

## Issues

No unresolved issues.

## Resolved Findings

- P2 Terminal assistant responses are stored in structured turn history: The harness caught streamed final responses rendering in the UI but missing from LLM replay; runAgenticLoop now appends non-empty terminal assistant blocks.
- P2 Persisted context-tool placeholders are patched before reopen: The harness exercises the context round-trip and persisted turnHistory; regression coverage lives in lib/chat-history-replay.test.ts.

## Assertions

- PASS [P1] database selection lists canonical dataset: available databases: nba_box_scores_v2, weather_demo
- PASS [P1] schema browser lists canonical tables: tables: main.schedule, main.box_scores
- PASS [P1] schema browser exposes join and metric columns: box_scores: game_id, entity_id, player_name, team_abbreviation, period, points; schedule: game_id, game_date, season_year, season_type, home_team_abbreviation, away_team_abbreviation
- PASS [P2] system prompt includes demo-critical behavior: prompt must name the selected DB, context tools, response-after-tools rule, generic grain/context guardrails, and mviz/no-HTML boundary without dataset-specific rules
- PASS [P1] tool catalog is read-only plus local context: tools: query, list_databases, list_tables, list_columns, search_catalog, ask_docs_question, query_context_layer, update_context_layer
- PASS [P2] first turn browses schema before querying: tool order: list_databases -> list_tables -> list_columns -> list_columns -> list_tables -> list_columns -> list_columns -> query
- PASS [P2] context save creates one reusable fragment: fragments after save: box_scores to schedule join key
- PASS [P2] mviz table renders as HTML: sse types: usage, context_tool, turn_complete, usage, tool_start, tool_end, tool_start, tool_end, tool_start, tool_end, usage, context_tool, turn_complete, usage, tool_start, tool_end, text, text, mviz_pending, text, mviz_html, text, usage, turn_complete
- PASS [P2] adversarial grain test filters before team aggregation: SQL: WITH team_rows AS (
  SELECT b.team_abbreviation AS team, sum(b.points) AS points
  FROM "nba_box_scores_v2"."main"."box_scores" b
  JOIN "nba_box_scores_v2"."main"."schedule" s ON b.game_id = s.game_id
  WHERE b.period = 'FullGame'
    AND b.player_name IS NULL
    AND s.season_year = 2024
    AND s.season_type = 'Regular Season'
  GROUP BY ALL
)
SELECT team, points FROM team_rows ORDER BY points DESC LIMIT 5
- PASS [P2] adversarial grain test saves a durable context rule: fragments: full-game team scoring grain, box_scores to schedule join key
- PASS [P2] adversarial grain response names the anti-double-counting filter: I treated this as a team-row analysis, not a sum across player rows. The query filters `period = FullGame` and `player_name IS NULL`, then joins schedule for the 2024 regular season.

```table size=[16,5]
{"title":"2024 Regular Season Team Scoring Leaders","columns":[{"id":"team","title":"Team","bold":true},{"id":"points","title":"Points","fmt":"num0","align":"right"}],"data":[{"team":"BOS","points":10422},{"team":"DEN","points":10051},{"team":"OKC","points":9964},{"team":"MIN","points":9818},{"
- PASS [P2] second turn applies saved grain before SQL: chart turn should reuse the saved FullGame/team-row grain rule
- PASS [P2] mviz chart renders as HTML: assistant text length: 388
- PASS [P2] adversarial unsupported-field test inspects before refusing: tools: search_catalog
- PASS [P2] adversarial unsupported-field test refuses to invent injury analysis: The visible schema does not expose injury or player-availability fields, so I cannot attribute scoring drops to injured players from this dataset. I can analyze team scoring drops using `schedule` and `box_scores`, but injury explanations would need an injury/status table or an external roster availability source.
- PASS [P2] tool request and response are visible over SSE: query tool_start must expose SQL args and tool_end must expose result text
- PASS [P1] conversation persistence reopens structured tool history: reopened messages: 8
- PASS [P2] database switching keeps conversation and schema scoped to selected DB: switch summary DB: weather_demo; switch tables: daily_weather
- PASS [P2] context query/update/delete lifecycle succeeds: context services: query_context_layer:1 context fragment(s):

### box_scores to schedule join key
id: 019e81e8-f4b4-7e55-9742-6f4b7bdea1a9
references: database:nba_box_scores_v2.main.box_scores, database:nba_box_scores_v2.main.schedule

Join nba_box_scores_v2.main.box_scores to nba_box_scores_v2.main.schedule on game_id. Use box_scores.period = FullGame for full-game player/team stats. | update_context_layer:Updated fragment "box_scores to schedule join key". | update_context_layer:Deleted fragment 019e81e8-f4b4-7e55-9742-6f4b7bdea1a9.

## Tool Calls

1. list_databases {}
2. list_tables {"database":"nba_box_scores_v2"}
3. list_columns {"database":"nba_box_scores_v2","schema":"main","table":"box_scores"}
4. list_columns {"database":"nba_box_scores_v2","schema":"main","table":"schedule"}
5. list_tables {"database":"nba_box_scores_v2"}
6. list_columns {"database":"nba_box_scores_v2","schema":"main","table":"box_scores"}
7. list_columns {"database":"nba_box_scores_v2","schema":"main","table":"schedule"}
8. query {"database":"nba_box_scores_v2","sql":"SELECT season_year, count(*) AS games FROM \"nba_box_scores_v2\".\"main\".\"schedule\" GROUP BY ALL ORDER BY season_year DESC LIMIT 3"}
9. query {"database":"nba_box_scores_v2","sql":"WITH team_rows AS (\n  SELECT b.team_abbreviation AS team, sum(b.points) AS points\n  FROM \"nba_box_scores_v2\".\"main\".\"box_scores\" b\n  JOIN \"nba_box_scores_v2\".\"main\".\"schedule\" s ON b.game_id = s.game_id\n  WHERE b.period = 'FullGame'\n    AND b.player_name IS NULL\n    AND s.season_year = 2024\n    AND s.season_type = 'Regular Season'\n  GROUP BY ALL\n)\nSELECT team, points FROM team_rows ORDER BY points DESC LIMIT 5"}
10. query {"database":"nba_box_scores_v2","sql":"SELECT team_abbreviation AS team, sum(points) AS points FROM \"nba_box_scores_v2\".\"main\".\"box_scores\" WHERE period = 'FullGame' AND player_name IS NULL GROUP BY ALL ORDER BY points DESC LIMIT 5"}
11. search_catalog {"database":"nba_box_scores_v2","query":"injury injured players availability status"}
12. list_tables {"database":"weather_demo"}

## Turn 1

User: Use nba_box_scores_v2, inspect the schema, remember the schedule join, and show recent seasons as a table.

Finish: context_pause -> context_pause -> done

Tools: list_tables, list_columns, query, query_context_layer, update_context_layer

Mviz HTML events: 1

Assistant: I inspected the schema, saved the reusable join key, and summarized recent seasons. ```table size=[16,5] {"title":"Recent NBA Seasons","columns":[{"id":"season_year","title":"Season","bold":true},{"id":"games","title":"Games","fmt":"num0","align":"right"}],"data":[{"season_year":2024,"games":1319},{"season_year":2023,"games":1318},{"season_year":2022,"games":1317}],"compact":true} ``` Saved context: box_scores joins schedule on game_id.

## Turn 2

User: Adversarial: I need the 2024 regular-season team scoring leaders. Do not double-count player rows, and save any durable grain rule you discover.

Finish: context_pause -> context_pause -> done

Tools: query, query_context_layer, update_context_layer

Mviz HTML events: 1

Assistant: I treated this as a team-row analysis, not a sum across player rows. The query filters `period = FullGame` and `player_name IS NULL`, then joins schedule for the 2024 regular season. ```table size=[16,5] {"title":"2024 Regular Season Team Scoring Leaders","columns":[{"id":"team","title":"Team","bold":true},{"id":"points","title":"Points","fmt":"num0","align":"right"}],"data":[{"team":"BOS","points":10422},{"team":"DEN","points":10051},{"team":"OKC","points":9964},{"team":"MIN","points":9818},{"t

## Turn 3

User: Use the saved context and chart total points by team.

Finish: context_pause -> done

Tools: query, query_context_layer

Mviz HTML events: 1

Assistant: Using the saved grain context, here are the top teams by full-game points from team rows only. ```bar size=[8,4] {"type":"bar","title":"Top Teams by Points","x":"team","y":"points","format":"num0","data":[{"team":"BOS","points":10422},{"team":"DEN","points":10051},{"team":"OKC","points":9964},{"team":"MIN","points":9818},{"team":"NYK","points":9721}]} ``` BOS leads this mocked slice.

## Turn 4

User: Adversarial: Which injured players explain the biggest team scoring drops? If the schema cannot support injury analysis, be explicit.

Finish: done

Tools: search_catalog

Mviz HTML events: 0

Assistant: The visible schema does not expose injury or player-availability fields, so I cannot attribute scoring drops to injured players from this dataset. I can analyze team scoring drops using `schedule` and `box_scores`, but injury explanations would need an injury/status table or an external roster availability source.

## Turn 5

User: Update the saved join note to mention period=FullGame, then delete it.

Finish: context_pause -> context_pause -> context_pause -> done

Tools: query_context_layer, update_context_layer

Mviz HTML events: 0

Assistant: Updated the saved join note to mention the FullGame filter, then deleted it as requested.
