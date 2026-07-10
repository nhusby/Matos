import { v7 } from 'uuid';
import { appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import type { Agent, Message } from './Agent.js';

const DEFAULT_LOG_DIR = resolve(homedir(), '.matos', 'logs');

export interface ConversationLoggerEntry {
  conversationId: string;
  role: string;
  name?: string;
  content: string;
  parts?: Record<string, unknown>[];
  created: string;
}

function serializePart(part: any): Record<string, unknown> {
  const out: Record<string, unknown> = { role: part.role };
  if (part.name !== undefined) out.name = part.name;
  if (part.content) out.content = part.content;
  if (part.reasoningContent) out.reasoningContent = part.reasoningContent;
  if (part.toolCallId !== undefined) out.toolCallId = part.toolCallId;
  if (part.params !== undefined) out.params = part.params;
  if (part.toolCalls) {
    out.toolCalls = part.toolCalls.map((tc: any) => ({
      id: tc.id,
      name: tc.name,
      params: tc.params,
    }));
  }
  return out;
}

/**
 * Appends each message in a conversation as a JSON line to
 * `~/.matos/logs/<uuid>.jsonl` (or `logDir/<uuid>.jsonl` if overridden).
 * Each conversation instance is assigned a unique UUID automatically.
 */
export class ConversationLogger {
  readonly conversationId: string;
  private readonly logFile: string;

  constructor(logDir: string = DEFAULT_LOG_DIR) {
    this.conversationId = v7();
    mkdirSync(logDir, { recursive: true });
    this.logFile = resolve(logDir, `${this.conversationId}.jsonl`);
  }

  /** Returns the path to the JSONL log file for this conversation. */
  get filePath(): string {
    return this.logFile;
  }

  /** Append a single message as a JSON line to the log file. */
  log(message: Message): void {
    const entry: ConversationLoggerEntry = {
      conversationId: this.conversationId,
      role: message.role,
      content: typeof message.content === 'string' ? message.content : '',
      created:
        message.created instanceof Date
          ? message.created.toISOString()
          : new Date().toISOString(),
    };
    if (message.name !== undefined) entry.name = message.name;
    if (message.parts?.length) {
      entry.parts = message.parts.map(serializePart);
    }

    try {
      appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
    } catch (e) {
      // Logging is best-effort — never crash the agent
      process.stderr.write(
        `[conversation-log write failed: ${e instanceof Error ? e.message : e}]\n`,
      );
    }
  }

  /**
   * Attach the logger to an agent so that every user message
   * (`send-message`) and completed assistant response (`end`)
   * is automatically logged.
   */
  attach(agent: Agent): this {
    agent.on('send-message', (message: Message) => {
      this.log(message);
    });
    agent.on('end', (message: Message) => {
      this.log(message);
    });
    return this;
  }
}
