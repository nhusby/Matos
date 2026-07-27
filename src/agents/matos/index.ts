import { resolve } from 'path';
import { access, readFile } from 'fs/promises';
import { Agent, type Api, type Message } from '../../lib/Agent.js';
import { pruneContext } from '../../lib/ContextPruner.js';
import { pruneTools } from '../../lib/ToolPruner.js';
import {
  createReadFileTool,
  createWriteFileTool,
  createEditFileTool,
  renameSymbolTool,
  readFileWithContextTool,
  renameFileTool,
  deleteFileTool,
  createListFilesTool,
  createTextSearchTool,
  createBashTool,
  buildFileTree,
} from '../../lib/tools';
import { systemPrompt } from './system-prompt.js';

export interface CreateMatosAgentOptions {
  api: Api;
  model: string | string[];
}

/**
 * Build the matos coding agent: core filesystem / search / bash tools, the
 * system prompt, and the per-turn housekeeping hooks (file-tree injection,
 * read-file cache, context + tool pruning).
 *
 * This function is concerned only with *defining the agent*.  App-level
 * concerns — OpenAI client construction, semantic code index, MCP/LSP servers,
 * conversation logging, approval gating — live in `MatosApp`.
 */
export async function createMatosAgent(
  opts: CreateMatosAgentOptions,
): Promise<Agent> {
  const agent = await new Agent({
    api: opts.api,
    model: opts.model,
    tools: [
      createReadFileTool(),
      createWriteFileTool(),
      createEditFileTool(),
      renameSymbolTool,
      readFileWithContextTool,
      createListFilesTool({ bypassCwd: true }),
      createTextSearchTool(),
      deleteFileTool,
      renameFileTool,
      createBashTool({ timeout: 60_000 }),
    ],
    systemPrompt,
  }).init();

  attachTurnHooks(agent);

  return agent;
}

/**
 * Wire the per-turn housekeeping that keeps the agent's context fresh:
 *  - on `send-message`: drop stale file paths from the read cache, inject the
 *    current file tree and cached file contents as ephemeral system messages.
 *  - on `finalizing`: prune inactive MCP tools and summarize/expire old tool
 *    results, re-caching any readFile outputs that got pruned.
 */
function attachTurnHooks(agent: Agent): void {
  agent.on('send-message', async () => {
    // Prune stale file paths (deleted since last read)
    for (const path of agent.readFiles) {
      try {
        await access(resolve(path));
      } catch {
        agent.readFiles.delete(path);
      }
    }

    // Inject file tree once per turn
    const fileTree = await buildFileTree();
    agent.messages.push({
      role: 'system',
      content: `Current working directory:\n ${fileTree}`,
      created: new Date(),
      ttl: 1,
    } as Message);

    // Inject cached file reads
    if (agent.readFiles.size > 0) {
      const fileContents = (
        await Promise.all(
          [...agent.readFiles].map(async (path) => {
            const content = await readFile(resolve(path), 'utf-8').catch(
              () => null,
            );
            return `<File path="${path}">\n\`\`\`typescript\n${content ?? '[file not readable]'}\n\`\`\`\n</File>`;
          }),
        )
      ).join('\n');

      agent.messages.push({
        role: 'system',
        content: `System cached file reads:
<Files>\n${fileContents}\n</Files>`,
        created: new Date(),
        ttl: 1,
      } as Message);
    }
  });

  agent.on('finalizing', async () => {
    pruneTools(agent.tools, agent.messages);
    const prunedFiles = await pruneContext(agent.messages, agent.tools, {
      api: agent.api,
      model: agent.model,
    });
    for (const path of prunedFiles) {
      agent.readFiles.add(path);
    }
  });
}
