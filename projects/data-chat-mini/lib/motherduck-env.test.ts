import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMotherDuckApiUrl, getMotherDuckMcpUrl } from './motherduck-env';

describe('MotherDuck environment URLs', () => {
  beforeEach(() => {
    vi.stubEnv('MOTHERDUCK_API_URL', '');
    vi.stubEnv('MOTHERDUCK_MCP_URL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to the production API and MCP endpoints', () => {
    expect(getMotherDuckApiUrl()).toBe('https://api.motherduck.com');
    expect(getMotherDuckMcpUrl()).toBe('https://api.motherduck.com/mcp');
  });

  it('normalizes an explicit API URL', () => {
    vi.stubEnv('MOTHERDUCK_API_URL', ' https://api.staging.motherduck.com/ ');

    expect(getMotherDuckApiUrl()).toBe('https://api.staging.motherduck.com');
  });

  it('continues to support the legacy MCP URL', () => {
    vi.stubEnv('MOTHERDUCK_MCP_URL', ' https://example.test/mcp/ ');

    expect(getMotherDuckApiUrl()).toBe('https://example.test');
    expect(getMotherDuckMcpUrl()).toBe('https://example.test/mcp');
  });
});
