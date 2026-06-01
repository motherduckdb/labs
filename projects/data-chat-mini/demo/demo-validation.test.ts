import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RunAgenticLoopOpts } from '@/lib/agentic-loop';
import type { StreamEvent, ChatMessage, StoredConversation } from '@/types/chat';

const idb = vi.hoisted(() => ({
  mem: new Map<string, unknown>(),
}));

vi.mock('idb-keyval', () => ({
  createStore: vi.fn((dbName: string, storeName: string) => ({ dbName, storeName })),
  get: vi.fn(async (key: string, store: { dbName: string; storeName: string }) =>
    idb.mem.get(`${store.dbName}:${store.storeName}:${key}`),
  ),
  set: vi.fn(async (key: string, val: unknown, store: { dbName: string; storeName: string }) => {
    idb.mem.set(`${store.dbName}:${store.storeName}:${key}`, val);
  }),
  del: vi.fn(async (key: string, store: { dbName: string; storeName: string }) => {
    idb.mem.delete(`${store.dbName}:${store.storeName}:${key}`);
  }),
}));

import { runAgenticLoop } from '@/lib/agentic-loop';
import { CONTEXT_TOOLS } from '@/lib/context-tools';
import { serviceContextTool, listFragments } from '@/lib/context-store';
import {
  saveConversation,
  loadConversation,
  listConversations,
  deriveTitle,
} from '@/lib/chat-storage';
import {
  executeTool,
  getFilteredTools,
  mcpToolsToAnthropicFormat,
  type MCPTool,
} from '@/lib/mcp-client';
import { getModelProfile } from '@/lib/llm-client';
import { parseColumns, parseDatabaseNames, parseTables } from '@/lib/mcp-parsers';
import { buildSystemPrompt } from '@/lib/system-prompt';
import {
  patchHistoryPlaceholders,
  rebuildHistoryFromMessages,
  type LlmTurn,
} from '@/lib/chat-history-replay';

const CANONICAL_DB = 'nba_box_scores_v2';
const SWITCH_DB = 'weather_demo';
const REPORT_DIR = path.join(process.cwd(), 'reports', 'demo-validation');

type Severity = 'P1' | 'P2' | 'P3';

interface AssertionRecord {
  name: string;
  pass: boolean;
  severity: Severity;
  detail: string;
}

interface DemoIssue {
  severity: Severity;
  title: string;
  detail: string;
  status: 'unresolved' | 'resolved';
}

interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

interface ContextServiceRecord {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  resultText: string;
  isError: boolean;
}

interface ModelCallRecord {
  index: number;
  label: string;
  messageCount: number;
  toolNames: string[];
  lastUserText: string;
}

interface TranscriptTurn {
  user: string;
  finishReasons: string[];
  assistantText: string;
  sseTypes: string[];
  toolNames: string[];
  mvizHtmlCount: number;
  contextServices: ContextServiceRecord[];
  turnHistory: LlmTurn[];
}

interface DemoArtifact {
  runId: string;
  mode: 'mock' | 'live';
  dataset: string;
  startedAt: string;
  completedAt: string;
  assertions: AssertionRecord[];
  issues: DemoIssue[];
  resolvedIssues: DemoIssue[];
  modelCalls: ModelCallRecord[];
  toolCalls: ToolCallRecord[];
  sseEvents: StreamEvent[];
  transcripts: TranscriptTurn[];
  summary: {
    p1p2Unresolved: number;
    assertionsPassed: number;
    assertionsTotal: number;
  };
}

type ScriptedToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

type ScriptedCompletion =
  | { kind: 'tool'; label: string; calls: ScriptedToolCall[] }
  | { kind: 'text'; label: string; text: string };

type ScriptFactory = () => Promise<ScriptedCompletion> | ScriptedCompletion;

afterEach(() => {
  idb.mem.clear();
});

describe('demo validation harness', () => {
  it('validates the nba_box_scores_v2 demo path and writes a repeatable report', async () => {
    const artifact = await runDemoValidation();
    await writeReports(artifact);

    const unresolvedP1P2 = artifact.issues.filter(
      (issue) => issue.status === 'unresolved' && (issue.severity === 'P1' || issue.severity === 'P2'),
    );
    expect(unresolvedP1P2).toEqual([]);
  }, 60_000);
});

async function runDemoValidation(): Promise<DemoArtifact> {
  const startedAt = new Date();
  const mode = process.env.DEMO_VALIDATE_MODE === 'live' ? 'live' : 'mock';
  const runId = `${startedAt.toISOString().replace(/[:.]/g, '-')}-${mode}`;
  const assertions: AssertionRecord[] = [];
  const issues: DemoIssue[] = [];
  const resolvedIssues: DemoIssue[] = [
    {
      severity: 'P2',
      title: 'Terminal assistant responses are stored in structured turn history',
      detail: 'The harness caught streamed final responses rendering in the UI but missing from LLM replay; runAgenticLoop now appends non-empty terminal assistant blocks.',
      status: 'resolved',
    },
    {
      severity: 'P2',
      title: 'Persisted context-tool placeholders are patched before reopen',
      detail: 'The harness exercises the context round-trip and persisted turnHistory; regression coverage lives in lib/chat-history-replay.test.ts.',
      status: 'resolved',
    },
  ];
  const modelCalls: ModelCallRecord[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const sseEvents: StreamEvent[] = [];
  const transcripts: TranscriptTurn[] = [];

  const client = await createHarnessClient(mode, toolCalls);
  const mcpTools = await getFilteredTools(client);
  const tools = [...mcpToolsToAnthropicFormat(mcpTools), ...CONTEXT_TOOLS];
  const systemPrompt = buildSystemPrompt([CANONICAL_DB]);
  const streamChatCompletion = mode === 'mock'
    ? createMockStream(modelCalls)
    : undefined;

  const record = (name: string, pass: boolean, severity: Severity, detail: string) => {
    assertions.push({ name, pass, severity, detail });
    if (!pass) issues.push({ severity, title: name, detail, status: 'unresolved' });
  };

  const databaseRaw = await executeTool(client, 'list_databases', {});
  const databaseNames = parseDatabaseNames(databaseRaw);
  record(
    'database selection lists canonical dataset',
    databaseNames.includes(CANONICAL_DB),
    'P1',
    `available databases: ${databaseNames.join(', ') || '(none)'}`,
  );

  const tablesRaw = await executeTool(client, 'list_tables', { database: CANONICAL_DB });
  const tables = parseTables(tablesRaw);
  record(
    'schema browser lists canonical tables',
    ['box_scores', 'schedule'].every((name) => tables.some((table) => table.name === name)),
    'P1',
    `tables: ${tables.map((table) => `${table.schema}.${table.name}`).join(', ') || '(none)'}`,
  );

  const boxColumnsRaw = await executeTool(client, 'list_columns', {
    database: CANONICAL_DB,
    schema: 'main',
    table: 'box_scores',
  });
  const scheduleColumnsRaw = await executeTool(client, 'list_columns', {
    database: CANONICAL_DB,
    schema: 'main',
    table: 'schedule',
  });
  const boxColumns = parseColumns(boxColumnsRaw);
  const scheduleColumns = parseColumns(scheduleColumnsRaw);
  record(
    'schema browser exposes join and metric columns',
    ['game_id', 'team_abbreviation', 'points'].every((name) => boxColumns.some((column) => column.name === name)) &&
      ['game_id', 'season_year'].every((name) => scheduleColumns.some((column) => column.name === name)),
    'P1',
    `box_scores: ${boxColumns.map((column) => column.name).join(', ')}; schedule: ${scheduleColumns.map((column) => column.name).join(', ')}`,
  );

  record(
    'system prompt includes demo-critical behavior',
    systemPrompt.includes(CANONICAL_DB) &&
      systemPrompt.includes('query_context_layer') &&
      systemPrompt.includes('Always respond after tool calls') &&
      systemPrompt.includes('NO HTML'),
    'P2',
    'prompt must name the selected DB, context tools, response-after-tools rule, and mviz/no-HTML boundary',
  );

  record(
    'tool catalog is read-only plus local context',
    hasTool(tools, 'query') &&
      hasTool(tools, 'list_tables') &&
      hasTool(tools, 'list_columns') &&
      hasTool(tools, 'list_databases') &&
      hasTool(tools, 'query_context_layer') &&
      hasTool(tools, 'update_context_layer') &&
      !hasTool(tools, 'query_rw'),
    'P1',
    `tools: ${tools.map((tool) => tool.name).join(', ')}`,
  );

  let history: LlmTurn[] = [];
  const commonLoop = {
    client,
    tools,
    profile: mode === 'mock'
      ? {
          id: 'demo/mock-llm',
          maxTokens: 16_384,
          supportsReasoning: true,
          contextWindow: 1_000_000,
        }
      : getModelProfile(),
    systemPrompt,
    streamChatCompletion,
  };

  const turn1 = await runHarnessTurn({
    ...commonLoop,
    history,
    message: 'Use nba_box_scores_v2, inspect the schema, remember the schedule join, and show recent seasons as a table.',
    sseEvents,
  });
  history = turn1.history;
  transcripts.push(turn1.transcript);

  record(
    'first turn browses schema before querying',
    toolCalls.some((call) => call.name === 'list_tables') &&
      toolCalls.some((call) => call.name === 'list_columns') &&
      toolCalls.some((call) => call.name === 'query'),
    'P2',
    `tool order: ${toolCalls.map((call) => call.name).join(' -> ')}`,
  );

  record(
    'context save creates one reusable fragment',
    (await listFragments()).length === 1,
    'P2',
    `fragments after save: ${(await listFragments()).map((fragment) => fragment.title).join(', ')}`,
  );

  record(
    'mviz table renders as HTML',
    turn1.transcript.mvizHtmlCount >= 1 &&
      turn1.transcript.sseTypes.includes('mviz_pending') &&
      !joinedTextEvents(turn1.events).includes('```table'),
    'P2',
    `sse types: ${turn1.transcript.sseTypes.join(', ')}`,
  );

  const turn2 = await runHarnessTurn({
    ...commonLoop,
    history,
    message: 'Use the saved context and chart total points by team.',
    sseEvents,
  });
  history = turn2.history;
  transcripts.push(turn2.transcript);

  record(
    'second turn queries saved context before SQL',
    turn2.transcript.contextServices.some((call) => call.name === 'query_context_layer' && call.resultText.includes('Join')),
    'P2',
    'chart turn should reuse the join key saved in the previous turn',
  );

  record(
    'mviz chart renders as HTML',
    turn2.transcript.mvizHtmlCount >= 1 &&
      turn2.transcript.assistantText.includes('```bar') &&
      !joinedTextEvents(turn2.events).includes('```bar'),
    'P2',
    `assistant text length: ${turn2.transcript.assistantText.length}`,
  );

  record(
    'tool request and response are visible over SSE',
    hasVisibleToolRequestAndResponse(turn1.events, 'query') &&
      hasVisibleToolRequestAndResponse(turn2.events, 'query'),
    'P2',
    'query tool_start must expose SQL args and tool_end must expose result text',
  );

  const savedConversation = await persistConversationForReopen([turn1.transcript, turn2.transcript]);
  const reopened = await loadConversation(savedConversation.id);
  const reopenedHistory = reopened ? rebuildHistoryFromMessages(reopened.messages) : [];
  record(
    'conversation persistence reopens structured tool history',
    !!reopened &&
      reopened.messages.every((message) => !message.isStreaming && !message.pendingContext) &&
      reopenedHistory.some((turn) => JSON.stringify(turn.content).includes('tool_result')) &&
      !JSON.stringify(reopenedHistory).includes('[context-layer call pending client round-trip]'),
    'P1',
    `reopened messages: ${reopened?.messages.length ?? 0}`,
  );

  await saveConversation({
    id: 'conv-weather-demo',
    title: 'weather switch smoke',
    createdAt: Date.now(),
    updatedAt: Date.now() + 1,
    databases: [SWITCH_DB],
    thinkingLevel: 'none',
    messages: [
      { id: 'weather-u', role: 'user', content: 'open weather', timestamp: Date.now() },
    ],
  });
  const summaries = await listConversations();
  const switchedSummary = summaries.find((summary) => summary.id === 'conv-weather-demo');
  const switchedTablesRaw = await executeTool(client, 'list_tables', { database: SWITCH_DB });
  const switchedTables = parseTables(switchedTablesRaw);
  record(
    'database switching keeps conversation and schema scoped to selected DB',
    switchedSummary?.databases[0] === SWITCH_DB &&
      switchedTables.some((table) => table.name === 'daily_weather') &&
      !switchedTables.some((table) => table.name === 'box_scores'),
    'P2',
    `switch summary DB: ${switchedSummary?.databases[0] ?? '(missing)'}; switch tables: ${switchedTables.map((table) => table.name).join(', ')}`,
  );

  const turn3 = await runHarnessTurn({
    ...commonLoop,
    history,
    message: 'Update the saved join note to mention period=FullGame, then delete it.',
    sseEvents,
  });
  history = turn3.history;
  transcripts.push(turn3.transcript);

  record(
    'context query/update/delete lifecycle succeeds',
    turn3.transcript.contextServices.some((call) => call.name === 'query_context_layer') &&
      turn3.transcript.contextServices.some((call) => call.name === 'update_context_layer' && call.resultText.includes('Updated')) &&
      turn3.transcript.contextServices.some((call) => call.name === 'update_context_layer' && call.resultText.includes('Deleted')) &&
      (await listFragments()).length === 0,
    'P2',
    `context services: ${turn3.transcript.contextServices.map((call) => `${call.name}:${call.resultText}`).join(' | ')}`,
  );

  const completedAt = new Date();
  const assertionsPassed = assertions.filter((assertion) => assertion.pass).length;
  const p1p2Unresolved = issues.filter(
    (issue) => issue.status === 'unresolved' && (issue.severity === 'P1' || issue.severity === 'P2'),
  ).length;

  try { await client.close(); } catch { /* mock/live cleanup best effort */ }

  return {
    runId,
    mode,
    dataset: CANONICAL_DB,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    assertions,
    issues,
    resolvedIssues,
    modelCalls,
    toolCalls,
    sseEvents,
    transcripts,
    summary: {
      p1p2Unresolved,
      assertionsPassed,
      assertionsTotal: assertions.length,
    },
  };
}

async function runHarnessTurn(opts: {
  history: LlmTurn[];
  message: string;
  client: Client;
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  profile: RunAgenticLoopOpts['profile'];
  systemPrompt: string;
  streamChatCompletion?: RunAgenticLoopOpts['streamChatCompletion'];
  sseEvents: StreamEvent[];
}): Promise<{ history: LlmTurn[]; transcript: TranscriptTurn; events: StreamEvent[] }> {
  let history = opts.history;
  let firstRun = true;
  let guard = 0;
  const finishReasons: string[] = [];
  const events: StreamEvent[] = [];
  const turnHistory: LlmTurn[] = [];
  const contextServices: ContextServiceRecord[] = [];

  while (guard++ < 10) {
    const messages: LlmTurn[] = firstRun
      ? [...history, { role: 'user', content: opts.message }]
      : history;
    const turnStartIndex = messages.length;
    const result = await runAgenticLoop({
      messages,
      turnStartIndex,
      profile: opts.profile,
      thinkingLevel: 'none',
      client: opts.client,
      tools: opts.tools,
      systemPrompt: opts.systemPrompt,
      emit: (chunk) => {
        const parsed = parseSseChunk(chunk);
        events.push(...parsed);
        opts.sseEvents.push(...parsed);
      },
      taskId: `demo:${Date.now()}`,
      runId: `demo_${Date.now()}`,
      requestText: firstRun ? opts.message : '',
      historyLength: history.length,
      ...(opts.streamChatCompletion && { streamChatCompletion: opts.streamChatCompletion }),
    });

    finishReasons.push(result.finishReason);
    history = result.finalMessages as LlmTurn[];
    turnHistory.push(...(result.newTurnMessages as LlmTurn[]));

    if (result.finishReason !== 'context_pause') break;

    const contextCalls = events
      .filter((event) => event.type === 'context_tool' && event.contextCall)
      .slice(contextServices.length)
      .map((event) => event.contextCall!);

    const resolved = [];
    for (const call of contextCalls) {
      const serviced = await serviceContextTool(call.name, call.args);
      contextServices.push({
        callId: call.callId,
        name: call.name,
        args: call.args,
        resultText: serviced.resultText,
        isError: serviced.isError,
      });
      resolved.push({
        callId: call.callId,
        resultText: serviced.resultText,
        isError: serviced.isError,
      });
    }

    patchHistoryPlaceholders(history, resolved);
    patchHistoryPlaceholders(turnHistory, resolved);
    firstRun = false;
  }

  if (guard >= 10) {
    throw new Error(`Context/tool resume loop exceeded guard for "${opts.message}"`);
  }

  const assistantText = extractAssistantText(turnHistory);
  const toolNames = [
    ...new Set([
      ...events
        .filter((event) => event.type === 'tool_start' && event.toolCall)
        .map((event) => event.toolCall!.name),
      ...contextServices.map((call) => call.name),
    ]),
  ];

  return {
    history,
    transcript: {
      user: opts.message,
      finishReasons,
      assistantText,
      sseTypes: events.map((event) => event.type),
      toolNames,
      mvizHtmlCount: events.filter((event) => event.type === 'mviz_html').length,
      contextServices,
      turnHistory,
    },
    events,
  };
}

async function persistConversationForReopen(turns: TranscriptTurn[]): Promise<StoredConversation> {
  const now = Date.now();
  const messages: ChatMessage[] = [];
  turns.forEach((turn, index) => {
    messages.push({
      id: `u-${index}`,
      role: 'user',
      content: turn.user,
      timestamp: now + index * 2,
    });
    messages.push({
      id: `a-${index}`,
      role: 'assistant',
      content: turn.assistantText,
      timestamp: now + index * 2 + 1,
      isStreaming: index === 0,
      pendingContext: index === 0
        ? [{ callId: 'stale', name: 'query_context_layer', args: { query: 'stale' } }]
        : undefined,
      turnHistory: turn.turnHistory,
    });
  });
  const conv: StoredConversation = {
    id: 'conv-nba-demo',
    title: deriveTitle(messages),
    createdAt: now,
    updatedAt: now,
    databases: [CANONICAL_DB],
    thinkingLevel: 'none',
    messages,
  };
  await saveConversation(conv);
  return conv;
}

function createMockStream(modelCalls: ModelCallRecord[]): NonNullable<RunAgenticLoopOpts['streamChatCompletion']> {
  const script = createMockScript();
  return async (params) => {
    const next = script.shift();
    if (!next) {
      throw new Error(`Mock LLM script exhausted after ${modelCalls.length} calls`);
    }
    const completion = await next();
    modelCalls.push({
      index: modelCalls.length + 1,
      label: completion.label,
      messageCount: params.messages.length,
      toolNames: (params.tools ?? []).map((tool) => tool.name),
      lastUserText: findLastUserText(params.messages),
    });
    return completionToStream(completion, modelCalls.length);
  };
}

function createMockScript(): ScriptFactory[] {
  return [
    () => ({
      kind: 'tool',
      label: 'turn1 lookup existing context',
      calls: [
        {
          id: 'ctx_lookup_1',
          name: 'query_context_layer',
          args: {
            query: 'box_scores schedule join',
            reference: `database:${CANONICAL_DB}.main.box_scores`,
          },
        },
      ],
    }),
    () => ({
      kind: 'tool',
      label: 'turn1 browse schema',
      calls: [
        { id: 'list_tables_1', name: 'list_tables', args: { database: CANONICAL_DB } },
        { id: 'list_columns_box', name: 'list_columns', args: { database: CANONICAL_DB, schema: 'main', table: 'box_scores' } },
        { id: 'list_columns_schedule', name: 'list_columns', args: { database: CANONICAL_DB, schema: 'main', table: 'schedule' } },
      ],
    }),
    () => ({
      kind: 'tool',
      label: 'turn1 save join context',
      calls: [
        {
          id: 'ctx_save_1',
          name: 'update_context_layer',
          args: {
            action: 'create',
            title: 'box_scores to schedule join key',
            content:
              'Join nba_box_scores_v2.main.box_scores to nba_box_scores_v2.main.schedule on game_id. Use box_scores.period = FullGame for full-game player/team stats.',
            references: [
              `database:${CANONICAL_DB}.main.box_scores`,
              `database:${CANONICAL_DB}.main.schedule`,
            ],
          },
        },
      ],
    }),
    () => ({
      kind: 'tool',
      label: 'turn1 query recent seasons',
      calls: [
        {
          id: 'query_recent_seasons',
          name: 'query',
          args: {
            database: CANONICAL_DB,
            sql:
              `SELECT season_year, count(*) AS games FROM "${CANONICAL_DB}"."main"."schedule" GROUP BY ALL ORDER BY season_year DESC LIMIT 3`,
          },
        },
      ],
    }),
    () => ({
      kind: 'text',
      label: 'turn1 table response',
      text:
        'I inspected the schema, saved the reusable join key, and summarized recent seasons.\n\n' +
        '```table size=[16,5]\n' +
        JSON.stringify({
          title: 'Recent NBA Seasons',
          columns: [
            { id: 'season_year', title: 'Season', bold: true },
            { id: 'games', title: 'Games', fmt: 'num0', align: 'right' },
          ],
          data: [
            { season_year: 2024, games: 1319 },
            { season_year: 2023, games: 1318 },
            { season_year: 2022, games: 1317 },
          ],
          compact: true,
        }) +
        '\n```\n\nSaved context: box_scores joins schedule on game_id.',
    }),
    () => ({
      kind: 'tool',
      label: 'turn2 lookup saved context',
      calls: [
        {
          id: 'ctx_lookup_2',
          name: 'query_context_layer',
          args: { query: 'schedule join', reference: `database:${CANONICAL_DB}.main.schedule` },
        },
      ],
    }),
    () => ({
      kind: 'tool',
      label: 'turn2 query team points',
      calls: [
        {
          id: 'query_team_points',
          name: 'query',
          args: {
            database: CANONICAL_DB,
            sql:
              `SELECT team_abbreviation AS team, sum(points) AS points FROM "${CANONICAL_DB}"."main"."box_scores" WHERE period = 'FullGame' GROUP BY ALL ORDER BY points DESC LIMIT 5`,
          },
        },
      ],
    }),
    () => ({
      kind: 'text',
      label: 'turn2 chart response',
      text:
        'Using the saved join context, here are the top teams by full-game points.\n\n' +
        '```bar size=[8,4]\n' +
        JSON.stringify({
          type: 'bar',
          title: 'Top Teams by Points',
          x: 'team',
          y: 'points',
          format: 'num0',
          data: [
            { team: 'BOS', points: 10422 },
            { team: 'DEN', points: 10051 },
            { team: 'OKC', points: 9964 },
            { team: 'MIN', points: 9818 },
            { team: 'NYK', points: 9721 },
          ],
        }) +
        '\n```\n\nBOS leads this mocked slice.',
    }),
    () => ({
      kind: 'tool',
      label: 'turn3 lookup fragment for update/delete',
      calls: [
        { id: 'ctx_lookup_3', name: 'query_context_layer', args: { query: 'FullGame join' } },
      ],
    }),
    async () => {
      const fragment = (await listFragments())[0];
      return {
        kind: 'tool',
        label: 'turn3 update fragment',
        calls: [
          {
            id: 'ctx_update_1',
            name: 'update_context_layer',
            args: {
              action: 'update',
              id: fragment?.id ?? 'missing-fragment',
              title: 'box_scores to schedule join key',
              content:
                'Join nba_box_scores_v2.main.box_scores to nba_box_scores_v2.main.schedule on game_id. Filter box_scores.period = FullGame for full-game stats before aggregating.',
              references: [
                `database:${CANONICAL_DB}.main.box_scores`,
                `database:${CANONICAL_DB}.main.schedule`,
              ],
            },
          },
        ],
      };
    },
    async () => {
      const fragment = (await listFragments())[0];
      return {
        kind: 'tool',
        label: 'turn3 delete fragment',
        calls: [
          {
            id: 'ctx_delete_1',
            name: 'update_context_layer',
            args: { action: 'delete', id: fragment?.id ?? 'missing-fragment' },
          },
        ],
      };
    },
    () => ({
      kind: 'text',
      label: 'turn3 lifecycle response',
      text: 'Updated the saved join note to mention the FullGame filter, then deleted it as requested.',
    }),
  ];
}

function completionToStream(completion: ScriptedCompletion, usageSeed: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payloads: Record<string, unknown>[] = [];
  if (completion.kind === 'tool') {
    payloads.push({
      choices: [
        {
          delta: {
            tool_calls: completion.calls.map((call, index) => ({
              index,
              id: call.id,
              type: 'function',
              function: {
                name: call.name,
                arguments: JSON.stringify(call.args),
              },
            })),
          },
        },
      ],
    });
    payloads.push({
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 100 + usageSeed, completion_tokens: 10 + usageSeed, cost: 0 },
    });
  } else {
    for (const chunk of splitEvery(completion.text, 64)) {
      payloads.push({ choices: [{ delta: { content: chunk } }] });
    }
    payloads.push({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120 + usageSeed, completion_tokens: 30 + usageSeed, cost: 0 },
    });
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const payload of payloads) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

async function createHarnessClient(
  mode: 'mock' | 'live',
  toolCalls: ToolCallRecord[],
): Promise<Client> {
  if (mode === 'live') {
    if (!process.env.MOTHERDUCK_TOKEN || !process.env.OPENROUTER_API_KEY) {
      throw new Error('DEMO_VALIDATE_MODE=live requires MOTHERDUCK_TOKEN and OPENROUTER_API_KEY.');
    }
    const { createMCPClient } = await import('@/lib/mcp-client');
    return createMCPClient('demo-validation-live');
  }
  return new MockMcpClient(toolCalls) as unknown as Client;
}

class MockMcpClient {
  constructor(private readonly toolCalls: ToolCallRecord[]) {}

  async listTools(): Promise<{ tools: MCPTool[] }> {
    return {
      tools: [
        toolDef('query', { database: { type: 'string' }, sql: { type: 'string' } }),
        toolDef('list_databases', {}),
        toolDef('list_tables', { database: { type: 'string' }, schema: { type: 'string' } }),
        toolDef('list_columns', { database: { type: 'string' }, schema: { type: 'string' }, table: { type: 'string' } }),
        toolDef('search_catalog', { database: { type: 'string' }, query: { type: 'string' } }),
        toolDef('ask_docs_question', { question: { type: 'string' } }),
      ],
    };
  }

  async callTool(request: { name: string; arguments?: Record<string, unknown> }): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    const name = request.name;
    const args = request.arguments ?? {};
    const result = mockToolResult(name, args);
    this.toolCalls.push({ name, args, result });
    return { content: [{ type: 'text', text: result }], isError: false };
  }

  async close(): Promise<void> {
    return;
  }
}

function toolDef(name: string, properties: Record<string, unknown>): MCPTool {
  return {
    name,
    description: `Mock ${name}`,
    inputSchema: {
      type: 'object',
      properties,
    },
  };
}

function mockToolResult(name: string, args: Record<string, unknown>): string {
  if (name === 'list_databases') {
    return JSON.stringify({
      databases: [
        { alias: CANONICAL_DB, name: CANONICAL_DB, type: 'database' },
        { alias: SWITCH_DB, name: SWITCH_DB, type: 'database' },
      ],
    });
  }
  if (name === 'list_tables') {
    if (args.database === SWITCH_DB) {
      return JSON.stringify({
        success: true,
        tables: [
          { schema: 'main', name: 'daily_weather', type: 'table' },
        ],
      });
    }
    return JSON.stringify({
      success: true,
      tables: [
        { schema: 'main', name: 'schedule', type: 'table', comment: 'NBA games by date and team matchup' },
        { schema: 'main', name: 'box_scores', type: 'table', comment: 'Player and team box score rows' },
      ],
    });
  }
  if (name === 'list_columns') {
    const table = String(args.table ?? '');
    if (table === 'box_scores') {
      return JSON.stringify({
        success: true,
        columns: [
          { name: 'game_id', type: 'VARCHAR', nullable: false },
          { name: 'entity_id', type: 'VARCHAR', nullable: true },
          { name: 'player_name', type: 'VARCHAR', nullable: true },
          { name: 'team_abbreviation', type: 'VARCHAR', nullable: true },
          { name: 'period', type: 'VARCHAR', nullable: false },
          { name: 'points', type: 'INTEGER', nullable: true },
        ],
      });
    }
    if (table === 'schedule') {
      return JSON.stringify({
        success: true,
        columns: [
          { name: 'game_id', type: 'VARCHAR', nullable: false },
          { name: 'game_date', type: 'DATE', nullable: true },
          { name: 'season_year', type: 'INTEGER', nullable: true },
          { name: 'season_type', type: 'VARCHAR', nullable: true },
          { name: 'home_team_abbreviation', type: 'VARCHAR', nullable: true },
          { name: 'away_team_abbreviation', type: 'VARCHAR', nullable: true },
        ],
      });
    }
    return JSON.stringify({ success: true, columns: [] });
  }
  if (name === 'query') {
    const sql = String(args.sql ?? '');
    if (/season_year/i.test(sql)) {
      return JSON.stringify({
        columns: ['season_year', 'games'],
        rows: [
          { season_year: 2024, games: 1319 },
          { season_year: 2023, games: 1318 },
          { season_year: 2022, games: 1317 },
        ],
      });
    }
    if (/team_abbreviation/i.test(sql)) {
      return JSON.stringify({
        columns: ['team', 'points'],
        rows: [
          { team: 'BOS', points: 10422 },
          { team: 'DEN', points: 10051 },
          { team: 'OKC', points: 9964 },
          { team: 'MIN', points: 9818 },
          { team: 'NYK', points: 9721 },
        ],
      });
    }
    return JSON.stringify({ columns: [], rows: [] });
  }
  if (name === 'search_catalog') {
    return JSON.stringify({ results: [{ database: CANONICAL_DB, schema: 'main', table: 'box_scores' }] });
  }
  if (name === 'ask_docs_question') {
    return 'DuckDB supports GROUP BY ALL and SELECT * EXCLUDE.';
  }
  return JSON.stringify({ success: true });
}

function parseSseChunk(chunk: Uint8Array): StreamEvent[] {
  const text = new TextDecoder().decode(chunk);
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6).trim())
    .filter((line) => line && line !== '[DONE]')
    .map((line) => JSON.parse(line) as StreamEvent);
}

function extractAssistantText(turnHistory: LlmTurn[]): string {
  const parts: string[] = [];
  for (const turn of turnHistory) {
    if (turn.role !== 'assistant') continue;
    if (typeof turn.content === 'string') {
      parts.push(turn.content);
    } else if (Array.isArray(turn.content)) {
      for (const block of turn.content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      }
    }
  }
  return parts.join('\n');
}

function hasTool(tools: Array<{ name: string }>, name: string): boolean {
  return tools.some((tool) => tool.name === name);
}

function joinedTextEvents(events: StreamEvent[]): string {
  return events
    .filter((event) => event.type === 'text' && typeof event.content === 'string')
    .map((event) => event.content)
    .join('');
}

function hasVisibleToolRequestAndResponse(events: StreamEvent[], name: string): boolean {
  const starts = events.filter((event) => event.type === 'tool_start' && event.toolCall?.name === name);
  const ends = events.filter((event) => event.type === 'tool_end' && event.toolCall?.name === name);
  return starts.some((event) => JSON.stringify(event.toolCall?.args ?? {}).includes('sql')) &&
    ends.some((event) => typeof event.toolCall?.result === 'string' && event.toolCall.result.length > 0);
}

function findLastUserText(messages: Array<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'user' && typeof message.content === 'string') return message.content;
  }
  return '';
}

function splitEvery(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

async function writeReports(artifact: DemoArtifact): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  const json = JSON.stringify(artifact, null, 2);
  const markdown = renderMarkdownReport(artifact);
  await writeFile(path.join(REPORT_DIR, `${artifact.runId}.json`), json);
  await writeFile(path.join(REPORT_DIR, `${artifact.runId}.md`), markdown);
  await writeFile(path.join(REPORT_DIR, 'latest.json'), json);
  await writeFile(path.join(REPORT_DIR, 'latest.md'), markdown);
}

function renderMarkdownReport(artifact: DemoArtifact): string {
  const unresolved = artifact.issues.filter((issue) => issue.status === 'unresolved');
  const toolSummary = artifact.toolCalls
    .map((call, index) => `${index + 1}. ${call.name} ${JSON.stringify(call.args)}`)
    .join('\n');
  const transcriptSummary = artifact.transcripts
    .map((turn, index) => {
      const assistant = turn.assistantText.replace(/\s+/g, ' ').slice(0, 500);
      return `## Turn ${index + 1}\n\nUser: ${turn.user}\n\nFinish: ${turn.finishReasons.join(' -> ')}\n\nTools: ${turn.toolNames.join(', ') || '(none)'}\n\nMviz HTML events: ${turn.mvizHtmlCount}\n\nAssistant: ${assistant}`;
    })
    .join('\n\n');
  return `# Demo Validation Report

- Run: ${artifact.runId}
- Mode: ${artifact.mode}
- Dataset: ${artifact.dataset}
- Completed: ${artifact.completedAt}
- Assertions: ${artifact.summary.assertionsPassed}/${artifact.summary.assertionsTotal}
- Unresolved P1/P2: ${artifact.summary.p1p2Unresolved}

## Issues

${unresolved.length ? unresolved.map((issue) => `- ${issue.severity} ${issue.title}: ${issue.detail}`).join('\n') : 'No unresolved issues.'}

## Resolved Findings

${artifact.resolvedIssues.map((issue) => `- ${issue.severity} ${issue.title}: ${issue.detail}`).join('\n')}

## Assertions

${artifact.assertions.map((assertion) => `- ${assertion.pass ? 'PASS' : 'FAIL'} [${assertion.severity}] ${assertion.name}: ${assertion.detail}`).join('\n')}

## Tool Calls

${toolSummary || '(none)'}

${transcriptSummary}
`;
}
