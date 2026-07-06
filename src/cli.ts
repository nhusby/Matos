import 'dotenv/config';
import OpenAI from 'openai';
import { ToolPart } from './lib/Agent';
import { Emitter } from './lib/Emitter';
import { createAgent } from './agents/matos';
import type { CodeIndex } from './lib/tools';
import { MultiLineEditor } from './lib/MultiLineEditor';
import { saveHistory, loadHistory } from './lib/HistoryManager.js';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  // Clear the terminal and print splash art.
  process.stdout.write('\x1b[2J\x1b[H');
  const splash = readFileSync(join(__dirname, 'splash.txt'), 'utf-8');
  console.log(splash);

  const THINKING_YELLOW = '\x1b[93m';
  const RESET = '\x1b[0m';

  const editor = new MultiLineEditor({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  const apiKey = process.env['OPENAI_API_KEY'];
  const baseUrl = process.env['OPENAI_BASE_URL'];

  if (!apiKey && !baseUrl) {
    console.error(
      'Missing OPENAI_API_KEY and OPENAI_BASE_URL environment variables',
    );
    process.exit(1);
  }

  const api = new OpenAI({
    apiKey,
    baseURL: baseUrl,
  }) as any;
  const model = ['Qwen3.6-35B-A3B', 'glm-5.2', 'glm-5-turbo', 'gpt-5-mini'];
  let codeIndex: CodeIndex | undefined;
  const agent = await createAgent({
    api,
    model,
    onCodeIndexReady: (ci) => {
      codeIndex = ci;
    },
  });

  let currentRun: Emitter | null = null;
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

    currentRun.on('reasoning-start', () =>
      process.stdout.write(THINKING_YELLOW + '\n<thinking>\n'),
    );
    currentRun.on('reasoning', (chunk: string) =>
      process.stdout.write(THINKING_YELLOW + chunk),
    );
    currentRun.on('reasoning-finished', () => {
      process.stdout.write('\n</thinking>' + RESET + '\n\n');
    });
    currentRun.on('content', (chunk: string) => process.stdout.write(chunk));
    currentRun.on('tool-result', (tr: ToolPart) => {
      const pathInfo = tr.params?.path ? ` [${tr.params.path}]` : '';
      process.stdout.write(`\n## ToolCall ${tr.name}${pathInfo} Result:\n`);
      process.stdout.write(tr.content.replace(/\s+/g, ' ').slice(0, 80));
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
  async function shutdown(exitCode = 130) {
    if (shuttingDown) return;
    shuttingDown = true;

    process.stdin.pause();
    editor.close();

    const run = currentRun;
    if (run) {
      run.abort();
      // Wait for in-flight HTTP streams to actually reject on abort.
      await Promise.race([
        run.toPromise().catch(() => {}),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    }

    // Let the event loop drain naturally so native backends (TLS,
    // ONNX Runtime, etc.) can clean up their threads without racing
    // a forced exit.  process.exit() is only a last-resort fallback.
    process.exitCode = exitCode;
    setTimeout(() => process.exit(exitCode), 2000).unref();
  }

  editor.on('escape', () => {
    if (currentRun) currentRun.abort();
  });
  editor.on('sigint', () => shutdown());
  editor.on('close', () => shutdown(0));
  process.on('SIGINT', () => shutdown());

  process.stdout.write('Type /quit to exit. Press ESC to abort.\n');

  editor.on('line', async (line) => {
    const input = line.trim();

    if (input === '/quit') {
      shutdown(0);
      return;
    }

    if (input === '/index') {
      if (!codeIndex) {
        process.stdout.write('Code search not initialized yet.\n');
        editor.prompt();
        return;
      }
      if (busy) {
        process.stdout.write('Busy, please wait.\n');
        editor.prompt();
        return;
      }
      busy = true;
      codeIndex
        .indexProject((msg: string) => process.stdout.write(msg + '\n'))
        .catch((e: any) =>
          process.stderr.write(
            `\n[index error: ${e?.stack ?? e?.message ?? e}]\n`,
          ),
        )
        .finally(() => {
          busy = false;
          editor.prompt();
        });
      return;
    }

    if (input === '/resume') {
      if (busy) {
        process.stdout.write('Busy, please wait.\n');
        editor.prompt();
        return;
      }
      const result = await loadHistory(agent);
      if (result.loaded) {
        process.stdout.write(
          `Resumed from history: ${result.messageCount} messages loaded.\n\n`,
        );
      } else {
        process.stdout.write('No saved history found. Start fresh, dude.\n');
      }
      editor.prompt();
      return;
    }

    if (input === '/clear') {
      if (busy) {
        process.stdout.write('Busy, please wait.\n');
        editor.prompt();
        return;
      }
      agent.messages = [];
      agent.readFiles.clear();
      await persistHistory();
      process.stdout.write('Cleared messages and read cache. Fresh start!\n\n');
      editor.prompt();
      return;
    }

    if (!input) {
      editor.prompt();
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
      process.stderr.write(
        `\n[unhandled error: ${e?.stack ?? e?.message ?? e}]\n`,
      );
    } finally {
      busy = false;
      editor.prompt();
    }
  });

  editor.prompt();
}

main().catch(console.error);
