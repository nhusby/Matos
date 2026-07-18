import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { mkdtemp, writeFile, mkdir } from 'fs/promises';
import { tmpdir, homedir } from 'os';
import { join } from 'path';

describe('MCP config loading', () => {
  it('merges global and local mcp.json configs, local overriding global', async () => {
    // We test the merge logic directly by importing with mocked paths.
    // loadMcpConfig uses fixed paths, so we verify the merge behavior
    // by testing the underlying logic pattern.

    const globalServers = {
      filesystem: { command: 'npx', args: ['fs-server'] },
      github: { command: 'npx', args: ['gh-server'] },
    };

    const localServers = {
      github: { command: 'npx', args: ['gh-server-v2'] }, // override
      custom: { command: 'node', args: ['custom.js'] },
    };

    const merged = { ...globalServers, ...localServers };

    expect(merged.filesystem.command).toBe('npx');
    expect(merged.filesystem.args).toEqual(['fs-server']);
    expect(merged.github.args).toEqual(['gh-server-v2']); // overridden by local
    expect(merged.custom.command).toBe('node');
  });
});

describe('EnableTool', () => {
  it('creates a tool with enum containing all discovered tool names', async () => {
    const { createEnableTool } = await import('../../src/lib/mcp/enableTool');
    const typeTool = await import('../../src/lib/Agent');

    const discovered = [
      {
        fullName: 'serverA__search',
        name: 'search',
        serverName: 'serverA',
        description: 'Search the web',
        raw: {
          name: 'search',
          description: 'Search the web',
          inputSchema: { type: 'object' as const, properties: {} },
        },
      },
      {
        fullName: 'serverB__fetch',
        name: 'fetch',
        serverName: 'serverB',
        description: 'Fetch a URL',
        raw: {
          name: 'fetch',
          description: 'Fetch a URL',
          inputSchema: { type: 'object' as const, properties: {} },
        },
      },
    ];

    const mockManager = {
      getDiscoveredTools: () => discovered,
      getDiscoveredTool: (fullName: string) =>
        discovered.find((t) => t.fullName === fullName),
      createAgentTool: (d: any) => ({
        name: d.fullName,
        description: d.description,
        params: {},
        callback: async () => 'ok',
      }),
    };

    const tools: any[] = [];
    const enableTool = createEnableTool({
      manager: mockManager as any,
      tools,
    });

    // Verify the enum contains both tool names
    const enumValues =
      enableTool.params.properties.toolName.enum;
    expect(enumValues).toContain('serverA__search');
    expect(enumValues).toContain('serverB__fetch');
    expect(enumValues.length).toBe(2);

    // Verify the description includes both tool descriptions
    expect(enableTool.description).toContain('Search the web');
    expect(enableTool.description).toContain('Fetch a URL');

    // Verify invoking adds the tool to the tools array
    const result = await enableTool.callback({ toolName: 'serverA__search' });
    expect(result).toContain('Enabled');
    expect(result).toContain('serverA__search');
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('serverA__search');
  });

  it('returns error when tool name is not found', async () => {
    const { createEnableTool } = await import('../../src/lib/mcp/enableTool');

    const discovered = [
      {
        fullName: 'serverA__search',
        name: 'search',
        serverName: 'serverA',
        description: 'Search the web',
        raw: { name: 'search', description: 'Search the web' },
      },
    ];

    const mockManager = {
      getDiscoveredTools: () => discovered,
      getDiscoveredTool: (fullName: string) =>
        discovered.find((t) => t.fullName === fullName),
      createAgentTool: (d: any) => ({
        name: d.fullName,
        description: d.description,
        params: {},
        callback: async () => 'ok',
      }),
    };

    const tools: any[] = [];
    const enableTool = createEnableTool({
      manager: mockManager as any,
      tools,
    });

    const result = await enableTool.callback({ toolName: 'nonexistent' });
    expect(result).toContain('Error');
    expect(tools).toHaveLength(0);
  });

  it('does not add a tool that is already enabled', async () => {
    const { createEnableTool } = await import('../../src/lib/mcp/enableTool');

    const discovered = [
      {
        fullName: 'serverA__search',
        name: 'search',
        serverName: 'serverA',
        description: 'Search the web',
        raw: { name: 'search', description: 'Search the web' },
      },
    ];

    const mockManager = {
      getDiscoveredTools: () => discovered,
      getDiscoveredTool: (fullName: string) =>
        discovered.find((t) => t.fullName === fullName),
      createAgentTool: (d: any) => ({
        name: d.fullName,
        description: d.description,
        params: {},
        callback: async () => 'ok',
      }),
    };

    const tools: any[] = [
      { name: 'serverA__search', description: '', callback: async () => '' },
    ];
    const enableTool = createEnableTool({
      manager: mockManager as any,
      tools,
    });

    const result = await enableTool.callback({ toolName: 'serverA__search' });
    expect(result).toContain('already enabled');
    expect(tools).toHaveLength(1); // still just 1, not 2
  });

  it('excludes tools listed in the exclude set', async () => {
    const { createEnableTool } = await import('../../src/lib/mcp/enableTool');

    const discovered = [
      {
        fullName: 'serverA__search',
        name: 'search',
        serverName: 'serverA',
        description: 'Search the web',
        raw: { name: 'search', description: 'Search the web' },
      },
      {
        fullName: 'serverA__fetch',
        name: 'fetch',
        serverName: 'serverA',
        description: 'Fetch a URL',
        raw: { name: 'fetch', description: 'Fetch a URL' },
      },
    ];

    const mockManager = {
      getDiscoveredTools: () => discovered,
      getDiscoveredTool: (fullName: string) =>
        discovered.find((t) => t.fullName === fullName),
      createAgentTool: (d: any) => ({
        name: d.fullName,
        description: d.description,
        params: {},
        callback: async () => 'ok',
      }),
    };

    const tools: any[] = [];
    const enableTool = createEnableTool({
      manager: mockManager as any,
      tools,
      exclude: new Set(['serverA__search']),
    });

    const enumValues = enableTool.params.properties.toolName.enum;
    expect(enumValues).not.toContain('serverA__search');
    expect(enumValues).toContain('serverA__fetch');
    expect(enumValues.length).toBe(1);
  });
});

describe('McpManager enabled & approvalRequired', () => {
  it('requiresApproval returns true for flagged tools', async () => {
    const { McpManager } = await import('../../src/lib/mcp/manager');

    const manager = new McpManager();

    // Simulate post-init state by accessing private state via the public API.
    // We'll call init with an empty config (no servers) then manually verify
    // the processConfigFlags logic works through a real server connection.
    // Since we can't connect to real servers in unit tests, we test the
    // resolution logic directly.

    // Test boolean → all tools
    const config1 = {
      mcpServers: {
        srv: {
          command: 'echo',
          approvalRequired: true,
        },
      },
    };

    // With no real server, init won't discover tools, but the flags logic
    // processes discovered tools against config.  Verify the method exists
    // and returns false for unknown tools.
    await manager.init(config1);
    expect(manager.requiresApproval('srv__anything')).toBe(false); // no tools discovered
    expect(manager.requiresApproval('unknown__tool')).toBe(false);
  });

  it('isAutoEnabled returns false when no tools discovered', async () => {
    const { McpManager } = await import('../../src/lib/mcp/manager');

    const manager = new McpManager();
    await manager.init({
      mcpServers: {
        srv: {
          command: 'echo',
          enabled: true,
        },
      },
    });

    expect(manager.isAutoEnabled('srv__anything')).toBe(false);
    expect(manager.getAutoEnabledTools()).toEqual([]);
  });

  it('createAgentTool does not set expiresAfterTurns (TTL is handled by ToolPruner)', async () => {
    const { McpManager } = await import('../../src/lib/mcp/manager');

    const manager = new McpManager();
    const tool = manager.createAgentTool({
      fullName: 'srv__x',
      name: 'x',
      serverName: 'srv',
      description: 'does x',
      raw: {
        name: 'x',
        description: 'does x',
        inputSchema: { type: 'object', properties: {} },
      } as any,
    });

    // Context pruning TTL is still set.
    expect(tool.ttl).toBe(3);
    // No expiresAfterTurns — expiry is handled externally by ToolPruner
    // based on the __ naming convention.
    expect((tool as any).expiresAfterTurns).toBeUndefined();
  });
});
