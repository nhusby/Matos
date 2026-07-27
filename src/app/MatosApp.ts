import 'dotenv/config';
import OpenAI from 'openai';

import { Agent, type Api, type MessageEvents, type ToolCall } from '../lib/Agent.js';
import { Emitter } from '../lib/Emitter.js';
import { createMatosAgent } from '../agents/matos/index.js';
import { ConversationLogger } from '../lib/ConversationLogger.js';
import { saveHistory, loadHistory } from '../lib/HistoryManager.js';
import { lspManager } from '../lib/lsp/manager.js';
import {
  loadMcpConfig,
  McpManager,
  createEnableTool,
} from '../lib/mcp/index.js';
import {
  loadApprovalConfig,
  decideApproval,
  ensureApprovalConfig,
  isProtectedPath,
  mentionsProtectedPath,
  llmDecideApproval,
  WRITE_TOOLS,
} from '../lib/approval/index.js';
import { TransformersEmbeddings } from 'vectra';
import { env as transformersEnv } from '@huggingface/transformers';
import { CodeIndex, createSemanticSearchTool } from '../lib/tools/index.js';
import type { IndexStats } from '../lib/codeRag/codeIndex.js';

// Force single-threaded ONNX execution.  Multi-threaded ORT spawns native
// pthreads that race with process.exit() during shutdown, causing
// "mutex lock failed: Invalid argument" crashes.
try {
  transformersEnv.backends.onnx.wasm!.numThreads = 1;
} catch {
  // env.backends.onnx.wasm may not exist in all environments
}

/** A short, human-readable description of why a tool call needs review. */
export interface ToolApprovalRequest {
  toolCall: ToolCall;
  /** Single-line summary, e.g. `Matos wants to use ReadFile: src/cli.ts`. */
  detail: string;
}

/** Emitted when an auto-reject rule denied a call without prompting. */
export interface ToolAutoRejected {
  toolCall: ToolCall;
  reason: string;
}

/**
 * Events emitted by {@link MatosApp}.
 *
 * Streaming events (start / reasoning* / content / tool-result / end / aborted
 * / error) are forwarded verbatim from the underlying Agent turn — a UI only
 * needs to listen here, not on the Agent directly.
 *
 * The two approval events are the only place app and UI interleave:
 *  - `tool-call-approval` — a human decision is required.  The listener either
 *    returns (approve) or throws (reject); throwing propagates through the
 *    Emitter and rejects the tool call.
 *  - `tool-call-auto-rejected` — the app denied the call itself; informational.
 */
export interface AppEvents extends MessageEvents {
  /** Human approval is required to proceed with this tool call. */
  'tool-call-approval': ToolApprovalRequest;
  /** The app auto-rejected a tool call (rule, protected path, or classifier). */
  'tool-call-auto-rejected': ToolAutoRejected;
  /** A diagnostic log line — route to stderr / GUI console. */
  log: string;
  /** Indexing is running (true) or finished (false). */
  busy: boolean;
}

export interface MatosAppOptions {
  /** Override the OpenAI-compatible client (default: built from env vars). */
  api?: Api;
  /** Override the model list (default: see DEFAULT_MODELS). */
  model?: string | string[];
}

const DEFAULT_MODELS = [
  'Qwen3.6-35B-A3B',
  'glm-5.1',
  'glm-5-turbo',
  'gpt-5-mini',
];

/**
 * UI-agnostic orchestration for the matos coding agent.
 *
 * Owns the {@link Agent} plus every app-level service: the OpenAI client,
 * semantic code index, MCP servers, LSP servers, and the auto-approval gate.
 * Emits a single event stream a UI can subscribe to.  A CLI, GUI, or IDE
 * plugin all consume this surface identically — none of them need to know
 * about each other's internals.
 */
export class MatosApp extends Emitter<AppEvents> {
  readonly agent: Agent;
  readonly api: Api;
  readonly model: string | string[];

  private readonly log = (msg: string) => this.emit('log', msg);
  private readonly mcp = new McpManager();
  private codeIndex?: CodeIndex;
  private conversationLogger?: ConversationLogger;

  private constructor(opts: { agent: Agent; api: Api; model: string | string[] }) {
    super();
    this.agent = opts.agent;
    this.api = opts.api;
    this.model = opts.model;
    this.conversationLogger = new ConversationLogger();
    this.conversationLogger.attach(this.agent);
    this.wireApprovalGate();
  }

  /**
   * Build the OpenAI client from `OPENAI_API_KEY` / `OPENAI_BASE_URL`, construct
   * the matos agent, and start all background services.  Throws when required
   * env vars are missing.
   */
  static async create(opts: MatosAppOptions = {}): Promise<MatosApp> {
    const apiKey = opts.api ? undefined : process.env['OPENAI_API_KEY'];
    const baseUrl = process.env['OPENAI_BASE_URL'];

    let api: Api;
    if (opts.api) {
      api = opts.api;
    } else {
      if (!apiKey && !baseUrl) {
        throw new Error(
          'Missing OPENAI_API_KEY and OPENAI_BASE_URL environment variables',
        );
      }
      api = new OpenAI({ apiKey, baseURL: baseUrl }) as unknown as Api;
    }

    const model = opts.model ?? DEFAULT_MODELS;
    const agent = await createMatosAgent({ api, model });
    const app = new MatosApp({ agent, api, model });
    app.bridgeAgentEvents();
    app.startServices();
    return app;
  }

  /**
   * Forward streaming events from the underlying Agent onto this app emitter.
   * The Agent already re-emits per-turn events onto itself (see
   * `Agent.sendMessage`), so a single bridge here covers every turn — no
   * per-send wiring needed.
   */
  private bridgeAgentEvents(): void {
    const names: (keyof AppEvents)[] = [
      'start',
      'reasoning-start',
      'reasoning',
      'reasoning-finished',
      'content',
      'tool-result',
      'end',
      'aborted',
      'error',
    ];
    for (const name of names) {
      this.agent.on(name as string, (arg: any) => {
        // Void events carry no arg; emit accordingly.
        if (arg === undefined) {
          this.emit(name as keyof AppEvents).catch(() => {});
        } else {
          this.emit(name as keyof AppEvents, arg).catch(() => {});
        }
      });
    }
  }

  // ----------------------------------------------------------- services

  /**
   * Kick off every background service.  Each is fire-and-forget — failures are
   * routed through `log` and never prevent the app from starting.
   */
  private startServices(): void {
    // LSP language servers for the cwd.
    lspManager
      .startDetected(process.cwd())
      .catch((e) => this.log(`[lsp] startup error: ${e?.message ?? e}\n`));

    // First-run default approval rules.
    ensureApprovalConfig().catch((e) =>
      this.log(`[approval] init error: ${e?.message ?? e}\n`),
    );

    // Semantic code index (slow ONNX init).
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
          api: this.api,
          model: Array.isArray(this.model) ? this.model[0] : this.model,
        });
        await codeIndex.init();
        this.codeIndex = codeIndex;
        this.agent.tools.push(createSemanticSearchTool({ codeIndex }));
      })
      .catch((err) =>
        this.log(`[codeIndex] init error: ${err?.message ?? err}\n`),
      );

    // MCP servers.
    loadMcpConfig()
      .then(async (mcpConfig) => {
        await this.mcp.init(mcpConfig);
        if (!this.mcp.hasTools()) return;

        const autoEnabled = this.mcp.getAutoEnabledTools();
        for (const tool of autoEnabled) {
          this.agent.tools.push(this.mcp.createAgentTool(tool));
        }

        const enableable = this.mcp
          .getDiscoveredTools()
          .filter((t) => !this.mcp.isAutoEnabled(t.fullName));
        if (enableable.length > 0) {
          this.agent.tools.push(
            createEnableTool({
              manager: this.mcp,
              tools: this.agent.tools,
              exclude: new Set(autoEnabled.map((t) => t.fullName)),
            }),
          );
        }
      })
      .catch((err) =>
        this.log(`[mcp] initialization error: ${err?.message ?? err}\n`),
      );
  }

  // ----------------------------------------------------------- approval gate

  /**
   * Intercept every tool call and decide whether it may run.
   *
   * Decision tree (mirrors the prior inline CLI logic exactly):
   *  1. WRITE_TOOLS targeting a protected approval-config path → prompt human.
   *  2. Bash command matched by an auto-approve rule, not touching a protected
   *     path → approve.
   *  3. Bash command matched by an auto-reject rule, or touching a protected
   *     path → reject (with reason).
   *  4. Otherwise → ask the LLM classifier; approve/reject on its say-so,
   *     and prompt the human when it is unsure.
   *
   * Only the "prompt human" branch emits `tool-call-approval`; rejections emit
   * `tool-call-auto-rejected`.  Throws inside the approval listener propagate
   * and reject the tool call (see {@link Emitter.emit}).
   */
  private wireApprovalGate(): void {
    this.agent.on('tool-call', async (toolCall: ToolCall) => {
      const decision = await this.decideToolCall(toolCall);
      switch (decision.kind) {
        case 'approve':
          return;
        case 'reject':
          await this.emit('tool-call-auto-rejected', {
            toolCall,
            reason: decision.reason,
          });
          throw new Error(decision.reason);
        case 'prompt':
          await this.emit('tool-call-approval', {
            toolCall,
            detail: approvalDetail(toolCall),
          });
          return;
      }
    });
  }

  private async decideToolCall(toolCall: ToolCall): Promise<
    | { kind: 'approve' }
    | { kind: 'reject'; reason: string }
    | { kind: 'prompt' }
  > {
    // 1. File tools targeting protected approval-config paths always prompt.
    if (WRITE_TOOLS.has(toolCall.name)) {
      const paths = [
        toolCall.params?.path,
        toolCall.params?.oldPath,
        toolCall.params?.newPath,
      ].filter((p): p is string => typeof p === 'string');
      if (paths.some(isProtectedPath)) return { kind: 'prompt' };
    }

    const tool = this.agent.tools.find((t) => t.name === toolCall.name);

    // Tools that don't require approval run without intervention.
    if (!tool?.requiresApproval) {
      return { kind: 'approve' };
    }

    const command = toolCall.params?.command;

    // Non-bash tools that require approval (e.g. MCP tools) have no command
    // string to match against rules — go straight to interactive approval.
    if (typeof command !== 'string') {
      return { kind: 'prompt' };
    }

    let config;
    try {
      // Reload each time so edits to .matos/approval.json take effect live.
      config = await loadApprovalConfig();
    } catch {
      config = { approve: [], reject: [] };
    }

    const { decision, matched, rule } = decideApproval(command, config);
    if (decision === 'reject') {
      return {
        kind: 'reject',
        reason: `[REJECTED] Auto-reject rule "${rule}" matched "${matched}" in: ${command}`,
      };
    }

    // Auto-approve only when explicitly approved AND the command does not touch
    // the approval config (defense-in-depth for bash).
    if (decision === 'approve' && !mentionsProtectedPath(command)) {
      return { kind: 'approve' };
    }

    // Anything touching the approval config requires a human — the agent must
    // never rewrite its own safety rules unattended.
    if (!mentionsProtectedPath(command)) {
      // `decision === 'prompt'` → delegate to the LLM classifier so the user
      // rarely has to approve harmless commands manually.
      const llmDecision = await llmDecideApproval(
        { api: this.agent.api, model: this.agent.model },
        command,
      );
      if (llmDecision === 'approve') return { kind: 'approve' };
      if (llmDecision === 'reject') {
        return {
          kind: 'reject',
          reason: `[REJECTED] LLM classified command as dangerous: ${command}`,
        };
      }
      // llmDecision === 'prompt' → fall through to interactive approval
    }
    // command touches protected path, or LLM was unsure → prompt human.
    return { kind: 'prompt' };
  }

  // ----------------------------------------------------------- turn streaming

  /**
   * Send a user message and return the per-turn emitter for this run.
   *
   * Streaming events are forwarded onto this app instance via
   * {@link bridgeAgentEvents}, so `app.on('content', ...)` fires for every
   * turn.  The returned emitter is the handle for `abort()` / `toPromise()`:
   *
   * ```ts
   * const run = app.send('hello');
   * run.on('content', (chunk) => console.log(chunk));
   * await run.toPromise();   // → assistant Message
   * ```
   */
  send(text: string): Emitter<MessageEvents> {
    return this.agent.sendMessage({
      role: 'user',
      content: text,
      created: new Date(),
    });
  }

  // ----------------------------------------------------------- history

  async saveHistory(): Promise<void> {
    await saveHistory(this.agent);
  }

  async loadHistory(): Promise<{ loaded: boolean; messageCount: number }> {
    return loadHistory(this.agent);
  }

  async clearHistory(): Promise<void> {
    this.agent.messages = [];
    this.agent.readFiles.clear();
    await this.saveHistory();
  }

  // ----------------------------------------------------------- indexing

  /** Rebuild the semantic code index.  Emits `busy` around the run. */
  async indexProject(
    onProgress?: (msg: string) => void,
  ): Promise<IndexStats> {
    if (!this.codeIndex) throw new Error('Code search not initialized yet.');
    await this.emit('busy', true);
    try {
      return await this.codeIndex.indexProject(onProgress);
    } finally {
      await this.emit('busy', false);
    }
  }

  // ----------------------------------------------------------- shutdown

  /**
   * Tear down every background service with per-service timeouts so a stuck
   * shutdown cannot hang forever.  Safe to call multiple times.
   */
  async dispose(): Promise<void> {
    const withTimeout = <T>(p: Promise<T>, ms = 3000): Promise<unknown> =>
      Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

    try {
      await withTimeout(lspManager.shutdownAll());
    } catch (e: any) {
      this.log(`[lsp] shutdown error: ${e?.message ?? e}\n`);
    }

    try {
      await withTimeout(this.mcp.close());
    } catch (e: any) {
      this.log(`[mcp] shutdown error: ${e?.message ?? e}\n`);
    }

    if (this.codeIndex) {
      try {
        await withTimeout(this.codeIndex.dispose());
      } catch (e: any) {
        this.log(`[codeIndex] dispose error: ${e?.message ?? e}\n`);
      }
    }
  }
}

/**
 * Build the single-line summary shown for an interactive approval prompt:
 * bash commands show the command, other tools show their first param key.
 */
function approvalDetail(toolCall: ToolCall): string {
  const cmd = toolCall.params?.command;
  if (cmd) return `: ${cmd}`;
  if (Object.keys(toolCall.params ?? {}).length) {
    return ` with: ${JSON.stringify(toolCall.params).slice(0, 200)}`;
  }
  return '';
}

// Re-export shared types the UI commonly needs alongside the app.
export type { ToolCall } from '../lib/Agent.js';
