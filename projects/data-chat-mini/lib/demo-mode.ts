import validationArtifact from '@/reports/demo-validation/latest.json';
import { clearConversations } from './chat-storage';
import { applyUpdate, clearFragments, listFragments } from './context-store';
import type { ChatMessage, ContentSegment, Step, StreamEvent } from '@/types/chat';
import type { SchemaColumn, SchemaTable } from './mcp-parsers';

export const CANONICAL_DEMO_DATABASE = 'nba_box_scores_v2';

export type DemoStepId =
  | 'pick-database'
  | 'inspect-schema'
  | 'adversarial-grain'
  | 'chart-with-context'
  | 'unsupported-injuries'
  | 'reset-workshop';

export interface DemoStep {
  id: DemoStepId;
  order: number;
  title: string;
  eyebrow: string;
  presenterGoal: string;
  samplePrompt?: string;
  expectedLearning: string;
  whyItMatters: string;
  expectedActivity: string[];
  transcriptIndex?: number;
}

export interface DemoModeState {
  enabled: boolean;
  replay: boolean;
  activeStepId: DemoStepId;
}

interface DemoTranscript {
  user: string;
  assistantText: string;
  sseTypes: string[];
  contextServices: Array<{
    callId: string;
    name: string;
    args: Record<string, unknown>;
    resultText: string;
    isError: boolean;
  }>;
  turnHistory: Array<{ role: string; content: unknown }>;
}

interface DemoValidationArtifact {
  dataset: string;
  transcripts: DemoTranscript[];
  sseEvents: StreamEvent[];
}

export const DEMO_STEPS: DemoStep[] = [
  {
    id: 'pick-database',
    order: 1,
    title: 'Pick nba_box_scores_v2',
    eyebrow: 'Setup',
    presenterGoal: 'Start from the canonical workshop database and keep the session scoped to one read-only dataset.',
    expectedLearning: 'Attendees see that the assistant is grounded in a selected MotherDuck database before it chats.',
    whyItMatters:
      'Data chat gets trustworthy when the app makes scope obvious. A visible database choice prevents accidental cross-database context and keeps the demo explainable.',
    expectedActivity: ['database selection', 'read-only session scope'],
  },
  {
    id: 'inspect-schema',
    order: 2,
    title: 'Inspect schema and save context',
    eyebrow: 'Grounding',
    presenterGoal: 'Have the assistant inspect tables, find the schedule join, save the durable join note, and show a first mviz table.',
    samplePrompt:
      'Use nba_box_scores_v2, inspect the schema, remember the schedule join, and show recent seasons as a table.',
    expectedLearning: 'Schema browsing and local context writes turn a one-off answer into reusable workshop knowledge.',
    whyItMatters:
      'The model should not guess table structure. This step demonstrates traceable exploration, a reusable join rule, and an answer artifact in one compact pass.',
    expectedActivity: ['context read', 'schema exploration', 'context write', 'SQL query', 'mviz render', 'final answer'],
    transcriptIndex: 0,
  },
  {
    id: 'adversarial-grain',
    order: 3,
    title: 'Ask the grain trap',
    eyebrow: 'Correctness',
    presenterGoal: 'Ask for team scoring leaders while explicitly warning against double-counting player rows.',
    samplePrompt:
      'Adversarial: I need the 2024 regular-season team scoring leaders. Do not double-count player rows, and save any durable grain rule you discover.',
    expectedLearning: 'The assistant establishes the result grain before aggregation and persists the FullGame/team-row rule.',
    whyItMatters:
      'Analytical assistants fail quietly when they aggregate at the wrong grain. The visible SQL and saved context make the guardrail inspectable.',
    expectedActivity: ['context read', 'SQL query', 'context write', 'mviz render', 'final answer'],
    transcriptIndex: 1,
  },
  {
    id: 'chart-with-context',
    order: 4,
    title: 'Chart using saved context',
    eyebrow: 'Reuse',
    presenterGoal: 'Ask a short follow-up and let the assistant pull the saved grain rule before charting.',
    samplePrompt: 'Use the saved context and chart total points by team.',
    expectedLearning: 'Durable local context changes the next answer without adding hidden server-side state.',
    whyItMatters:
      'Workshop attendees can see the context layer pay off: the prompt is short, the SQL still applies the saved FullGame/team-row filter, and the chart is integrated inline.',
    expectedActivity: ['context read', 'SQL query', 'mviz render', 'final answer'],
    transcriptIndex: 2,
  },
  {
    id: 'unsupported-injuries',
    order: 5,
    title: 'Refuse unsupported injury analysis',
    eyebrow: 'Safety',
    presenterGoal: 'Ask for an analysis the schema cannot support and show a refusal that stays helpful.',
    samplePrompt:
      'Adversarial: Which injured players explain the biggest team scoring drops? If the schema cannot support injury analysis, be explicit.',
    expectedLearning: 'A polished data-chat app says what the data cannot prove instead of inventing missing columns.',
    whyItMatters:
      'Answer-oriented does not mean answer-at-all-costs. Unsupported claims need a clear boundary and a useful alternative path.',
    expectedActivity: ['schema exploration', 'final answer'],
    transcriptIndex: 3,
  },
  {
    id: 'reset-workshop',
    order: 6,
    title: 'Reset for the room',
    eyebrow: 'Presenter',
    presenterGoal: 'Clear local conversations and context so the next run starts fresh.',
    expectedLearning: 'The workshop can be replayed from a clean browser state without touching MotherDuck data.',
    whyItMatters:
      'Presenter-safe reset keeps browser-only state from leaking between sessions while preserving the app’s read-only data boundary.',
    expectedActivity: ['clear browser history', 'clear local context'],
  },
];

export const DEMO_SCHEMA_TABLES: SchemaTable[] = [
  { schema: 'main', name: 'schedule', type: 'table', comment: 'NBA games by date, season, and matchup.' },
  { schema: 'main', name: 'box_scores', type: 'table', comment: 'Mixed player and team box-score rows.' },
];

export const DEMO_SCHEMA_COLUMNS: Record<string, SchemaColumn[]> = {
  'main.schedule': [
    { name: 'game_id', type: 'VARCHAR', nullable: false, comment: 'Stable game identifier shared with box_scores.' },
    { name: 'game_date', type: 'DATE', nullable: true, comment: 'Calendar date when the game was played.' },
    { name: 'season_year', type: 'INTEGER', nullable: true, comment: 'Season label used for year-level filtering.' },
    { name: 'season_type', type: 'VARCHAR', nullable: true, comment: 'Regular Season, Playoffs, or other NBA season segment.' },
    { name: 'home_team_abbreviation', type: 'VARCHAR', nullable: true, comment: 'Three-letter abbreviation for the home team.' },
    { name: 'away_team_abbreviation', type: 'VARCHAR', nullable: true, comment: 'Three-letter abbreviation for the away team.' },
  ],
  'main.box_scores': [
    { name: 'game_id', type: 'VARCHAR', nullable: false, comment: 'Join key to schedule.game_id.' },
    { name: 'entity_id', type: 'VARCHAR', nullable: true, comment: 'Player or team entity identifier for the row.' },
    { name: 'player_name', type: 'VARCHAR', nullable: true, comment: 'Null on team-level rows; populated for player rows.' },
    { name: 'team_abbreviation', type: 'VARCHAR', nullable: true, comment: 'Three-letter team abbreviation associated with the row.' },
    { name: 'period', type: 'VARCHAR', nullable: false, comment: 'Game period label; FullGame is used for full-game totals.' },
    { name: 'points', type: 'INTEGER', nullable: true, comment: 'Points scored at the row grain.' },
  ],
};

const replayArtifact = validationArtifact as unknown as DemoValidationArtifact;

export function getDemoStep(id: DemoStepId): DemoStep {
  return DEMO_STEPS.find((step) => step.id === id) ?? DEMO_STEPS[0];
}

export function getPromptForStep(id: DemoStepId): string {
  return getDemoStep(id).samplePrompt ?? '';
}

export function getReplayTurnForPrompt(
  prompt: string,
  now = Date.now(),
): { step: DemoStep; userMessage: ChatMessage; assistantMessage: ChatMessage } | null {
  const normalized = normalizePrompt(prompt);
  const step = DEMO_STEPS.find((candidate) =>
    candidate.samplePrompt && normalizePrompt(candidate.samplePrompt) === normalized,
  );
  if (!step || step.transcriptIndex === undefined) return null;
  return getReplayTurnForStep(step.id, now);
}

export function getReplayTurnForStep(
  id: DemoStepId,
  now = Date.now(),
): { step: DemoStep; userMessage: ChatMessage; assistantMessage: ChatMessage } | null {
  const step = getDemoStep(id);
  if (step.transcriptIndex === undefined) return null;
  const transcript = replayArtifact.transcripts[step.transcriptIndex];
  const events = splitReplayEventsByTurn(replayArtifact)[step.transcriptIndex] ?? [];
  if (!transcript) return null;

  return {
    step,
    userMessage: {
      id: `demo-user-${step.id}-${now}`,
      role: 'user',
      content: transcript.user,
      timestamp: now,
    },
    assistantMessage: buildReplayAssistantMessage(step, transcript, events, now + 1),
  };
}

export async function resetDemoWorkspace(): Promise<void> {
  await Promise.all([clearConversations(), clearFragments()]);
}

export async function applyReplaySideEffects(stepId: DemoStepId): Promise<void> {
  if (stepId === 'inspect-schema') {
    await ensureDemoFragment({
      title: 'box_scores to schedule join key',
      content:
        'Join nba_box_scores_v2.main.box_scores to nba_box_scores_v2.main.schedule on game_id. Use box_scores.period = FullGame for full-game player/team stats.',
      references: [
        `database:${CANONICAL_DEMO_DATABASE}.main.box_scores`,
        `database:${CANONICAL_DEMO_DATABASE}.main.schedule`,
      ],
    });
  }
  if (stepId === 'adversarial-grain' || stepId === 'chart-with-context') {
    await ensureDemoFragment({
      title: 'full-game team scoring grain',
      content:
        'For team scoring totals in nba_box_scores_v2.main.box_scores, filter period = FullGame and player_name IS NULL before summing points. This avoids double-counting player rows when the question asks for team-level totals.',
      references: [`database:${CANONICAL_DEMO_DATABASE}.main.box_scores`],
    });
  }
}

function buildReplayAssistantMessage(
  step: DemoStep,
  transcript: DemoTranscript,
  events: StreamEvent[],
  timestamp: number,
): ChatMessage {
  const segments: ContentSegment[] = [];
  const steps: Step[] = [];

  for (const event of events) {
    if (event.type === 'text' && typeof event.content === 'string') {
      appendReplayText(segments, event.content);
    } else if (event.type === 'tool_start' && event.toolCall) {
      steps.push({
        type: 'tool',
        id: event.toolCall.id,
        name: event.toolCall.name,
        status: 'running',
        args: event.toolCall.args,
      });
    } else if (event.type === 'tool_end' && event.toolCall) {
      patchReplayStep(steps, event.toolCall.id, {
        status: event.toolCall.error ? 'error' : 'complete',
        result: event.toolCall.result,
      });
    } else if (event.type === 'context_tool' && event.contextCall) {
      const service = transcript.contextServices.find((call) => call.callId === event.contextCall?.callId);
      steps.push({
        type: 'tool',
        id: event.contextCall.callId,
        name: `${event.contextCall.name} (local)`,
        status: service?.isError ? 'error' : 'complete',
        args: event.contextCall.args,
        result: service?.resultText,
      });
    } else if (event.type === 'mviz_pending' && event.id) {
      segments.push({ type: 'mviz_pending', id: event.id });
      steps.push({
        type: 'tool',
        id: `mviz:${event.id}`,
        name: 'mviz_render',
        status: 'running',
        args: { output: 'inline visualization' },
      });
    } else if (event.type === 'mviz_html' && event.id && typeof event.content === 'string') {
      const segmentIndex = segments.findIndex((segment) => segment.type === 'mviz_pending' && segment.id === event.id);
      if (segmentIndex >= 0) {
        segments[segmentIndex] = { type: 'mviz', html: event.content };
      } else {
        segments.push({ type: 'mviz', html: event.content });
      }
      patchReplayStep(steps, `mviz:${event.id}`, {
        status: 'complete',
        result: `Rendered mviz artifact from deterministic transcript (${event.content.length} bytes).`,
      });
    }
  }

  steps.push({
    type: 'tool',
    id: `final:${step.id}`,
    name: 'final_answer',
    status: 'complete',
    result: 'Assistant response streamed to the presenter view.',
  });

  return {
    id: `demo-assistant-${step.id}-${timestamp}`,
    role: 'assistant',
    content: transcript.assistantText,
    timestamp,
    isStreaming: false,
    segments,
    steps,
    turnHistory: transcript.turnHistory,
  };
}

function splitReplayEventsByTurn(artifact: DemoValidationArtifact): StreamEvent[][] {
  let offset = 0;
  return artifact.transcripts.map((turn) => {
    const events = artifact.sseEvents.slice(offset, offset + turn.sseTypes.length);
    offset += turn.sseTypes.length;
    return events;
  });
}

async function ensureDemoFragment(input: { title: string; content: string; references: string[] }) {
  const existing = (await listFragments()).find((fragment) => fragment.title === input.title);
  if (existing) {
    await applyUpdate({
      action: 'update',
      id: existing.id,
      title: input.title,
      content: input.content,
      references: input.references,
    });
    return;
  }
  await applyUpdate({ action: 'create', ...input });
}

function appendReplayText(segments: ContentSegment[], text: string) {
  const last = segments[segments.length - 1];
  if (last?.type === 'text') {
    segments[segments.length - 1] = { type: 'text', text: last.text + text };
  } else {
    segments.push({ type: 'text', text });
  }
}

function patchReplayStep(
  steps: Step[],
  id: string,
  patch: Partial<Extract<Step, { type: 'tool' }>>,
) {
  const index = steps.findIndex((step) => step.type === 'tool' && step.id === id);
  if (index < 0) return;
  const current = steps[index];
  if (current.type !== 'tool') return;
  steps[index] = { ...current, ...patch };
}

function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ').toLowerCase();
}
