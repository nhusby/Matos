import { resolve } from 'path';
import { access, readFile } from 'fs/promises';
import { TransformersEmbeddings } from 'vectra';
import { env } from '@huggingface/transformers';
import { Agent, type Api, type Message } from '../../lib/Agent.js';
import { pruneContext } from '../../lib/ContextPruner.js';
import { pruneTools } from '../../lib/ToolPruner.js';
import { ConversationLogger } from '../../lib/ConversationLogger.js';
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
  createSemanticSearchTool,
  CodeIndex,
  buildFileTree,
} from '../../lib/tools';
import { systemPrompt } from './system-prompt.js';

// Force single-threaded ONNX execution.  Multi-threaded ORT spawns
// native pthreads that race with process.exit() during shutdown,
// causing "mutex lock failed: Invalid argument" crashes.
// NOTE: onnxruntime-node ignores wasm.* settings; these only apply
// to onnxruntime-web. Shutdown uses SIGKILL as a reliable fix.
try {
  env.backends.onnx.wasm!.numThreads = 1;
} catch {
  // env.backends.onnx.wasm may not exist in all environments
}

export interface DevAgentConfig {
  api: Api;
  model: string | string[];
  onCodeIndexReady?: (codeIndex: CodeIndex) => void;
  onCodeIndexError?: (err: Error) => void;
}

export async function createAgent(config: DevAgentConfig): Promise<Agent> {
  const agent = await new Agent({
    api: config.api,
    model: config.model,
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

  new ConversationLogger().attach(agent);

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

  TransformersEmbeddings.create({
    model: 'Xenova/all-MiniLM-L6-v2',
    maxTokens: 512,
    device: 'auto',
    dtype: 'fp32',
  })
    .then(async (embeddings) => {
      const codeIndex = new CodeIndex({
        projectRoot: process.cwd(),
        embeddings,
        api: config.api as any,
        model: Array.isArray(config.model) ? config.model[0] : config.model,
      });
      await codeIndex.init();
      agent.tools.push(createSemanticSearchTool({ codeIndex }));
      config.onCodeIndexReady?.(codeIndex);
    })
    .catch((err) => {
      config.onCodeIndexError?.(err);
    });

  return agent;
}
