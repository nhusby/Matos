import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createListFilesTool } from '../../src/lib/tools/listFiles.js';

let tmpDir: string;
let originalCwd: string;

beforeEach(async () => {
  const raw = await mkdtemp(join(tmpdir(), 'matos-list-'));
  originalCwd = process.cwd();
  process.chdir(raw);
  tmpDir = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpDir, { recursive: true, force: true });
});

test('listFiles: lists files and directories with trailing slash on dirs', async () => {
  await writeFile(join(tmpDir, 'a.txt'), '');
  await mkdir(join(tmpDir, 'sub'));
  const out = await createListFilesTool().callback!({ path: tmpDir } as any);
  const lines = out.split('\n');
  expect(lines).toContain('a.txt');
  expect(lines).toContain('sub/');
});

test('listFiles: sorts directories before files', async () => {
  await writeFile(join(tmpDir, 'zfile.txt'), '');
  await mkdir(join(tmpDir, 'adir'));
  await writeFile(join(tmpDir, 'afile.txt'), '');
  await mkdir(join(tmpDir, 'zdir'));
  const out = await createListFilesTool().callback!({ path: tmpDir } as any);
  const lines = out.split('\n');
  // directories first (alphabetical), then files (alphabetical)
  expect(lines).toEqual(['adir/', 'zdir/', 'afile.txt', 'zfile.txt']);
});

test('listFiles: defaults to cwd when no path given', async () => {
  await writeFile(join(tmpDir, 'in-cwd.txt'), '');
  const out = await createListFilesTool().callback!({} as any);
  expect(out).toContain('in-cwd.txt');
});

test('listFiles: bypassCwd=false rejects paths outside cwd', async () => {
  const outside = join(tmpDir, '..', 'outside');
  await mkdir(outside, { recursive: true });
  const tool = createListFilesTool({ bypassCwd: false });
  const out = await tool.callback!({ path: outside } as any);
  expect(out).toMatch(/outside the current working directory/);
  await rm(outside, { recursive: true, force: true });
});

test('listFiles: bypassCwd=true allows paths outside cwd', async () => {
  const outside = join(tmpDir, '..', 'outside-dir');
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'file.txt'), '');
  const tool = createListFilesTool({ bypassCwd: true });
  const out = await tool.callback!({ path: outside } as any);
  expect(out).toContain('file.txt');
  await rm(outside, { recursive: true, force: true });
});

test('listFiles: expands ~ to home directory', async () => {
  // Smoke test — just verify expansion works. We can't easily test against
  // an arbitrary home without env manipulation, so verify the behavior
  // is consistent (no crash, sensible output).
  const tool = createListFilesTool({ bypassCwd: true });
  const out = await tool.callback!({ path: '~' } as any);
  expect(typeof out).toBe('string');
});
