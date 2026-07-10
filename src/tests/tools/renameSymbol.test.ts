import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { renameSymbolTool } from '../../lib/tools/renameSymbol';

let tmpDir: string;
let originalCwd: string;

beforeEach(async () => {
  const raw = await mkdtemp(join(tmpdir(), 'matos-rename-'));
  originalCwd = process.cwd();
  process.chdir(raw);
  tmpDir = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpDir, { recursive: true, force: true });
});

test('renameSymbol: errors on unsupported file extension', async () => {
  const path = join(tmpDir, 'a.md');
  await writeFile(path, '# hello\n');
  const out = await renameSymbolTool.callback!({
    path,
    name: 'hello',
    newName: 'world',
  } as any);
  expect(out).toMatch(/^Error: Unsupported file type/);
});

test('renameSymbol: errors when LSP server not running for Go', async () => {
  const path = join(tmpDir, 'a.go');
  await writeFile(path, 'package main\nfunc foo() {}\n');
  const out = await renameSymbolTool.callback!({
    path,
    name: 'foo',
    newName: 'bar',
  } as any);
  expect(out).toMatch(/^Error:.*not running/);
});

test('renameSymbol: errors when occurrence not found', async () => {
  const path = join(tmpDir, 'a.ts');
  await writeFile(path, 'const x = 1;\n');
  const out = await renameSymbolTool.callback!({
    path,
    name: 'missing',
    newName: 'whatever',
  } as any);
  expect(out).toMatch(/Could not find occurrence/);
});

test('renameSymbol: renames a TS symbol across files', async () => {
  const target = join(tmpDir, 'a.ts');
  await writeFile(target, 'export const unique = 1;\n');
  const importer = join(tmpDir, 'b.ts');
  await writeFile(
    importer,
    `import { unique } from './a';\nconsole.log(unique);\n`,
  );

  const out = await renameSymbolTool.callback!({
    path: target,
    name: 'unique',
    newName: 'renamed',
  } as any);

  expect(out).toMatch(/^Renamed to "renamed"/);
  expect(out).toContain('2 file(s)');
  // Verify the rename actually applied
  expect(await readFile(target, 'utf-8')).toContain('renamed');
  expect(await readFile(importer, 'utf-8')).toContain('renamed');
  expect(await readFile(importer, 'utf-8')).not.toContain('unique');
});

test('renameSymbol: errors when symbol at occurrence has different name', async () => {
  const path = join(tmpDir, 'a.ts');
  await writeFile(path, 'const foo = 1;\n');
  // Look for "bar" but specify occurrence 1 — won't find it
  const out = await renameSymbolTool.callback!({
    path,
    name: 'bar',
    newName: 'baz',
  } as any);
  expect(out).toMatch(/Error/);
});
