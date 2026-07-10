import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { deleteFileTool } from '../../src/lib/tools/deleteFile.js';

let tmpDir: string;
let originalCwd: string;

beforeEach(async () => {
  const raw = await mkdtemp(join(tmpdir(), 'matos-deletefile-'));
  originalCwd = process.cwd();
  process.chdir(raw);
  tmpDir = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpDir, { recursive: true, force: true });
});

test('deleteFile: removes the file and reports success', async () => {
  const path = join(tmpDir, 'a.txt');
  await writeFile(path, 'hello');
  const out = await deleteFileTool.callback!({ path } as any);
  expect(out).toBe('Successfully deleted a.txt');
  expect(await Bun.file(path).exists()).toBe(false);
});

test('deleteFile: errors when file does not exist', async () => {
  const out = await deleteFileTool.callback!({
    path: join(tmpDir, 'nope.txt'),
  } as any);
  expect(out).toMatch(/^Error: .*does not exist/);
});

test('deleteFile: errors when path is a directory', async () => {
  await mkdir(join(tmpDir, 'subdir'));
  const out = await deleteFileTool.callback!({
    path: join(tmpDir, 'subdir'),
  } as any);
  expect(out).toMatch(/is a directory/);
});

test('deleteFile: errors when path is outside cwd', async () => {
  const outside = join(tmpDir, '..', 'outside.txt');
  await writeFile(outside, 'x');
  const out = await deleteFileTool.callback!({ path: outside } as any);
  expect(out).toMatch(/outside the current working directory/);
  await rm(outside, { force: true });
});

test('deleteFile: includes importer list when other TS files import the deleted file', async () => {
  const targetPath = join(tmpDir, 'target.ts');
  await writeFile(targetPath, 'export const thing = 1;\n');
  await writeFile(
    join(tmpDir, 'importer.ts'),
    `import { thing } from './target';\n`,
  );

  const out = await deleteFileTool.callback!({ path: targetPath } as any);
  expect(out).toContain('Successfully deleted target.ts');
  expect(out).toContain('importer.ts');
});
