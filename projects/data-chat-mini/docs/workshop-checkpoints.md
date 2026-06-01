# Data Chat Mini Workshop Checkpoints

This branch stack reconstructs `projects/data-chat-mini` in the same order as
the "Building a Data Agent in 60 Minutes" cook segment.

| Tag | Capability | Quick check |
| --- | --- | --- |
| `data-chat-mini-step-01` | Data ground truth | Plain `SELECT` against `nba_box_scores_v2`; show `period = 'FullGame'` grain. |
| `data-chat-mini-step-02` | MCP `query` tool | Call `query` by hand and get rows back. |
| `data-chat-mini-step-03` | Read-scaling token | Connect with `MOTHERDUCK_TOKEN` plus a per-browser session id. |
| `data-chat-mini-step-04` | Tool allowlist | See `query_rw` rejected before dispatch. |
| `data-chat-mini-step-05` | Model client | Call OpenRouter and get a model response. |
| `data-chat-mini-step-06` | Agentic loop | Ask "how many games are in the schedule?" and watch it call `query`. |
| `data-chat-mini-step-07` | System prompt | The model explores before guessing and answers in prose. |
| `data-chat-mini-step-08` | Schema tools | List tables/columns and show the schema sidebar. |
| `data-chat-mini-step-09` | Streaming UI | Tool calls and the answer stream into the UI. |
| `data-chat-mini-step-10` | Charts | Ask for a bar chart and render mviz inline. |
| `data-chat-mini-step-11` | History | Refresh and keep the conversation. |
| `data-chat-mini-step-12` | Context intercept | Teach a definition; browser services context from IndexedDB. |
| `data-chat-mini-step-13` | Telemetry | Replay prompts, tool calls, cost, and latency from controllog. |
