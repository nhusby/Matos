import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileTool } from '../../src/lib/tools/writeFile.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'matos-writefile-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test('writeFile: creates a new file with the given content', async () => {
  const path = join(tmpDir, 'new.txt');
  const out = await writeFileTool.callback!({ path, content: 'hello' } as any);
  expect(out).toBe(`Successfully wrote to ${path}`);
  expect(await readFile(path, 'utf-8')).toBe('hello');
});

test('writeFile: overwrites an existing file', async () => {
  const path = join(tmpDir, 'existing.txt');
  await writeFile(path, 'old');
  await writeFileTool.callback!({ path, content: 'new' } as any);
  expect(await readFile(path, 'utf-8')).toBe('new');
});

test('writeFile: writes empty content', async () => {
  const path = join(tmpDir, 'empty.txt');
  await writeFileTool.callback!({ path, content: '' } as any);
  expect(await readFile(path, 'utf-8')).toBe('');
});

test('writeFile: writes multi-line content', async () => {
  const path = join(tmpDir, 'multi.txt');
  const content = 'a\nb\nc';
  await writeFileTool.callback!({ path, content } as any);
  expect(await readFile(path, 'utf-8')).toBe(content);
});

test('writeFile: creates nested directories if needed (does NOT — must pre-create)', async () => {
  const path = join(tmpDir, 'sub', 'file.txt');
  // writeFile from fs/promises won't create parent dirs by default.
  // If this expectation is wrong, update the test.
  await expect(writeFileTool.callback!({ path, content: 'x' } as any)).rejects.toThrow();
});
