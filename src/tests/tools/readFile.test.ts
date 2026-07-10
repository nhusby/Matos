import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createReadFileTool } from '../../lib/tools/readFile';

let tmpDir: string;

const readFileTool = createReadFileTool({ bypassCwd: true });

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'matos-readfile-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test('readFile: returns file contents', async () => {
  const path = join(tmpDir, 'a.txt');
  await writeFile(path, 'hello world');
  expect(await readFileTool.callback!({ path } as any)).toBe('hello world');
});

test('readFile: returns empty string for empty file', async () => {
  const path = join(tmpDir, 'empty.txt');
  await writeFile(path, '');
  expect(await readFileTool.callback!({ path } as any)).toBe('');
});

test('readFile: reads multi-line content', async () => {
  const path = join(tmpDir, 'multi.txt');
  await writeFile(path, 'line1\nline2\nline3');
  expect(await readFileTool.callback!({ path } as any)).toBe(
    'line1\nline2\nline3',
  );
});

test('readFile: rejects when file does not exist', async () => {
  const path = join(tmpDir, 'nope.txt');
  await expect(readFileTool.callback!({ path } as any)).rejects.toThrow();
});

test('readFile: blocks paths outside cwd when bypassCwd is false', async () => {
  const restricted = createReadFileTool();
  const out = await restricted.callback!({ path: '/etc/hostname' } as any);
  expect(out).toBe('Error: path is outside the current working directory.');
});
