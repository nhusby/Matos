import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { saveHistory, loadHistory } from '../../src/lib/HistoryManager.js';
import type { Agent, Message } from '../../src/lib/Agent.js';

let tmpDir: string;
let originalCwd: string;

beforeEach(async () => {
  const raw = await mkdtemp(join(tmpdir(), 'matos-history-'));
  originalCwd = process.cwd();
  process.chdir(raw);
  tmpDir = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpDir, { recursive: true, force: true });
});

function makeMockAgent(messages: Message[] = [], readFiles: Set<string> = new Set()): Agent {
  return {
    messages,
    readFiles,
  } as unknown as Agent;
}

test('saveHistory: writes a snapshot with messages and readFiles', async () => {
  const created = new Date('2025-01-01T00:00:00Z');
  const agent = makeMockAgent([
    {
      role: 'user',
      content: 'hi',
      created,
    } as Message,
    {
      role: 'assistant',
      content: 'hello',
      created,
    } as Message,
  ], new Set(['/some/file.ts']));

  await saveHistory(agent);

  const { existsSync } = await import('fs');
  expect(existsSync('.doofy/history.json')).toBe(true);
});

test('loadHistory: returns loaded=false when no history file exists', async () => {
  const agent = makeMockAgent();
  const result = await loadHistory(agent);
  expect(result.loaded).toBe(false);
  expect(result.messageCount).toBe(0);
});

test('loadHistory: restores messages and readFiles after save', async () => {
  const created = new Date('2025-01-01T00:00:00Z');
  const original = makeMockAgent(
    [
      { role: 'user', content: 'first', created } as Message,
      { role: 'assistant', content: 'second', created } as Message,
    ],
    new Set(['/a.ts', '/b.ts']),
  );
  await saveHistory(original);

  // Wipe the agent and reload
  const restored = makeMockAgent();
  const result = await loadHistory(restored);

  expect(result.loaded).toBe(true);
  expect(result.messageCount).toBe(2);
  expect(restored.messages[0].content).toBe('first');
  expect(restored.messages[1].content).toBe('second');
  expect([...restored.readFiles].sort()).toEqual(['/a.ts', '/b.ts']);
});

test('loadHistory: preserves Date type for created field', async () => {
  const created = new Date('2025-06-15T12:30:00Z');
  const agent = makeMockAgent([
    { role: 'user', content: 'x', created } as Message,
  ]);
  await saveHistory(agent);

  const restored = makeMockAgent();
  await loadHistory(restored);
  expect(restored.messages[0].created).toBeInstanceOf(Date);
  expect((restored.messages[0].created as Date).toISOString()).toBe(
    '2025-06-15T12:30:00.000Z',
  );
});

test('loadHistory: handles corrupted history file gracefully', async () => {
  const { writeFileSync, mkdirSync } = await import('fs');
  mkdirSync('.doofy', { recursive: true });
  writeFileSync('.doofy/history.json', '{ corrupted json');

  const agent = makeMockAgent();
  const result = await loadHistory(agent);
  expect(result.loaded).toBe(false);
  expect(agent.messages).toEqual([]);
});

test('loadHistory: handles empty messages array', async () => {
  const agent = makeMockAgent([]);
  await saveHistory(agent);

  const restored = makeMockAgent();
  const result = await loadHistory(restored);
  expect(result.loaded).toBe(true);
  expect(result.messageCount).toBe(0);
});
