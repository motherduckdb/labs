# Demo Validation Report

- Run: 2026-06-01T06-03-24-233Z-mock
- Mode: mock
- Dataset: nba_box_scores_v2
- Completed: 2026-06-01T06:03:24.399Z
- Assertions: 14/14
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
- PASS [P2] system prompt includes demo-critical behavior: prompt must name the selected DB, context tools, response-after-tools rule, and mviz/no-HTML boundary
- PASS [P1] tool catalog is read-only plus local context: tools: query, list_databases, list_tables, list_columns, search_catalog, ask_docs_question, query_context_layer, update_context_layer
- PASS [P2] first turn browses schema before querying: tool order: list_databases -> list_tables -> list_columns -> list_columns -> list_tables -> list_columns -> list_columns -> query
- PASS [P2] context save creates one reusable fragment: fragments after save: box_scores to schedule join key
- PASS [P2] mviz table renders as HTML: sse types: usage, context_tool, turn_complete, usage, tool_start, tool_end, tool_start, tool_end, tool_start, tool_end, usage, context_tool, turn_complete, usage, tool_start, tool_end, text, text, mviz_pending, text, mviz_html, text, usage, turn_complete
- PASS [P2] second turn queries saved context before SQL: chart turn should reuse the join key saved in the previous turn
- PASS [P2] mviz chart renders as HTML: assistant text length: 367
- PASS [P2] tool request and response are visible over SSE: query tool_start must expose SQL args and tool_end must expose result text
- PASS [P1] conversation persistence reopens structured tool history: reopened messages: 4
- PASS [P2] database switching keeps conversation and schema scoped to selected DB: switch summary DB: weather_demo; switch tables: daily_weather
- PASS [P2] context query/update/delete lifecycle succeeds: context services: query_context_layer:1 context fragment(s):

### box_scores to schedule join key
id: 019e81c7-a0cd-7922-a981-3818aef98b72
references: database:nba_box_scores_v2.main.box_scores, database:nba_box_scores_v2.main.schedule

Join nba_box_scores_v2.main.box_scores to nba_box_scores_v2.main.schedule on game_id. Use box_scores.period = FullGame for full-game player/team stats. | update_context_layer:Updated fragment "box_scores to schedule join key". | update_context_layer:Deleted fragment 019e81c7-a0cd-7922-a981-3818aef98b72.

## Tool Calls

1. list_databases {}
2. list_tables {"database":"nba_box_scores_v2"}
3. list_columns {"database":"nba_box_scores_v2","schema":"main","table":"box_scores"}
4. list_columns {"database":"nba_box_scores_v2","schema":"main","table":"schedule"}
5. list_tables {"database":"nba_box_scores_v2"}
6. list_columns {"database":"nba_box_scores_v2","schema":"main","table":"box_scores"}
7. list_columns {"database":"nba_box_scores_v2","schema":"main","table":"schedule"}
8. query {"database":"nba_box_scores_v2","sql":"SELECT season_year, count(*) AS games FROM \"nba_box_scores_v2\".\"main\".\"schedule\" GROUP BY ALL ORDER BY season_year DESC LIMIT 3"}
9. query {"database":"nba_box_scores_v2","sql":"SELECT team_abbreviation AS team, sum(points) AS points FROM \"nba_box_scores_v2\".\"main\".\"box_scores\" WHERE period = 'FullGame' GROUP BY ALL ORDER BY points DESC LIMIT 5"}
10. list_tables {"database":"weather_demo"}

## Turn 1

User: Use nba_box_scores_v2, inspect the schema, remember the schedule join, and show recent seasons as a table.

Finish: context_pause -> context_pause -> done

Tools: list_tables, list_columns, query, query_context_layer, update_context_layer

Mviz HTML events: 1

Assistant: I inspected the schema, saved the reusable join key, and summarized recent seasons. ```table size=[16,5] {"title":"Recent NBA Seasons","columns":[{"id":"season_year","title":"Season","bold":true},{"id":"games","title":"Games","fmt":"num0","align":"right"}],"data":[{"season_year":2024,"games":1319},{"season_year":2023,"games":1318},{"season_year":2022,"games":1317}],"compact":true} ``` Saved context: box_scores joins schedule on game_id.

## Turn 2

User: Use the saved context and chart total points by team.

Finish: context_pause -> done

Tools: query, query_context_layer

Mviz HTML events: 1

Assistant: Using the saved join context, here are the top teams by full-game points. ```bar size=[8,4] {"type":"bar","title":"Top Teams by Points","x":"team","y":"points","format":"num0","data":[{"team":"BOS","points":10422},{"team":"DEN","points":10051},{"team":"OKC","points":9964},{"team":"MIN","points":9818},{"team":"NYK","points":9721}]} ``` BOS leads this mocked slice.

## Turn 3

User: Update the saved join note to mention period=FullGame, then delete it.

Finish: context_pause -> context_pause -> context_pause -> done

Tools: query_context_layer, update_context_layer

Mviz HTML events: 0

Assistant: Updated the saved join note to mention the FullGame filter, then deleted it as requested.
