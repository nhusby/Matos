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
import {
  loadApprovalConfig,
  decideApproval,
  ensureApprovalConfig,
  isProtectedPath,
  mentionsProtectedPath,
  llmDecideApproval,
  WRITE_TOOLS,
} from './lib/approval/index.js';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * A small bouncing-dot "thinking" indicator driven by reasoning tokens.
 *
 * When reasoning display is off we can't show the raw chain-of-thought, so we
 * animate a 5-column dot that bounces left↔right instead.  The animation is
 * **not** timer-based — `advance()` is called from the `reasoning` event
 * handler roughly every 15 tokens (≈ 60 characters), so the dot speed
 * reflects actual generation throughput.
 *
 * Each frame is exactly 5 characters wide so a `\r` + frame rewrite cleanly
 * overwrites the previous one, and `stop()` erases the whole 5-column span.
 *
 * Frames (forward then reverse, skipping the duplicated endpoints):
 *   ".    "  " .   "  "  .  "  "   . "  "    ."  "   . "  "  .  "  " .   "
 */
function createThinkingAnimation(stream: typeof process.stdout) {
  const FRAMES = [
    '.    ',
    ' .   ',
    '  .  ',
    '   . ',
    '    .',
    '   . ',
    '  .  ',
    ' .   ',
  ];
  const WIDTH = FRAMES[0].length;
  let frame = 0;
  let visible = false;

  function clearLine() {
    // Overwrite the visible frame with spaces, then return to column 0.
    stream.write('\r' + ' '.repeat(WIDTH) + '\r');
  }

  function start() {
    stop();
    frame = 0;
    visible = true;
    stream.write('\r' + FRAMES[frame]);
    frame = (frame + 1) % FRAMES.length;
  }

  /** Advance the animation one step (called per ~15 reasoning tokens). */
  function advance() {
    if (!visible) return;
    stream.write('\r' + FRAMES[frame]);
    frame = (frame + 1) % FRAMES.length;
  }

  function stop() {
    if (visible) {
      clearLine();
      visible = false;
    }
  }

  return { start, advance, stop };
}

async function main() {
  // Clear the terminal and print splash art.
  process.stdout.write('\x1b[2J\x1b[H');
  let splash: string;
  try {
    splash = readFileSync(join(__dirname, 'splash.txt'), 'utf-8');
  } catch {
    splash = 'Matos';
  }
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
      throw new Error('[REJECTED] Tool approval timeout.  No user response.');
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
    onCodeIndexError: (err) =>
      process.stderr.write(`[codeIndex] init error: ${err?.message ?? err}\n`),
  });

  lspManager
    .startDetected(process.cwd())
    .catch((e) =>
      process.stderr.write(`[lsp] startup error: ${e?.message ?? e}\n`),
    );

  // Write default approval rules to ~/.matos/approval.json on first run.
  ensureApprovalConfig().catch((e) =>
    process.stderr.write(`[approval] init error: ${e?.message ?? e}\n`),
  );

  agent.on('tool-call', async (toolCall: ToolCall) => {
    // Guard: approval config files must never be silently modified.
    // File tools (Write/Edit/Delete/Rename) bypass the bash approval gate,
    // so we intercept them here and force interactive approval.
    if (WRITE_TOOLS.has(toolCall.name)) {
      const paths = [
        toolCall.params?.path,
        toolCall.params?.oldPath,
        toolCall.params?.newPath,
      ].filter((p): p is string => typeof p === 'string');
      if (paths.some(isProtectedPath)) {
        activeRenderer?.flush();
        await approveToolCall(toolCall, 'tool-call');
        return;
      }
    }

    const tool = agent.tools.find((t) => t.name === toolCall.name);
    if (!tool?.requiresApproval) return;

    const command = toolCall.params?.command;
    if (typeof command === 'string') {
      let config;
      try {
        // Reload each time so edits to .matos/approval.json take effect live.
        config = await loadApprovalConfig();
      } catch {
        config = { approve: [] as string[], reject: [] as string[] };
      }
      const { decision, matched, rule } = decideApproval(command, config);
      if (decision === 'reject') {
        throw new Error(
          `[REJECTED] Auto-reject rule "${rule}" matched "${matched}" in: ${command}`,
        );
      }
      // Auto-approve only when the decision is "approve" AND the command
      // does not touch the approval config (defense-in-depth for bash).
      if (decision === 'approve' && !mentionsProtectedPath(command)) {
        return;
      }
      // Commands that touch the approval config always require a human — the
      // agent must never rewrite its own safety rules unattended.
      if (!mentionsProtectedPath(command)) {
        // decision === 'prompt' -> delegate to the LLM safety classifier so
        // the user rarely has to approve harmless commands manually.
        const llmDecision = await llmDecideApproval(
          { api: agent.api, model: agent.model },
          command,
        );
        if (llmDecision === 'approve') {
          return;
        }
        if (llmDecision === 'reject') {
          throw new Error(
            `[REJECTED] LLM classified command as dangerous: ${command}`,
          );
        }
        // llmDecision === 'prompt' -> fall through to interactive approval
      }
      // command touches protected path, or LLM was unsure
      // -> fall through to interactive approval
    }

    // Finalize any live markdown frame *before* the interactive approval
    // prompt is drawn, otherwise a pending re-render could clobber the
    // prompt (or leave it glued to a half-rendered frame).
    activeRenderer?.flush();
    await approveToolCall(toolCall, 'tool-call');
  });

  // Initialize MCP (Model Context Protocol) servers
  let mcpManager: McpManager | undefined;
  loadMcpConfig()
    .then(async (mcpConfig) => {
      const mgr = new McpManager();
      mcpManager = mgr;
      await mgr.init(mcpConfig);

      if (mgr.hasTools()) {
        // Auto-enable tools flagged with `enabled` in config
        const autoEnabled = mgr.getAutoEnabledTools();
        for (const tool of autoEnabled) {
          agent.tools.push(mgr.createAgentTool(tool));
        }

        // EnableTool for remaining (non-auto-enabled) tools
        const enableable = mgr
          .getDiscoveredTools()
          .filter((t) => !mgr.isAutoEnabled(t.fullName));
        if (enableable.length > 0) {
          const enableTool = createEnableTool({
            manager: mgr,
            tools: agent.tools,
            exclude: new Set(autoEnabled.map((t) => t.fullName)),
          });
          agent.tools.push(enableTool);
        }
      }
    })
    .catch((err) => {
      process.stderr.write(
        `[mcp] initialization error: ${err?.message ?? err}\n`,
      );
    });

  let currentRun: Emitter | null = null;
  let busy = false;
  let activeRenderer: MarkdownStreamRenderer | null = null;
  const pending: string[] = [];
  // When false (default) reasoning is hidden and replaced by the bouncing-dot
  // thinking indicator.  Toggled with the /think command.
  let showReasoning = false;

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
    const thinking = createThinkingAnimation(process.stdout);
    // Roughly 4 characters per token × 15 tokens = 60 characters per dot step.
    // This is an approximation — we don't ship a tokenizer — but it gives the
    // user a real-time feel for generation throughput.
    const CHARS_PER_DOT = 60;
    let reasoningCharCount = 0;
    let firstReasoningChunk = true;

    currentRun.on('reasoning-start', () => {
      md.flush();
      reasoning = true;
      if (showReasoning) {
        process.stdout.write(THINKING_YELLOW + '\n<thinking>\n');
      } else {
        reasoningCharCount = 0;
        firstReasoningChunk = true;
        thinking.start();
      }
    });
    currentRun.on('reasoning', (chunk: string) => {
      if (showReasoning) {
        if (!reasoning) {
          reasoning = true;
          process.stdout.write('\n' + THINKING_YELLOW);
        }
        process.stdout.write(chunk);
      } else {
        // Agent only emits reasoning-start on the first thinking phase of a
        // turn (response.thinking stays true across tool-call rounds).  If
        // reasoning chunks arrive without a prior reasoning-start, lazily
        // (re)start the animation so the dots reappear between tool calls.
        if (!reasoning) {
          reasoning = true;
          reasoningCharCount = 0;
          firstReasoningChunk = true;
          thinking.start();
        }
        if (firstReasoningChunk) {
          firstReasoningChunk = false;
          thinking.advance();
        }
        reasoningCharCount += chunk.length;
        while (reasoningCharCount >= CHARS_PER_DOT) {
          reasoningCharCount -= CHARS_PER_DOT;
          thinking.advance();
        }
      }
    });
    currentRun.on('reasoning-finished', () => {
      if (showReasoning) {
        process.stdout.write('\n</thinking>' + RESET + '\n\n');
      } else {
        thinking.stop();
      }
      reasoning = false;
    });
    currentRun.on('content', (chunk: string) => {
      if (reasoning) {
        reasoning = false;
        if (showReasoning) {
          process.stdout.write(RESET + '\n');
        } else {
          thinking.stop();
        }
      }
      md.push(chunk);
    });
    currentRun.on('tool-result', (tr: ToolPart) => {
      if (reasoning) {
        reasoning = false;
        if (showReasoning) {
          process.stdout.write(RESET + '\n');
        } else {
          thinking.stop();
        }
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
      thinking.stop();
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

    // Close MCP server connections so spawned child processes exit cleanly.
    const mcp = mcpManager;
    if (mcp) {
      try {
        await Promise.race([
          mcp.close(),
          new Promise((r) => setTimeout(r, 3000)),
        ]);
      } catch (e: any) {
        process.stderr.write(`[mcp] shutdown error: ${e?.message ?? e}\n`);
      }
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
        process.stderr.write(`[codeIndex] dispose error: ${e?.message ?? e}\n`);
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

  process.stdout.write(
    'Commands: /quit /think /index /resume /clear. Press ESC to abort.\n',
  );

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

    if (input === '/think') {
      showReasoning = !showReasoning;
      process.stdout.write(
        `Reasoning display ${showReasoning ? 'ON — showing chain of thought' : 'OFF — showing thinking dots'}.\n`,
      );
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
