import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { renameFileTool } from '../../src/lib/tools/renameFile.js';

let tmpDir: string;
let originalCwd: string;

beforeEach(async () => {
  const raw = await mkdtemp(join(tmpdir(), 'matos-renamefile-'));
  originalCwd = process.cwd();
  process.chdir(raw);
  tmpDir = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpDir, { recursive: true, force: true });
});

test('renameFile: renames a file and reports relative paths', async () => {
  const oldPath = join(tmpDir, 'old.txt');
  const newPath = join(tmpDir, 'new.txt');
  await writeFile(oldPath, 'content');

  const out = await renameFileTool.callback!({ oldPath, newPath } as any);
  expect(out).toBe('Successfully renamed old.txt -> new.txt');
  expect(await Bun.file(oldPath).exists()).toBe(false);
  expect(await Bun.file(newPath).exists()).toBe(true);
});

test('renameFile: errors when source does not exist', async () => {
  const out = await renameFileTool.callback!({
    oldPath: join(tmpDir, 'nope.txt'),
    newPath: join(tmpDir, 'new.txt'),
  } as any);
  expect(out).toMatch(/does not exist/);
});

test('renameFile: errors when source is a directory', async () => {
  await mkdir(join(tmpDir, 'srcdir'));
  const out = await renameFileTool.callback!({
    oldPath: join(tmpDir, 'srcdir'),
    newPath: join(tmpDir, 'target.txt'),
  } as any);
  expect(out).toMatch(/is a directory/);
});

test('renameFile: errors when destination already exists', async () => {
  await writeFile(join(tmpDir, 'a.txt'), 'a');
  await writeFile(join(tmpDir, 'b.txt'), 'b');
  const out = await renameFileTool.callback!({
    oldPath: join(tmpDir, 'a.txt'),
    newPath: join(tmpDir, 'b.txt'),
  } as any);
  expect(out).toMatch(/already exists/);
});

test('renameFile: errors when old path is outside cwd', async () => {
  const outside = join(tmpDir, '..', 'outside.txt');
  await writeFile(outside, 'x');
  const out = await renameFileTool.callback!({
    oldPath: outside,
    newPath: join(tmpDir, 'inside.txt'),
  } as any);
  expect(out).toMatch(/old path is outside/);
  await rm(outside, { force: true });
});

test('renameFile: errors when new path is outside cwd', async () => {
  await writeFile(join(tmpDir, 'inside.txt'), 'x');
  const out = await renameFileTool.callback!({
    oldPath: join(tmpDir, 'inside.txt'),
    newPath: join(tmpDir, '..', 'outside.txt'),
  } as any);
  expect(out).toMatch(/new path is outside/);
});

test('renameFile: includes importer list when TS files import the renamed file', async () => {
  const oldPath = join(tmpDir, 'target.ts');
  const newPath = join(tmpDir, 'renamed.ts');
  await writeFile(oldPath, 'export const thing = 1;\n');
  await writeFile(
    join(tmpDir, 'importer.ts'),
    `import { thing } from './target';\n`,
  );

  const out = await renameFileTool.callback!({ oldPath, newPath } as any);
  expect(out).toContain('Successfully renamed target.ts -> renamed.ts');
  expect(out).toContain('importer.ts');
});
