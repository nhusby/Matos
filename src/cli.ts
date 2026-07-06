import { createInterface, emitKeypressEvents } from 'readline';
import OpenAI from 'openai';
import { ToolPart } from './lib/Agent';
import { Emitter } from './lib/Emitter';
import { createAgent } from './agents/matos';
import type { CodeIndex } from './lib/tools';
import { saveHistory, loadHistory } from './lib/HistoryManager.js';

async function main() {
  const THINKING_YELLOW = '\x1b[93m';
  const RESET = '\x1b[0m';

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  const apiKey = process.env['OPENAI_API_KEY'];
  const baseUrl = process.env['OPENAI_BASE_URL'];

  if (!apiKey) {
    console.error('OPENAI_API_KEY environment variable is required');
    process.exit(1);
  }

  const api = new OpenAI({
    apiKey,
    baseURL: baseUrl,
  }) as any;
  const model = [
    'Qwen3.6-35B-A3B',
    // 'glm-5.2',
    'glm-5-turbo',
    'gpt-5-mini'
  ];
  let codeIndex: CodeIndex | undefined;
  const agent = await createAgent({
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

  async function persistHistory() {
    try {
      await saveHistory(agent);
    } catch (e: any) {
      process.stderr.write(`[history save failed: ${e?.message ?? e}]\n`);
    }
  }

  async function handleInput(input: string) {
    currentRun = agent.sendMessage({
      role: 'user',
      content: input,
      created: new Date(),
    });

    currentRun.on('reasoning-start', () => process.stdout.write(THINKING_YELLOW + '<thinking>\n'));
    currentRun.on('reasoning', (chunk: string) => process.stdout.write(THINKING_YELLOW + chunk));
    currentRun.on('reasoning-finished', () => {
      process.stdout.write('\n</thinking>' + RESET + '\n\n');
    });
    currentRun.on('content', (chunk: string) => process.stdout.write(chunk));
    currentRun.on('tool-result', (tr: ToolPart) => {
      const pathInfo = tr.params?.path ? ` [${tr.params.path}]` : '';
      console.log(`## ToolCall ${tr.name}${pathInfo} Result`);
      console.log(tr.content.replace(/\s+/g, ' ').slice(0, 80));
    });

    try {
      await currentRun.toPromise();
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        process.stdout.write('\n[aborted]\n');
      } else {
        process.stderr.write(`\n[error: ${e?.stack ?? e?.message ?? e}]\n`);
      }
    } finally {
      currentRun = null;
    }

    process.stdout.write('\n\n');
    await persistHistory();
  }

  let shuttingDown = false;
  function shutdown(exitCode = 130) {
    if (shuttingDown) return;
    shuttingDown = true;
    currentRun?.abort();
    rl.close();
    process.exit(exitCode);
  }

  process.on('SIGINT', () => shutdown());

  rl.on('line', async (line) => {
    const input = line.trim();

    if (input === '/quit') {
      shutdown(0);
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
        .catch((e: any) => process.stderr.write(`\n[index error: ${e?.stack ?? e?.message ?? e}]\n`))
        .finally(() => {
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
      } else {
        process.stdout.write('No saved history found. Start fresh, dude.\n');
      }
      rl.prompt();
      return;
    }

    if (input === '/clear') {
      if (busy) {
        process.stdout.write('Busy, please wait.\n');
        rl.prompt();
        return;
      }
      agent.messages = [];
      agent.readFiles.clear();
      await persistHistory();
      process.stdout.write('Cleared messages and read cache. Fresh start!\n\n');
      rl.prompt();
      return;
    }

    if (!input) {
      rl.prompt();
      return;
    }

    if (busy) {
      pending.push(input);
      return;
    }

    busy = true;
    try {
      await handleInput(input);
      while (pending.length) {
        await handleInput(pending.shift()!);
      }
    } catch (e: any) {
      process.stderr.write(`\n[unhandled error: ${e?.stack ?? e?.message ?? e}]\n`);
    } finally {
      busy = false;
      rl.prompt();
    }
  });
}

main().catch(console.error);
