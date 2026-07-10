import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConversationLogger } from '../../lib/ConversationLogger';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'matos-logger-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test('ConversationLogger: writes a JSONL line per log() call', async () => {
  const logger = new ConversationLogger(tmpDir);
  logger.log({
    role: 'user',
    content: 'hello',
    created: new Date('2025-01-01T00:00:00Z'),
  } as any);

  const contents = await readFile(logger.filePath, 'utf-8');
  const line = JSON.parse(contents.trim());
  expect(line.conversationId).toBe(logger.conversationId);
  expect(line.role).toBe('user');
  expect(line.content).toBe('hello');
  expect(line.created).toBe('2025-01-01T00:00:00.000Z');
});

test('ConversationLogger: appends multiple messages to the same file', async () => {
  const logger = new ConversationLogger(tmpDir);
  logger.log({ role: 'user', content: 'first', created: new Date() } as any);
  logger.log({
    role: 'assistant',
    content: 'second',
    created: new Date(),
  } as any);

  const lines = (await readFile(logger.filePath, 'utf-8'))
    .split('\n')
    .filter(Boolean);
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0]!).content).toBe('first');
  expect(JSON.parse(lines[1]!).content).toBe('second');
});

test('ConversationLogger: each instance gets a unique conversationId and file', async () => {
  const a = new ConversationLogger(tmpDir);
  const b = new ConversationLogger(tmpDir);
  expect(a.conversationId).not.toBe(b.conversationId);
  expect(a.filePath).not.toBe(b.filePath);

  // Files are only created on first log() — verify two distinct files appear after logging.
  a.log({ role: 'user', content: 'a', created: new Date() } as any);
  b.log({ role: 'user', content: 'b', created: new Date() } as any);
  const files = await readdir(tmpDir);
  expect(files).toHaveLength(2);
});

test('ConversationLogger: serializes parts with tool calls', async () => {
  const logger = new ConversationLogger(tmpDir);
  logger.log({
    role: 'assistant',
    content: 'calling tool',
    parts: [
      {
        role: 'assistant',
        content: 'let me check',
        toolCalls: [{ id: 'call_1', name: 'ReadFile', params: { path: '/x' } }],
      },
      {
        role: 'tool',
        name: 'ReadFile',
        content: 'result',
        toolCallId: 'call_1',
      },
    ],
    created: new Date(),
  } as any);

  const line = JSON.parse((await readFile(logger.filePath, 'utf-8')).trim());
  expect(line.parts).toHaveLength(2);
  expect(line.parts[0].toolCalls[0].name).toBe('ReadFile');
  expect(line.parts[1].role).toBe('tool');
});

test('ConversationLogger: handles non-string content (defaults to empty)', async () => {
  const logger = new ConversationLogger(tmpDir);
  logger.log({
    role: 'user',
    content: null,
    created: new Date(),
  } as any);
  const line = JSON.parse((await readFile(logger.filePath, 'utf-8')).trim());
  expect(line.content).toBe('');
});

test('ConversationLogger: filePath is inside the configured dir', () => {
  const logger = new ConversationLogger(tmpDir);
  expect(logger.filePath.startsWith(tmpDir)).toBe(true);
  expect(logger.filePath.endsWith('.jsonl')).toBe(true);
});
