import 'dotenv/config';
import OpenAI from 'openai';
import { ToolPart, type ToolCall } from './lib/Agent';
import { Emitter } from './lib/Emitter';
import { createAgent } from './agents/matos';
import type { CodeIndex } from './lib/tools';
import { MultiLineEditor } from './lib/MultiLineEditor';
import { MarkdownStreamRenderer } from './lib/markdownRenderer';
import { saveHistory, loadHistory } from './lib/HistoryManager.js';
import { lspManager } from './lib/lsp/manager.js';
import {
  loadMcpConfig,
  McpManager,
  createEnableTool,
} from './lib/mcp/index.js';
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
  const model = ['Qwen3.6-35B-A3B', 'glm-5.1', 'glm-5-turbo', 'gpt-5-mini'];
  let codeIndex: CodeIndex | undefined;
  const APPROVAL_TIMEOUT = 60_000;

  async function approveToolCall(toolCall: ToolCall, label: string) {
    let timer: ReturnType<typeof setTimeout>;

    const detail = toolCall.params.command
      ? `: ${toolCall.params.command}`
      : Object.keys(toolCall.params).length
        ? ` with: ${JSON.stringify(toolCall.params).slice(0, 200)}`
        : '';

    const input = await Promise.race<string>([
      editor.question(
        `${RESET}\nMatos wants to use ${label}${detail}\n`,
        'Approve [Y]/N/Comment: ',
      ),
      new Promise<string>((resolve) => {
        timer = setTimeout(
          () => resolve('__APPROVAL_TIMEOUT__'),
          APPROVAL_TIMEOUT,
        );
      }),
    ]);

    clearTimeout(timer!);

    if (input === '__APPROVAL_TIMEOUT__') {
      editor.cancelQuestion('');
      throw new Error(
        '[REJECTED] Tool approval timeout.  No user response.',
      );
    }

    const trimmed = input.trim();
    if (!trimmed || /^y(?:es)?$/i.test(trimmed)) return;
    if (/^no?$/i.test(trimmed))
      throw new Error('[REJECTED] User rejected the tool call');
    throw new Error(`[REJECTED] ${trimmed}`);
  }

  const agent = await createAgent({
    api,
    model,
    onCodeIndexReady: (ci) => {
      codeIndex = ci;
    },
  });

  lspManager
    .startDetected(process.cwd())
    .catch((e) =>
      process.stderr.write(`[lsp] startup error: ${e?.message ?? e}\n`),
    );

  agent.on('tool-call', async (toolCall: ToolCall) => {
    const tool = agent.tools.find((t) => t.name === toolCall.name);
    if (tool?.requiresApproval) {
      // Finalize any live markdown frame *before* the interactive approval
      // prompt is drawn, otherwise a pending re-render could clobber the
      // prompt (or leave it glued to a half-rendered frame).
      activeRenderer?.flush();
      await approveToolCall(toolCall, 'tool-call');
    }
  });

  // Initialize MCP (Model Context Protocol) servers
  loadMcpConfig()
    .then(async (mcpConfig) => {
      const mcpManager = new McpManager();
      await mcpManager.init(mcpConfig);

      if (mcpManager.hasTools()) {
        // Auto-enable tools flagged with `enabled` in config
        const autoEnabled = mcpManager.getAutoEnabledTools();
        for (const tool of autoEnabled) {
          agent.tools.push(mcpManager.createAgentTool(tool));
        }

        // EnableTool for remaining (non-auto-enabled) tools
        const enableable = mcpManager
          .getDiscoveredTools()
          .filter((t) => !mcpManager.isAutoEnabled(t.fullName));
        if (enableable.length > 0) {
          const enableTool = createEnableTool({
            manager: mcpManager,
            tools: agent.tools,
            exclude: new Set(autoEnabled.map((t) => t.fullName)),
          });
          agent.tools.push(enableTool);
        }
      }
    })
    .catch((err) => {
      process.stderr.write(`[mcp] initialization error: ${err?.message ?? err}\n`);
    });

  let currentRun: Emitter | null = null;
  let busy = false;
  let activeRenderer: MarkdownStreamRenderer | null = null;
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
    let reasoning = false;
    const md = new MarkdownStreamRenderer(process.stdout);
    activeRenderer = md;

    currentRun.on('reasoning-start', () => {
      md.flush();
      reasoning = true;
      process.stdout.write(THINKING_YELLOW + '\n<thinking>\n');
    });
    currentRun.on('reasoning', (chunk: string) => {
      if (!reasoning) {
        reasoning = true;
        process.stdout.write('\n' + THINKING_YELLOW);
      }
      process.stdout.write(chunk);
    });
    currentRun.on('reasoning-finished', () => {
      process.stdout.write('\n</thinking>' + RESET + '\n\n');
      reasoning = false;
    });
    currentRun.on('content', (chunk: string) => {
      if (reasoning) {
        reasoning = false;
        process.stdout.write(RESET + '\n');
      }
      md.push(chunk);
    });
    currentRun.on('tool-result', (tr: ToolPart) => {
      if (reasoning) {
        reasoning = false;
        process.stdout.write(RESET + '\n');
      }
      md.flush();
      const pathInfo = tr.params?.path ? ` [${tr.params.path}]` : '';
      process.stdout.write(`\n## ToolCall ${tr.name}${pathInfo} Result:\n`);
      process.stdout.write(
        '  ' + tr.content.replace(/\s+/g, ' ').slice(0, 78) + '\n',
      );
    });

    try {
      await currentRun.toPromise();
    } catch (e: any) {
      md.flush();
      if (e?.name === 'AbortError' || e?.name === 'APIUserAbortError') {
        process.stdout.write('\n[aborted]\n');
      } else {
        process.stderr.write(`\n[error: ${e?.stack ?? e?.message ?? e}]\n`);
      }
    } finally {
      currentRun = null;
    }

    md.flush();
    process.stdout.write('\n');
    await persistHistory();
  }

  let shuttingDown = false;
  async function shutdown(exitCode = 130) {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
      await Promise.race([
        lspManager.shutdownAll(),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    } catch (e: any) {
      process.stderr.write(`[lsp] shutdown error: ${e?.message ?? e}\n`);
    }

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

    // Dispose of the ONNX Runtime inference session so its native threads
    // are torn down cleanly.  Without this, process.exit()
    // races with live threads and crashes with
    // "mutex lock failed: Invalid argument".
    if (codeIndex) {
      try {
        await Promise.race([
          codeIndex.dispose(),
          new Promise((r) => setTimeout(r, 3000)),
        ]);
      } catch (e: any) {
        process.stderr.write(
          `[codeIndex] dispose error: ${e?.message ?? e}\n`,
        );
      }
    }

    // Use SIGKILL to skip native C++ cleanup that causes the
    // "mutex lock failed: Invalid argument" crash in ONNX Runtime.
    // SIGKILL cannot be caught and immediately terminates the process
    // without running destructors or atexit handlers.
    process.kill(process.pid, 'SIGKILL');
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
