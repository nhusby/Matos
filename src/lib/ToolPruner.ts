import type { Tool, Message } from './Agent.js';

/** Inactivity TTL for MCP tools (turns). */
const TTL = 3;

/**
 * Remove MCP tools whose inactivity budget has elapsed.
 *
 * An MCP tool is identified by the `serverName__toolName` naming convention
 * (always contains `__`).  Core tools never match and are always kept.
 *
 * Tool usage is derived entirely from the message history — no internal Agent
 * state is required.  A tool's "reference turn" is the more recent of:
 *
 * - The last assistant turn containing a tool-result for that tool (a use
 *   naturally resets the countdown).
 * - The turn on which the tool was first observed by this function (the
 *   enable turn — not counted as inactivity).
 *
 * The tool is removed once `TTL` turns have elapsed with no invocation.
 * Mutates `tools` in place and returns the names of removed tools.
 */
export function pruneTools(tools: Tool[], messages: Message[]): string[] {
  const removed: string[] = [];

  // Index every assistant message to a turn number.
  const turnIndexOf = new Map<Message, number>();
  let turnIdx = 0;
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      turnIndexOf.set(msg, turnIdx++);
    }
  }
  const lastTurn = turnIdx - 1;

  // For each tool, find the most recent turn it was invoked.
  const lastUsedTurn = new Map<string, number>();
  for (const [msg, idx] of turnIndexOf) {
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      if (part.role === 'tool') {
        lastUsedTurn.set(part.name, idx); // later turns overwrite → most recent
      }
    }
  }

  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i];
    if (!tool.name.includes('__')) continue;

    // Seed enable turn for newly-seen tools.
    const enableTurn = enableTurns.get(tool) ?? lastTurn;
    enableTurns.set(tool, enableTurn);

    // Reference turn = last use, or enable turn if never used.
    const referenceTurn = lastUsedTurn.get(tool.name) ?? enableTurn;
    const idleTurns = lastTurn - referenceTurn;

    if (idleTurns >= TTL) {
      tools.splice(i, 1);
      enableTurns.delete(tool);
      removed.push(tool.name);
    }
  }

  return removed;
}

/** Per-tool tracking of the turn on which it was first seen by the pruner. */
const enableTurns = new WeakMap<Tool, number>();
