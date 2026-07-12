import {
  Client,
  StreamableHTTPClientTransport,
  SSEClientTransport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Tool as McpTool, Transport } from '@modelcontextprotocol/client';
import type { McpConfig, McpServerConfig } from './config.js';
import type { Tool } from '../Agent.js';

export interface DiscoveredMcpTool {
  /** Globally unique tool name: `${serverName}__${toolName}` */
  fullName: string;
  /** Original tool name as reported by the MCP server */
  name: string;
  /** The server that hosts this tool */
  serverName: string;
  description: string;
  /** Raw MCP tool definition including inputSchema */
  raw: McpTool;
}

interface ServerConnection {
  client: Client;
  transport: Transport;
  tools: McpTool[];
}

/**
 * Manages connections to MCP servers, discovers tools, and provides
 * accessors for building agent tools from MCP tools.
 */
export class McpManager {
  private connections = new Map<string, ServerConnection>();
  private discovered: DiscoveredMcpTool[] = [];

  /**
   * Connect to every server defined in `config` and discover their tools.
   * Servers that fail to connect are logged and skipped.
   */
  async init(config: McpConfig): Promise<void> {
    const entries = Object.entries(config.mcpServers);
    if (entries.length === 0) return;

    await Promise.allSettled(
      entries.map(([serverName, serverConfig]) =>
        this.connectServer(serverName, serverConfig),
      ),
    );

    this.buildDiscoveredTools();
  }

  private async connectServer(
    serverName: string,
    serverConfig: McpServerConfig,
  ): Promise<void> {
    let transport: Transport;

    const headers = serverConfig.headers ?? {};

    if (serverConfig.type === 'sse' && serverConfig.url) {
      transport = new SSEClientTransport(new URL(serverConfig.url), {
        requestInit: { headers },
        eventSourceInit: { headers } as any,
      });
    } else if (serverConfig.url) {
      transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
        requestInit: { headers },
      });
    } else {
      transport = new StdioClientTransport({
        command: serverConfig.command!,
        args: serverConfig.args ?? [],
        env: { ...serverConfig.env },
      });
    }

    const client = new Client(
      { name: 'matos', version: '1.0.0' },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();

      this.connections.set(serverName, { client, transport, tools });
    } catch (e) {
      console.warn(
        `[mcp] Failed to connect to server "${serverName}": ${(e as Error).message}`,
      );
      try {
        await transport.close();
      } catch {
        // ignore
      }
    }
  }

  private buildDiscoveredTools(): void {
    this.discovered = [];
    for (const [serverName, conn] of this.connections) {
      for (const tool of conn.tools) {
        this.discovered.push({
          fullName: `${serverName}__${tool.name}`,
          name: tool.name,
          serverName,
          description: tool.description ?? '',
          raw: tool,
        });
      }
    }
  }

  /** All tools discovered across all connected servers. */
  getDiscoveredTools(): DiscoveredMcpTool[] {
    return this.discovered;
  }

  /** Whether any tools were discovered. */
  hasTools(): boolean {
    return this.discovered.length > 0;
  }

  /**
   * Build an agent `Tool` for a discovered MCP tool.
   * The tool's callback proxies to the MCP server's `callTool`.
   */
  createAgentTool(discovered: DiscoveredMcpTool): Tool {
    return {
      name: discovered.fullName,
      description: discovered.description || `MCP tool: ${discovered.name}`,
      params: (discovered.raw.inputSchema as any) ?? {
        type: 'object',
        properties: {},
      },
      ttl: 3,
      summarize: true,
      callback: async (params: any) => {
        const conn = this.connections.get(discovered.serverName);
        if (!conn) {
          return `Error: MCP server "${discovered.serverName}" is not connected.`;
        }

        try {
          const result = await conn.client.callTool({
            name: discovered.name,
            arguments: params,
          });

          if (result.isError) {
            const text = extractContent(result.content);
            return `MCP tool error: ${text}`;
          }

          return extractContent(result.content);
        } catch (e) {
          return `MCP tool call failed: ${(e as Error).message}`;
        }
      },
    };
  }

  /**
   * Look up a discovered tool by its full name.
   * Returns `undefined` if not found.
   */
  getDiscoveredTool(fullName: string): DiscoveredMcpTool | undefined {
    return this.discovered.find((t) => t.fullName === fullName);
  }

  /** Close all MCP server connections. */
  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.connections.values()].map((c) =>
        c.client.close().catch(() => {}),
      ),
    );
    this.connections.clear();
    this.discovered = [];
  }
}

/**
 * Convert MCP tool result content blocks to a plain string.
 */
function extractContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : JSON.stringify(content);
  }

  return content
    .map((block: any) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'image') return `[image: ${block.mimeType}]`;
      if (block.type === 'resource') {
        const text =
          block.resource?.text ??
          `[binary resource: ${block.resource?.mimeType ?? 'unknown'}]`;
        return text;
      }
      if (block.type === 'audio') return `[audio: ${block.mimeType}]`;
      return JSON.stringify(block);
    })
    .join('\n');
}
