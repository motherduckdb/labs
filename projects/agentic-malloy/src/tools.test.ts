import { describe, expect, it } from 'vitest';
import { dispatchTool, newRunState, type ToolDeps } from './tools.js';
import type { MalloyRuntime } from './malloy-runtime.js';

function runtimeReturning(rows: Record<string, unknown>[], ok = true): MalloyRuntime {
  return {
    run: async () => (ok ? { ok: true, sql: 'select 1', rows } : { ok: false, diagnostics: [{ message: 'local failed' }] }),
  } as unknown as MalloyRuntime;
}

function deps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    client: {} as ToolDeps['client'],
    runtime: runtimeReturning([{ a: 1, b: 'x' }]),
    localRuntime: runtimeReturning([{ a: 1, b: 'x' }]),
    store: {} as ToolDeps['store'],
    symbols: new Set<string>(),
    mcpTools: [],
    state: newRunState(),
    ...overrides,
  };
}

describe('submit_answer translation diagnostic', () => {
  it('records true when the local and MotherDuck rowsets match', async () => {
    const d = deps();
    const result = await dispatchTool(d, 'submit_answer', { source: 'run: x -> { aggregate: n }' });

    expect(result.isError).toBe(false);
    expect(d.state.translationMatch).toBe(true);
  });

  it('records false when the local row shape differs from the scored rows', async () => {
    const d = deps({ localRuntime: runtimeReturning([{ b: 'x', a: 1 }]) });
    const result = await dispatchTool(d, 'submit_answer', { source: 'run: x -> { aggregate: n }' });

    expect(result.isError).toBe(false);
    expect(d.state.translationMatch).toBe(false);
  });

  it('leaves the diagnostic null when the warning-only local run fails', async () => {
    const d = deps({ localRuntime: runtimeReturning([], false) });
    const result = await dispatchTool(d, 'submit_answer', { source: 'run: x -> { aggregate: n }' });

    expect(result.isError).toBe(false);
    expect(d.state.translationMatch).toBeNull();
  });
});
