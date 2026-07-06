import ts from 'typescript';
import { resolve } from 'path';
import { TransformersEmbeddings } from 'vectra';
import { Agent, type Api, type Message } from '../../lib/Agent.js';
import { pruneContext } from '../../lib/ContextPruner.js';
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  renameSymbolTool,
  readFileWithContextTool,
  createListFilesTool,
  createTextSearchTool,
  deleteFileTool,
  renameFileTool,
  createSearchCodeTool,
  CodeIndex,
  buildFileTree,
} from '../../lib/tools';
import { systemPrompt } from './system-prompt.js';

export interface DevAgentConfig {
  api: Api;
  model: string | string[];
  onCodeIndexReady?: (codeIndex: CodeIndex) => void;
  onCodeIndexError?: (err: Error) => void;
}

export async function createDevAgent(config: DevAgentConfig): Promise<Agent> {
  const agent = await new Agent({
    api: config.api,
    model: config.model,
    tools: [
      readFileTool,
      writeFileTool,
      editFileTool,
      renameSymbolTool,
      readFileWithContextTool,
      createListFilesTool({ bypassCwd: true }),
      createTextSearchTool(),
      deleteFileTool,
      renameFileTool,
    ],
    systemPrompt,
  }).init();

  agent.on('send-message', async () => {
    for (const path of agent.readFiles) {
      if (!ts.sys.fileExists(resolve(path))) {
        agent.readFiles.delete(path);
      }
    }
    if (agent.readFiles.size === 0) return;

    const fileContents = [...agent.readFiles]
      .map((path) => {
        const content = ts.sys.readFile(resolve(path));
        return `<File path="${path}">\n\`\`\`typescript\n${content ?? '[file not readable]'}\n\`\`\`\n</File>`;
      })
      .join('\n');

    agent.messages.push({
      role: 'system',
      content: `<Files>\n${fileContents}\n</Files>`,
      created: new Date(),
      ttl: 1,
    } as Message);
  });

  agent.on('send-messages', async (messages: Message[]) => {
    const fileTree = await buildFileTree();
    return [
      ...messages.slice(0, 1),
      {
        role: 'system',
        content: `Current working directory:\n ${fileTree}`,
        created: new Date(),
      },
      ...messages.slice(1),
    ];
  });

  agent.on('finalizing', async () => {
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
    dtype: 'fp16',
  })
    .then(async (embeddings) => {
      const codeIndex = new CodeIndex({
        projectRoot: process.cwd(),
        embeddings,
        api: config.api as any,
        model: Array.isArray(config.model) ? config.model[0] : config.model,
      });
      await codeIndex.init();
      agent.tools.push(createSearchCodeTool({ codeIndex }));
      config.onCodeIndexReady?.(codeIndex);
    })
    .catch((err) => {
      config.onCodeIndexError?.(err);
    });

  return agent;
}
