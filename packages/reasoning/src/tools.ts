export type ToolParamSchema = {
  type: 'object';
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required?: string[];
};

export type ToolDefinition<TInput = unknown, TOutput = unknown> = {
  name: string;
  description: string;
  input_schema: ToolParamSchema;
  handler: (input: TInput) => Promise<TOutput>;
};

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register<I, O>(tool: ToolDefinition<I, O>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool ${tool.name} already registered`);
    }
    this.tools.set(tool.name, tool as ToolDefinition);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Exposes tool definitions in the shape Anthropic expects.
   */
  toAnthropicTools(): Array<{ name: string; description: string; input_schema: ToolParamSchema }> {
    return this.list().map(({ handler, ...rest }) => {
      void handler;
      return rest;
    });
  }
}

export function timeTool(): ToolDefinition<Record<string, never>, { iso: string; epochMs: number }> {
  return {
    name: 'get_current_time',
    description: 'Returns the current server time as ISO8601 and epoch milliseconds.',
    input_schema: { type: 'object', properties: {}, required: [] },
    handler: async () => ({ iso: new Date().toISOString(), epochMs: Date.now() }),
  };
}

export function echoTool(): ToolDefinition<{ text: string }, { text: string }> {
  return {
    name: 'echo',
    description: 'Echoes the input text back. Useful for tests.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo' } },
      required: ['text'],
    },
    handler: async (input) => ({ text: input.text }),
  };
}
