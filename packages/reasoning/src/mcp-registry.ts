/**
 * McpRegistry: reads a `.mcp.json` file (same format Claude Code uses),
 * spins up a client for each listed server, lists their tools, and
 * exposes them as `ToolDefinition`s that slot straight into the
 * existing `ToolRegistry`.
 *
 * The JSON shape supports three transports, all standard-MCP:
 *
 *   {
 *     "mcpServers": {
 *       "local-stdio": {
 *         "command": "node", "args": ["./server.js"], "env": {"KEY": "v"}
 *       },
 *       "remote-http": {
 *         "type": "http", "url": "http://localhost:8020/mcp", "headers": {...}
 *       },
 *       "legacy-sse": {
 *         "type": "sse", "url": "http://host/sse"
 *       }
 *     }
 *   }
 *
 * Tools surface to the reasoner with names prefixed by the server key
 * (e.g. `oasis-cognition__web_search`) so collisions across servers are
 * impossible even when two servers export a tool named `search`.
 */

import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Logger } from '@oasis-echo/telemetry';
import type { ToolDefinition, ToolParamSchema } from './tools.js';

export type McpStdioServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

export type McpHttpServerConfig = {
  type: 'http' | 'streamable-http';
  url: string;
  headers?: Record<string, string>;
};

export type McpSseServerConfig = {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
};

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

export type McpConfigFile = {
  mcpServers: Record<string, McpServerConfig>;
};

export type McpRegistryOpts = {
  /** Path to `.mcp.json`. Defaults to `<cwd>/.mcp.json`. */
  configPath?: string;
  /** Optional logger for warnings / info. */
  logger?: Logger;
  /**
   * Separator between serverName and toolName when namespacing.
   * Keep it in the `a-zA-Z0-9_` character class — Anthropic's tool-name
   * regex rejects most punctuation. Default `__`.
   */
  nameSeparator?: string;
  /** Soft timeout (ms) on the initial `tools/list` call. Default 10000. */
  listTimeoutMs?: number;
  /** Soft timeout (ms) on each tool invocation. Default 30000. */
  callTimeoutMs?: number;
};

type ConnectedServer = {
  name: string;
  client: Client;
  tools: ToolDefinition[];
};

/**
 * Manages the lifecycle of MCP client connections for oasis-echo.
 *
 * Usage:
 *
 *   const mcp = new McpRegistry({ logger });
 *   const tools = await mcp.loadFromFile();   // reads ./.mcp.json
 *   for (const t of tools) toolRegistry.register(t);
 *   // ...on shutdown
 *   await mcp.close();
 */
export class McpRegistry {
  private readonly logger: Logger | undefined;
  private readonly nameSeparator: string;
  private readonly listTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly servers: ConnectedServer[] = [];

  constructor(opts: McpRegistryOpts = {}) {
    this.logger = opts.logger;
    this.nameSeparator = opts.nameSeparator ?? '__';
    this.listTimeoutMs = opts.listTimeoutMs ?? 10_000;
    this.callTimeoutMs = opts.callTimeoutMs ?? 30_000;
  }

  /**
   * Read the config file, connect every listed server, return the
   * flattened array of tool definitions. A missing file yields an
   * empty list — callers decide whether that's an error.
   */
  async loadFromFile(path?: string): Promise<ToolDefinition[]> {
    const filePath = path ?? `${process.cwd()}/.mcp.json`;
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      // Missing config is a normal state on fresh checkouts — log and
      // continue without tools. Any other read error bubbles.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger?.info('mcp config missing; skipping registry', { filePath });
        return [];
      }
      throw err;
    }
    let parsed: McpConfigFile;
    try {
      parsed = JSON.parse(raw) as McpConfigFile;
    } catch (err) {
      this.logger?.error('mcp config is invalid JSON', { filePath, error: String(err) });
      return [];
    }
    return this.loadFromConfig(parsed);
  }

  /** Connect servers defined inline (useful for tests / env-driven config). */
  async loadFromConfig(config: McpConfigFile): Promise<ToolDefinition[]> {
    const entries = Object.entries(config.mcpServers ?? {});
    if (entries.length === 0) return [];

    const results = await Promise.allSettled(
      entries.map(([name, server]) => this.connectAndList(name, server)),
    );

    const tools: ToolDefinition[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') tools.push(...r.value.tools);
      else this.logger?.warn('mcp server failed', { error: String(r.reason) });
    }
    return tools;
  }

  /** Summary of connected servers for logging / introspection. */
  describe(): Array<{ server: string; tools: string[] }> {
    return this.servers.map((s) => ({
      server: s.name,
      tools: s.tools.map((t) => t.name),
    }));
  }

  /**
   * Look up a tool definition by its qualified (namespaced) name.
   * Used by the app server when building prompt-time catalogues so the
   * reasoner's system prompt can include schemas without needing to
   * re-derive them from the ToolRegistry.
   */
  getToolDefinition(qualifiedName: string): ToolDefinition | undefined {
    for (const s of this.servers) {
      const found = s.tools.find((t) => t.name === qualifiedName);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * Close every client connection (terminating stdio subprocesses /
   * HTTP sessions). Safe to call repeatedly.
   */
  async close(): Promise<void> {
    const closing = this.servers.splice(0).map(async (s) => {
      try { await s.client.close(); }
      catch (err) { this.logger?.warn('mcp close failed', { server: s.name, error: String(err) }); }
    });
    await Promise.allSettled(closing);
  }

  private async connectAndList(name: string, server: McpServerConfig): Promise<ConnectedServer> {
    const transport = this.buildTransport(server);
    const client = new Client(
      { name: 'oasis-echo', version: '0.1.0' },
      { capabilities: {} },
    );
    // Cast through `unknown` because the SDK's concrete transports expose
    // `sessionId: string | undefined` while the `Transport` interface
    // declares it `string`. That mismatch trips TS under
    // `exactOptionalPropertyTypes`, but every transport in the SDK is
    // a valid `Transport` at runtime.
    await client.connect(transport as unknown as Parameters<Client['connect']>[0]);

    const listResult = await withTimeout(
      client.listTools(),
      this.listTimeoutMs,
      `listTools(${name})`,
    );

    const tools: ToolDefinition[] = [];
    for (const tool of listResult.tools ?? []) {
      const qualifiedName = `${sanitize(name)}${this.nameSeparator}${sanitize(tool.name)}`;
      const inputSchema = normalizeSchema(tool.inputSchema);
      const description = tool.description?.trim() || `(${name}) ${tool.name}`;
      tools.push({
        name: qualifiedName,
        description,
        input_schema: inputSchema,
        handler: async (input: unknown) => {
          const args = (input && typeof input === 'object') ? (input as Record<string, unknown>) : {};
          const res = await withTimeout(
            client.callTool({ name: tool.name, arguments: args }),
            this.callTimeoutMs,
            `callTool(${name}.${tool.name})`,
          );
          // Surface structured content when the server provided it, or
          // concatenate text blocks otherwise. Claude doesn't care which
          // — it sees whatever we return here as the tool_result.
          const payload = res as { structuredContent?: unknown; content?: Array<{ type: string; text?: string; data?: unknown }> };
          if (payload.structuredContent !== undefined) return payload.structuredContent;
          const textChunks = (payload.content ?? [])
            .filter((c) => c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text as string);
          if (textChunks.length > 0) return textChunks.join('\n');
          return payload.content ?? null;
        },
      });
    }

    const connected: ConnectedServer = { name, client, tools };
    this.servers.push(connected);
    this.logger?.info('mcp server connected', {
      server: name,
      tools: tools.map((t) => t.name),
    });
    return connected;
  }

  private buildTransport(server: McpServerConfig) {
    if ('command' in server) {
      return new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: server.env ?? {},
        ...(server.cwd ? { cwd: server.cwd } : {}),
      });
    }
    if ('url' in server) {
      const url = new URL(server.url);
      const headers = server.headers ?? {};
      if (server.type === 'sse') {
        return new SSEClientTransport(url, {
          requestInit: { headers },
        });
      }
      // 'http' or 'streamable-http'
      return new StreamableHTTPClientTransport(url, {
        requestInit: { headers },
      });
    }
    throw new Error('mcp server config missing command or url');
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_');
}

function normalizeSchema(schema: unknown): ToolParamSchema {
  // MCP tool.inputSchema is already JSON Schema. We trust `type: 'object'`
  // since that's what the MCP spec mandates for inputSchema. Preserve
  // everything else (properties, required, additionalProperties, etc.)
  // for the reasoner to pass through to the LLM unchanged.
  if (schema && typeof schema === 'object' && (schema as { type?: unknown }).type === 'object') {
    return schema as ToolParamSchema;
  }
  return { type: 'object', properties: {}, required: [] };
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
