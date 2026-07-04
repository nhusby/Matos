import { createInterface, emitKeypressEvents } from 'readline';
import OpenAI from 'openai';
import { ToolPart } from './lib/Agent';
import { Emitter } from './lib/Emitter';
import { createDevAgent } from './agents/dev';
import type { Agent, Message } from './lib/Agent';
import type { CodeIndex } from './lib/tools';
import { saveHistory, loadHistory } from './lib/HistoryManager.js';

async function main() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    console.error('OPENAI_API_KEY environment variable is required');
    process.exit(1);
  }

  const api = new OpenAI({
    apiKey,
    baseURL: 'http://ryzenrig:8080/v1', // process.env['OPENAI_BASE_URL']
  }) as any;
  const model = ['Qwen3.6-35B-A3B', 'glm-5-turbo', 'gpt-5-mini'];

  let codeIndex: CodeIndex | undefined;
  const agent = await createDevAgent({
    api,
    model,
    onCodeIndexReady: (ci) => {
      codeIndex = ci;
      process.stdout.write('Code search ready.\n');
      rl.prompt();
    },
    onCodeIndexError: (err) => {
      process.stdout.write(`Code search unavailable: ${err.message}\n`);
      rl.prompt();
    },
  });

  process.stdout.write('Chat initialized. Type /quit to exit. Press ESC to abort.\n');
  rl.prompt();

  let currentRun: Emitter | null = null;
  emitKeypressEvents(process.stdin);
  process.stdin.on('keypress', (_str: string, key: { name?: string } | undefined) => {
    if (key?.name === 'escape' && currentRun) {
      currentRun.abort();
    }
  });

  let busy = false;
  const pending: string[] = [];

  async function handleInput(input: string) {
    const message: Message = {
      role: 'user',
      content: input,
      created: new Date(),
    };

    const run = agent.sendMessage(message);
    currentRun = run;

    run.on('content', (chunk: string) => {
      process.stdout.write(chunk);
    });

    run.on('tool-result', (toolCallResult: ToolPart) => {
      const pathInfo = toolCallResult.params?.path ? ` [${toolCallResult.params.path}]` : '';
      console.log(`## ToolCall ${toolCallResult.name}${pathInfo} Result`);
      console.log(
        toolCallResult.content
          .replace(/\s+/g, ' ')
          .slice(0, 80),
      );
    });

    try {
      await run.toPromise();
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        process.stdout.write('\n[aborted]\n');
      } else {
        process.stdout.write(`\n[error: ${e.message}]\n`);
      }
    } finally {
      currentRun = null;
    }

    process.stdout.write('\n\n');
    await saveHistory(agent);
  }

  rl.on('line', async (line) => {
    const input = line.trim();
    if (input === '/quit') {
      rl.close();
      return;
    }
    if (input === '/index') {
      if (!codeIndex) {
        process.stdout.write('Code search not initialized yet.\n');
        rl.prompt();
        return;
      }
      if (busy) {
        process.stdout.write('Busy, please wait.\n');
        rl.prompt();
        return;
      }
      busy = true;
      codeIndex
        .indexProject((msg: string) => process.stdout.write(msg + '\n'))
        .then(() => {
          busy = false;
          rl.prompt();
        });
      return;
    }
    if (input === '/resume') {
      if (busy) {
        process.stdout.write('Busy, please wait.\n');
        rl.prompt();
        return;
      }
      const result = await loadHistory(agent);
      if (result.loaded) {
        process.stdout.write(`Resumed from history: ${result.messageCount} messages loaded.\n\n`);
        rl.prompt();
        return;
      } else {
        process.stdout.write('No saved history found. Start fresh, dude.\n');
        rl.prompt();
        return;
      }
    }
    if (input === '/clear') {
      if (busy) {
        process.stdout.write('Busy, please wait.\n');
        rl.prompt();
        return;
      }
      agent.messages = [];
      agent.readFiles.clear();
      await saveHistory(agent);
      process.stdout.write('Cleared messages and read cache. Fresh start!\n\n');
      rl.prompt();
      return;
    }
    if (!input) {
      rl.prompt();
      return;
    }

    process.stdout.write("\n");

    if (busy) {
      pending.push(input);
      return;
    }

    busy = true;
    handleInput(input).then(async () => {
      while (pending.length) {
        await handleInput(pending.shift()!);
      }
      busy = false;
      rl.prompt();
    });
  });
}

main().catch(console.error);
