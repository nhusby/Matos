import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { access } from 'fs/promises';

export type McpTransportType = 'stdio' | 'sse' | 'http';

export interface McpServerConfig {
  /**
   * Transport type. If omitted, inferred: `command` → stdio,
   * `url` with `type: "sse"` → SSE, otherwise → streamable HTTP.
   */
  type?: McpTransportType;
  /** Stdio: the executable to run. Mutually exclusive with `url`. */
  command?: string;
  /** Stdio: command-line arguments. */
  args?: string[];
  /** Stdio: environment variables for the spawned process. */
  env?: Record<string, string>;
  /** HTTP/SSE: the server URL. Mutually exclusive with `command`. */
  url?: string;
  /** HTTP/SSE: custom headers to send with requests. */
  headers?: Record<string, string>;
}

export type McpServerMap = Record<string, McpServerConfig>;

export interface McpConfig {
  mcpServers: McpServerMap;
}

async function loadConfigFile(path: string): Promise<McpConfig | null> {
  try {
    await access(path);
  } catch {
    return null;
  }

  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return null;
  }

  try {
    return JSON.parse(raw) as McpConfig;
  } catch (e) {
    console.warn(
      `[mcp] Failed to parse ${path}: ${(e as Error).message}. Skipping.`,
    );
    return null;
  }
}

/**
 * Load MCP configuration by merging the global config from
 * `~/.matos/mcp.json` with the local config at `./.matos/mcp.json`.
 * Local servers take precedence (override) global servers with the
 * same name. Returns an empty `mcpServers` map if no config files
 * are found or parseable.
 */
export async function loadMcpConfig(): Promise<McpConfig> {
  const globalPath = join(homedir(), '.matos', 'mcp.json');
  const localPath = join(process.cwd(), '.matos', 'mcp.json');

  const [globalConfig, localConfig] = await Promise.all([
    loadConfigFile(globalPath),
    loadConfigFile(localPath),
  ]);

  const globalServers = globalConfig?.mcpServers ?? {};
  const localServers = localConfig?.mcpServers ?? {};

  return {
    mcpServers: { ...globalServers, ...localServers },
  };
}
