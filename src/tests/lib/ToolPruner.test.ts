import { test, expect, describe } from 'bun:test';
import { pruneTools } from '../../lib/ToolPruner';
import type { Tool, Message } from '../../lib/Agent';
import { makeMessage, makeToolPart, makeAgentPart } from '../helpers';

/** MCP-style tool name (contains `__`) → expirable. */
const mcpTool = (name: string): Tool => ({
  name,
  description: `${name} tool`,
  callback: async () => 'ok',
});

/** Core-style tool name (no `__`) → never expires. */
const coreTool = (name: string): Tool => ({
  name,
  description: `${name} tool`,
  callback: async () => 'ok',
});

/**
 * Build a message list representing a conversation with the given sequence
 * of turns.  Each entry in `turns` is an array of tool names used in that
 * assistant turn (empty array = a content-only turn).
 */
function conversation(...turns: string[][]): Message[] {
  const messages: Message[] = [makeMessage('user', 'start')];
  for (let i = 0; i < turns.length; i++) {
    const usedTools = turns[i]!;
    const parts = usedTools.map((name, j) =>
      makeToolPart(name, `result-${i}-${j}`, `tc-${i}-${j}`),
    );
    messages.push({
      role: 'assistant',
      content: `turn ${i}`,
      parts: [makeAgentPart(`turn ${i}`, usedTools.map((name, j) => ({
        id: `tc-${i}-${j}`,
        name,
        params: {},
      }))), ...parts],
      created: new Date(),
    });
    if (i < turns.length - 1) {
      messages.push(makeMessage('user', `msg ${i + 1}`));
    }
  }
  return messages;
}

describe('pruneTools', () => {
  test('does not remove a newly-seen MCP tool on its enable turn', () => {
    const tools = [mcpTool('srv__temp')];
    expect(pruneTools(tools, conversation([]))).toEqual([]);
    expect(tools).toHaveLength(1);
  });

  test('removes a never-used MCP tool after 3 idle turns', () => {
    const tools = [mcpTool('srv__temp')];
    pruneTools(tools, conversation([])); // seed

    expect(pruneTools(tools, conversation([], []))).toEqual([]); // 2 idle
    expect(tools).toHaveLength(1);

    expect(pruneTools(tools, conversation([], [], []))).toEqual([]); // 2 idle
    expect(tools).toHaveLength(1);

    // Wait — let's count properly. Seed at turn 0. Then pass full history:
    // turns 0-3 = 3 idle → removed.
    const tools2 = [mcpTool('srv__temp')];
    pruneTools(tools2, conversation([])); // seed at turn 0
    expect(pruneTools(tools2, conversation([], [], [], []))).toEqual([
      'srv__temp',
    ]);
    expect(tools2).toHaveLength(0);
  });

  test('never removes core tools (no __ in name)', () => {
    const tools = [coreTool('ReadFile')];
    expect(pruneTools(tools, conversation([], [], [], [], []))).toEqual([]);
    expect(tools).toHaveLength(1);
  });

  test('using a tool resets the idle counter', () => {
    // Used on turn 0, idle turns 1-3 (3 idle since last use) → still < 3?

    // Seed, then use on turn 0, idle 1-2 = 2 idle → survives (< 3).
    const tools = [mcpTool('srv__temp')];
    pruneTools(tools, conversation([])); // seed at turn 0
    expect(
      pruneTools(tools, conversation(['srv__temp'], [], [])),
    ).toEqual([]);
    expect(tools).toHaveLength(1);

    // Same but 3 idle turns since last use → removed.
    const tools2 = [mcpTool('srv__temp')];
    pruneTools(tools2, conversation([])); // seed at turn 0
    expect(
      pruneTools(tools2, conversation(['srv__temp'], [], [], [])),
    ).toEqual(['srv__temp']);
  });

  test('removes a tool that was used but then went idle long enough', () => {
    // Seed, then use on turn 0, idle turns 1-2-3 = 3 idle (≥ 3) → removed.
    const tools = [mcpTool('srv__temp')];
    pruneTools(tools, conversation([])); // seed at turn 0
    expect(
      pruneTools(tools, conversation(['srv__temp'], [], [], [])),
    ).toEqual(['srv__temp']);
    expect(tools).toHaveLength(0);
  });

  test('a tool used in the most recent turn is never removed', () => {
    const tools = [mcpTool('srv__temp')];
    pruneTools(tools, conversation([])); // seed
    expect(
      pruneTools(tools, conversation([], [], ['srv__temp'])),
    ).toEqual([]);
    expect(tools).toHaveLength(1);
  });

  test('handles multiple MCP tools independently', () => {
    const tools = [mcpTool('a__one'), mcpTool('b__two')];
    pruneTools(tools, conversation([])); // seed both at turn 0

    // 3 idle turns: both expire.
    const removed = pruneTools(tools, conversation([], [], [], []));
    expect(removed.sort()).toEqual(['a__one', 'b__two']);
    expect(tools).toHaveLength(0);
  });

  test('a previously-removed tool re-enabled later gets a fresh budget', () => {
    // Seed, then 3 idle turns → removed.
    let tools = [mcpTool('srv__temp')];
    pruneTools(tools, conversation([]));
    expect(
      pruneTools(tools, conversation([], [], [], [])),
    ).toEqual(['srv__temp']);
    expect(tools).toHaveLength(0);

    // Re-enable with a fresh tool object (same name).
    tools = [mcpTool('srv__temp')];
    pruneTools(tools, conversation([])); // fresh seed
    expect(tools).toHaveLength(1);
    // 3 idle turns → removed again.
    expect(
      pruneTools(tools, conversation([], [], [], [])),
    ).toEqual(['srv__temp']);
  });

  test('mix of core and MCP tools: only MCP tools expire', () => {
    const tools = [coreTool('ReadFile'), mcpTool('srv__temp')];
    pruneTools(tools, conversation([])); // seed
    expect(
      pruneTools(tools, conversation([], [], [], [])),
    ).toEqual(['srv__temp']);
    expect(tools.map((t) => t.name)).toEqual(['ReadFile']);
  });
});
