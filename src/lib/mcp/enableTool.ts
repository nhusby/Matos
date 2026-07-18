import type { Tool } from '../Agent.js';
import type { McpManager } from './manager.js';
import type { DiscoveredMcpTool } from './manager.js';

export interface EnableToolConfig {
  manager: McpManager;
  /** The agent's tools array to push enabled tools into */
  tools: Tool[];
  /** Tool fullNames to exclude from the enum (e.g. auto-enabled tools) */
  exclude?: Set<string>;
}

/**
 * Creates the "EnableTool" tool.  Its `toolName` parameter is an enum
 * of every available MCP tool.  When the agent invokes this tool,
 * the selected MCP tool is wrapped as an agent Tool and pushed onto
 * the agent's tools array, making it available for all subsequent turns.
 */
export function createEnableTool(config: EnableToolConfig): Tool {
  const { manager, tools, exclude } = config;
  const discovered = manager
    .getDiscoveredTools()
    .filter((t) => !exclude?.has(t.fullName));

  const toolNames = discovered.map((t) => t.fullName);

  const toolDescriptions = discovered
    .map(
      (t) =>
        `  - ${t.fullName}: ${t.description || '(no description)'}  [server: ${t.serverName}]`,
    )
    .join('\n');

  return {
    name: 'EnableTool',
    description: `Enable an MCP (Model Context Protocol) tool for use in this session. Use this tool to activate external tools provided by connected MCP servers. Once enabled, the tool remains available for 3 turns of inactivity (it is automatically disabled if unused for 3 consecutive turns; using it resets the countdown).

Available MCP tools:
${toolDescriptions}`,
    params: {
      type: 'object',
      properties: {
        toolName: {
          type: 'string',
          enum: toolNames,
          description: 'The full name of the MCP tool to enable.',
        },
      },
      required: ['toolName'],
    },
    callback: async (params: any) => {
      const toolName: string = params.toolName;
      const discoveredTool: DiscoveredMcpTool | undefined =
        manager.getDiscoveredTool(toolName);

      if (!discoveredTool) {
        return `Error: MCP tool "${toolName}" not found. Available tools: ${toolNames.join(', ')}`;
      }

      // Check if already enabled
      if (tools.some((t) => t.name === discoveredTool.fullName)) {
        return `MCP tool "${toolName}" is already enabled.`;
      }

      const agentTool = manager.createAgentTool(discoveredTool);
      tools.push(agentTool);

      return `Enabled MCP tool "${toolName}". You can now use it. ${discoveredTool.description ? `Description: ${discoveredTool.description}` : ''}`;
    },
  };
}
