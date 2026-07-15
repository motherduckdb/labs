import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PROD_MCP_URL = 'https://api.motherduck.com/mcp';

const CONTRACT = {
  query: ['database', 'sql'],
  list_databases: [],
  list_tables: ['database'],
  list_columns: ['database', 'table'],
  list_views: ['database'],
  list_macros: ['database'],
  search_catalog: ['query'],
  ask_docs_question: ['question'],
  get_guide: ['path'],
  list_guides: [],
  create_guide: ['path', 'title', 'content'],
  update_guide: [],
  edit_guide_content: ['edits'],
  update_guide_metadata: [],
  set_guide_access: ['access'],
  delete_guide: [],
};

function fail(message) {
  throw new Error(`Production MCP contract validation failed: ${message}`);
}

function validateSchema(tool, requiredProperties) {
  const schema = tool.inputSchema ?? {};
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  for (const property of requiredProperties) {
    if (!(property in properties)) {
      fail(`${tool.name} is missing input property "${property}"`);
    }
    if (!required.has(property)) {
      fail(`${tool.name}.${property} is no longer required`);
    }
  }
}

async function validateRead(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) fail(`${name} returned an MCP error`);
  return result;
}

const token = process.env.MOTHERDUCK_TOKEN?.trim();
if (!token) fail('MOTHERDUCK_TOKEN is not set');

const client = new Client({ name: 'data-chat-mini-prod-validator', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(PROD_MCP_URL), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});

try {
  await client.connect(transport);
  const { tools = [] } = await client.listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const missing = Object.keys(CONTRACT).filter((name) => !byName.has(name));
  if (missing.length) fail(`missing tools: ${missing.join(', ')}`);

  for (const [name, requiredProperties] of Object.entries(CONTRACT)) {
    validateSchema(byName.get(name), requiredProperties);
  }

  await validateRead(client, 'get_guide', { path: 'guides.md' });
  await validateRead(client, 'list_guides', {});

  console.log(
    `Production MCP contract is valid: ${Object.keys(CONTRACT).length} required tools and guide reads passed.`,
  );
} finally {
  try {
    await client.close();
  } catch {
    // Preserve the original validation error.
  }
}
