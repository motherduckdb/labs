export const CONTEXT_PLACEHOLDER = '__DATA_CHAT_MINI_CONTEXT_PLACEHOLDER__';

export const CONTEXT_TOOLS = [
  {
    name: 'query_context_layer',
    description: 'Search saved local context fragments for definitions and preferences relevant to a data question.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'update_context_layer',
    description: 'Save a local context fragment containing a definition or user preference.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
      },
      required: ['content'],
    },
  },
];

export function isContextTool(name: string): boolean {
  return name === 'query_context_layer' || name === 'update_context_layer';
}
