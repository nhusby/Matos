import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Emitter } from './lib/Emitter.js';
import { MultiLineEditor } from './lib/MultiLineEditor.js';
import { MarkdownStreamRenderer } from './lib/markdownRenderer.js';
import { MatosApp } from './app/MatosApp.js';
import type { ToolPart } from './lib/Agent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const THINKING_YELLOW = '\x1b[93m';
const RESET = '\x1b[0m';
const APPROVAL_TIMEOUT = 60_000;

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

  const editor = new MultiLineEditor({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  let app: MatosApp;
  try {
    app = await MatosApp.create();
  } catch (e: any) {
    console.error(e?.message ?? e);
    process.exit(1);
  }

  // ---- UI state -----------------------------------------------------------
  let currentRun: Emitter | null = null;
  let busy = false;
  let activeRenderer: MarkdownStreamRenderer | null = null;
  const pending: string[] = [];
  // When false (default) reasoning is hidden and replaced by the bouncing-dot
  // thinking indicator.  Toggled with the /think command.
  let showReasoning = false;

  // ---- app → UI wiring ----------------------------------------------------

  // Diagnostic log lines → stderr.
  app.on('log', (msg) => process.stderr.write(msg));

  // Auto-rejected tool calls → single-line notice.  Track the ID so the
  // ensuing tool-result (which carries the same reason) is not printed twice.
  const autoRejected = new Set<string>();
  app.on('tool-call-auto-rejected', ({ toolCall, reason }) => {
    autoRejected.add(toolCall.id);
    process.stdout.write(`\n${reason}\n`);
  });

  // The one human-in-the-loop seam: the app asks, the terminal answers.
  app.on('tool-call-approval', async (req) => {
    activeRenderer?.flush();
    await promptApproval(req.detail);
  });

  // Indexing busy flag → guard input.
  app.on('busy', (b) => {
    busy = b;
  });

  async function promptApproval(detail: string) {
    let timer: ReturnType<typeof setTimeout>;
    const input = await Promise.race<string>([
      editor.question(
        `${RESET}\nMatos wants to use tool-call${detail}\n`,
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

  async function persistHistory() {
    try {
      await app.saveHistory();
    } catch (e: any) {
      process.stderr.write(`[history save failed: ${e?.message ?? e}]\n`);
    }
  }

  // ---- turn streaming -----------------------------------------------------

  async function handleInput(input: string) {
    process.stdout.write('\n');
    currentRun = app.send(input);
    let reasoning = false;
    const md = new MarkdownStreamRenderer(process.stdout);
    activeRenderer = md;
    const thinking = createThinkingAnimation(process.stdout);
    // Roughly 4 characters per token × 15 tokens = 60 characters per dot step.
    // This is an approximation — we don't ship a tokenizer — but it gives the
    // user a real-time feel for generation throughput.
    const CHARS_PER_DOT = 64;
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
        // App only emits reasoning-start on the first thinking phase of a
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
      if (autoRejected.has(tr.toolCallId)) {
        autoRejected.delete(tr.toolCallId);
        return;
      }
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

  // ---- shutdown -----------------------------------------------------------

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

    await app.dispose();

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

  // ---- REPL ---------------------------------------------------------------

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
      if (busy) {
        process.stdout.write('Busy, please wait.\n');
        editor.prompt();
        return;
      }
      app
        .indexProject((msg: string) => process.stdout.write(msg + '\n'))
        .catch((e: any) =>
          process.stderr.write(
            `\n[index error: ${e?.stack ?? e?.message ?? e}]\n`,
          ),
        )
        .finally(() => {
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
      const result = await app.loadHistory();
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
      await app.clearHistory();
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
