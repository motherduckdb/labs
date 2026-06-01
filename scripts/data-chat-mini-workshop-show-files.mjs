#!/usr/bin/env node

const checkpoints = [
  {
    step: '01',
    pr: 27,
    title: 'Data ground truth',
    branch: 'workshop/data-chat-mini/01-data',
    tag: 'data-chat-mini-step-01',
    quickCheck: "Plain SELECT; show that game totals use period = 'FullGame'.",
    files: [
      {
        path: 'projects/data-chat-mini/app/page.tsx',
        why: 'Landing checkpoint with the plain SQL and the grain warning.',
      },
      {
        path: 'projects/data-chat-mini/lib/motherduck-env.ts',
        why: 'The first tiny bit of app config: where the MotherDuck MCP endpoint comes from.',
      },
      {
        path: 'projects/data-chat-mini/.env.example',
        why: 'Shows the two secrets the eventual app needs without introducing the model yet.',
      },
    ],
  },
  {
    step: '02',
    pr: 28,
    title: 'MCP query',
    branch: 'workshop/data-chat-mini/02-mcp-query',
    tag: 'data-chat-mini-step-02',
    quickCheck: 'POST SQL to /api/query and get rows back.',
    files: [
      {
        path: 'projects/data-chat-mini/lib/mcp-client.ts',
        why: 'The MotherDuck MCP client and the first exposed read tool.',
      },
      {
        path: 'projects/data-chat-mini/app/api/query/route.ts',
        why: 'A hand-call route for proving query works before the model exists.',
      },
      {
        path: 'projects/data-chat-mini/app/page.tsx',
        why: 'The live curl command for the checkpoint.',
      },
    ],
  },
  {
    step: '03',
    pr: 30,
    title: 'Read-scaling token',
    branch: 'workshop/data-chat-mini/03-read-scaling-token',
    tag: 'data-chat-mini-step-03',
    quickCheck: 'Call the MCP query route with a session id header.',
    files: [
      {
        path: 'projects/data-chat-mini/lib/mcp-client.ts',
        why: 'Threads the read-scaling token and session_name hint into the MCP URL.',
      },
      {
        path: 'projects/data-chat-mini/lib/session-id.ts',
        why: 'Browser-side per-session id for read-replica affinity.',
      },
      {
        path: 'projects/data-chat-mini/lib/uuid7.ts',
        why: 'Small id helper used by the browser session.',
      },
      {
        path: 'projects/data-chat-mini/app/api/query/route.ts',
        why: 'Accepts x-session-id and passes it into the MCP client.',
      },
    ],
  },
  {
    step: '04',
    pr: 31,
    title: 'Tool allowlist',
    branch: 'workshop/data-chat-mini/04-tool-allowlist',
    tag: 'data-chat-mini-step-04',
    quickCheck: 'Attempt query_rw and see it rejected before dispatch.',
    files: [
      {
        path: 'projects/data-chat-mini/lib/mcp-client.ts',
        why: 'The read-only allowlist plus READONLY/MUTATING/DESTRUCTIVE policy boundary.',
      },
      {
        path: 'projects/data-chat-mini/app/api/query/route.ts',
        why: 'Includes the deliberate rejected-tool check for the live beat.',
      },
    ],
  },
  {
    step: '05',
    pr: 29,
    title: 'Model client',
    branch: 'workshop/data-chat-mini/05-model-client',
    tag: 'data-chat-mini-step-05',
    quickCheck: 'Call /api/model and get a model response.',
    files: [
      {
        path: 'projects/data-chat-mini/lib/llm-client.ts',
        why: 'OpenRouter streaming client, default Gemini model, usage parsing, provider preference.',
      },
      {
        path: 'projects/data-chat-mini/app/api/model/route.ts',
        why: 'Hand-call route for proving the model works before tool use.',
      },
      {
        path: 'projects/data-chat-mini/package.json',
        why: 'Dependencies are now enough for Next, MCP, and the model client.',
      },
    ],
  },
  {
    step: '06',
    pr: 32,
    title: 'Agentic loop',
    branch: 'workshop/data-chat-mini/06-agentic-loop',
    tag: 'data-chat-mini-step-06',
    quickCheck: 'Ask how many games are in the schedule and watch query run.',
    files: [
      {
        path: 'projects/data-chat-mini/lib/agentic-loop.ts',
        why: 'The core loop: model call, tool dispatch, append result, repeat.',
      },
      {
        path: 'projects/data-chat-mini/lib/tool-dispatch.ts',
        why: 'Central place where model-requested tools become MCP calls.',
      },
      {
        path: 'projects/data-chat-mini/lib/tool-invocation.ts',
        why: 'Tiny normalization/failure helpers for the first query tool.',
      },
      {
        path: 'projects/data-chat-mini/app/api/chat/route.ts',
        why: 'Wires MCP tools and the model into the loop route.',
      },
      {
        path: 'projects/data-chat-mini/lib/sse-encoder.ts',
        why: 'Streams text/tool events back to whatever UI or curl is listening.',
      },
      {
        path: 'projects/data-chat-mini/types/chat.ts',
        why: 'The first stream event types.',
      },
    ],
  },
  {
    step: '07',
    pr: 35,
    title: 'System prompt',
    branch: 'workshop/data-chat-mini/07-system-prompt',
    tag: 'data-chat-mini-step-07',
    quickCheck: 'Ask the same kind of question and see schema/read-only habits in the answer.',
    files: [
      {
        path: 'projects/data-chat-mini/lib/system-prompt.ts',
        why: 'The habits: explore first, stay read-only, use FullGame, map 2026 playoffs to season_year 2025.',
      },
      {
        path: 'projects/data-chat-mini/app/api/chat/route.ts',
        why: 'Route now builds and passes the prompt instead of using a one-line stub.',
      },
    ],
  },
  {
    step: '08',
    pr: 34,
    title: 'Schema tools',
    branch: 'workshop/data-chat-mini/08-schema-tools',
    tag: 'data-chat-mini-step-08',
    quickCheck: 'Ask for most points in a 2026 playoff game and inspect schema in the sidebar.',
    files: [
      {
        path: 'projects/data-chat-mini/lib/mcp-client.ts',
        why: 'Expands the allowlist to all six read-only MCP tools.',
      },
      {
        path: 'projects/data-chat-mini/lib/mcp-parsers.ts',
        why: 'Turns raw MCP catalog responses into tables and columns.',
      },
      {
        path: 'projects/data-chat-mini/app/api/schema/route.ts',
        why: 'Read-only schema endpoint used by the sidebar.',
      },
      {
        path: 'projects/data-chat-mini/app/chat/SchemaExplorerSidebar.tsx',
        why: 'The visible schema explorer for the room.',
      },
      {
        path: 'projects/data-chat-mini/app/chat/page.tsx',
        why: 'First /chat page shell for showing schema alongside the loop.',
      },
    ],
  },
  {
    step: '09',
    pr: 33,
    title: 'Streaming UI',
    branch: 'workshop/data-chat-mini/09-streaming-ui',
    tag: 'data-chat-mini-step-09',
    quickCheck: 'Open /chat and watch tool calls plus text stream into the UI.',
    files: [
      {
        path: 'projects/data-chat-mini/app/chat/ChatPanel.tsx',
        why: 'Consumes SSE and renders user messages, tool calls, and streamed assistant text.',
      },
      {
        path: 'projects/data-chat-mini/app/chat/ChatShell.tsx',
        why: 'Lays out chat plus schema for the first usable app surface.',
      },
      {
        path: 'projects/data-chat-mini/app/globals.css',
        why: 'The first real UI layout and tool-call styling.',
      },
      {
        path: 'projects/data-chat-mini/lib/sse-encoder.ts',
        why: 'These events are now user-visible rather than curl-only.',
      },
    ],
  },
  {
    step: '10',
    pr: 37,
    title: 'Charts',
    branch: 'workshop/data-chat-mini/10-charts-mviz',
    tag: 'data-chat-mini-step-10',
    quickCheck: 'Ask for top scorers by points per game as a bar chart.',
    files: [
      {
        path: 'projects/data-chat-mini/lib/mviz-fence.ts',
        why: 'Detects mviz fenced blocks as they stream.',
      },
      {
        path: 'projects/data-chat-mini/lib/mviz-processor.ts',
        why: 'Renders mviz markdown to embeddable HTML.',
      },
      {
        path: 'projects/data-chat-mini/app/components/MvizFrame.tsx',
        why: 'Sandboxed iframe for inline charts.',
      },
      {
        path: 'projects/data-chat-mini/lib/agentic-loop.ts',
        why: 'Streams mviz_pending and mviz_html events at the right moment.',
      },
      {
        path: 'projects/data-chat-mini/app/chat/ChatPanel.tsx',
        why: 'Swaps chart placeholders for rendered frames in the chat.',
      },
    ],
  },
  {
    step: '11',
    pr: 39,
    title: 'History',
    branch: 'workshop/data-chat-mini/11-history',
    tag: 'data-chat-mini-step-11',
    quickCheck: 'Ask a question, refresh, and reopen the conversation from history.',
    files: [
      {
        path: 'projects/data-chat-mini/lib/chat-storage.ts',
        why: 'IndexedDB persistence for conversations and the conversation index.',
      },
      {
        path: 'projects/data-chat-mini/app/chat/ChatHistorySidebar.tsx',
        why: 'Visible history list and new-chat affordance.',
      },
      {
        path: 'projects/data-chat-mini/app/chat/ChatPanel.tsx',
        why: 'Saves completed turns and reloads selected conversations.',
      },
      {
        path: 'projects/data-chat-mini/types/chat.ts',
        why: 'Stored conversation and summary shapes.',
      },
    ],
  },
  {
    step: '12',
    pr: 38,
    title: 'Context intercept',
    branch: 'workshop/data-chat-mini/12-context-intercept',
    tag: 'data-chat-mini-step-12',
    quickCheck: 'Teach a definition, then ask a follow-up that uses the saved fragment.',
    files: [
      {
        path: 'projects/data-chat-mini/lib/context-tools.ts',
        why: 'Advertises the real MotherDuck context tool names, without adding them to MCP allowlist.',
      },
      {
        path: 'projects/data-chat-mini/lib/context-store.ts',
        why: 'Local IndexedDB implementation that services context reads/writes.',
      },
      {
        path: 'projects/data-chat-mini/lib/agentic-loop.ts',
        why: 'Intercepts context tool calls, emits context_tool, and pauses the loop.',
      },
      {
        path: 'projects/data-chat-mini/app/api/chat/route.ts',
        why: 'Resume path patches placeholder tool_result blocks with browser-computed context.',
      },
      {
        path: 'projects/data-chat-mini/app/chat/ChatPanel.tsx',
        why: 'Browser services context_tool events locally, then resumes the loop.',
      },
    ],
  },
  {
    step: '13',
    pr: 36,
    title: 'Telemetry',
    branch: 'workshop/data-chat-mini/13-telemetry',
    tag: 'data-chat-mini-step-13',
    quickCheck: 'Replay prompts, tool calls, cost, and latency from controllog.',
    files: [
      {
        path: 'projects/data-chat-mini/lib/controllog.ts',
        why: 'Spec-ish JSONL logging for model prompts/completions, tool calls, errors, cost, and latency.',
      },
      {
        path: 'projects/data-chat-mini/lib/logging-flag.ts',
        why: 'Runtime switch for suppressing controllog writes in tests/demo harnesses.',
      },
      {
        path: 'projects/data-chat-mini/app/api/chat/route.ts',
        why: 'Initializes and flushes the per-request controllog session.',
      },
      {
        path: 'projects/data-chat-mini/lib/agentic-loop.ts',
        why: 'Logs every model exchange, usage event, tool completion, and stream error.',
      },
      {
        path: 'projects/data-chat-mini/demo/demo-validation.test.ts',
        why: 'End-to-end demo validation harness that proves the final workshop path.',
      },
      {
        path: 'workshop-data-chat-mini-checkpoints.md',
        why: 'Tag and quick-check reference for driving the workshop.',
      },
    ],
  },
];

function usage() {
  console.log(`Usage:
  node scripts/data-chat-mini-workshop-show-files.mjs
  node scripts/data-chat-mini-workshop-show-files.mjs --step 08
  node scripts/data-chat-mini-workshop-show-files.mjs --pr 34
  node scripts/data-chat-mini-workshop-show-files.mjs --json
`);
}

function parseArgs(argv) {
  const options = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--step') {
      options.step = String(argv[++i] || '').padStart(2, '0');
    } else if (arg.startsWith('--step=')) {
      options.step = arg.slice('--step='.length).padStart(2, '0');
    } else if (arg === '--pr') {
      options.pr = Number(argv[++i]);
    } else if (arg.startsWith('--pr=')) {
      options.pr = Number(arg.slice('--pr='.length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function formatCheckpoint(checkpoint) {
  const lines = [
    `PR #${checkpoint.pr} · Step ${checkpoint.step}: ${checkpoint.title}`,
    `Branch: ${checkpoint.branch}`,
    `Tag: ${checkpoint.tag}`,
    `Quick check: ${checkpoint.quickCheck}`,
    'Files to show:',
  ];

  for (const file of checkpoint.files) {
    lines.push(`  - ${file.path}`);
    lines.push(`    ${file.why}`);
  }

  return lines.join('\n');
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    process.exit(0);
  }

  let selected = checkpoints;
  if (options.step) {
    selected = selected.filter(checkpoint => checkpoint.step === options.step);
  }
  if (options.pr) {
    selected = selected.filter(checkpoint => checkpoint.pr === options.pr);
  }

  if (selected.length === 0) {
    console.error('No checkpoint matched.');
    usage();
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify(selected, null, 2));
  } else {
    console.log(selected.map(formatCheckpoint).join('\n\n'));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(1);
}
