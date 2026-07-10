import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildFileTree } from '../../lib/tools/fileTree';

let tmpDir: string;
let originalCwd: string;

beforeEach(async () => {
  const raw = await mkdtemp(join(tmpdir(), 'matos-tree-'));
  originalCwd = process.cwd();
  process.chdir(raw);
  tmpDir = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpDir, { recursive: true, force: true });
});

test('buildFileTree: lists nested files with indentation', async () => {
  await writeFile(join(tmpDir, 'root.txt'), '');
  await mkdir(join(tmpDir, 'sub'));
  await writeFile(join(tmpDir, 'sub', 'child.txt'), '');
  const out = await buildFileTree(tmpDir);
  expect(out).toContain('- root.txt');
  expect(out).toContain('- sub/');
  expect(out).toContain('  - child.txt');
});

test('buildFileTree: appends exports for TS files', async () => {
  await writeFile(
    join(tmpDir, 'm.ts'),
    'export function foo() {}\nexport const x = 1;\n',
  );
  const out = await buildFileTree(tmpDir);
  expect(out).toContain('- m.ts - exports: foo, x');
});

test('buildFileTree: appends exports for Go files', async () => {
  await writeFile(join(tmpDir, 'main.go'), 'package main\nfunc Hello() {}\n');
  const out = await buildFileTree(tmpDir);
  expect(out).toContain('- main.go - exports: Hello');
});

test('buildFileTree: appends exports for Python files', async () => {
  await writeFile(join(tmpDir, 'app.py'), 'def top(): pass\nclass C: pass\n');
  const out = await buildFileTree(tmpDir);
  // both top-level defs should appear
  expect(out).toMatch(/- app\.py - exports:.*C/);
  expect(out).toMatch(/- app\.py - exports:.*top/);
});

test('buildFileTree: respects .gitignore', async () => {
  await writeFile(join(tmpDir, 'kept.txt'), '');
  await writeFile(join(tmpDir, 'ignored.txt'), '');
  await writeFile(join(tmpDir, '.gitignore'), 'ignored.txt\n');
  const out = await buildFileTree(tmpDir);
  expect(out).toContain('kept.txt');
  expect(out).not.toContain('ignored.txt');
});

test('buildFileTree: respects .aiignore', async () => {
  await writeFile(join(tmpDir, 'kept.txt'), '');
  await writeFile(join(tmpDir, 'skipped.txt'), '');
  await writeFile(join(tmpDir, '.aiignore'), 'skipped.txt\n');
  const out = await buildFileTree(tmpDir);
  expect(out).toContain('kept.txt');
  expect(out).not.toContain('skipped.txt');
});

test('buildFileTree: skips dotfiles and dot-directories', async () => {
  await writeFile(join(tmpDir, 'visible.txt'), '');
  await writeFile(join(tmpDir, '.hidden'), '');
  await mkdir(join(tmpDir, '.secret'));
  await writeFile(join(tmpDir, '.secret', 'inside.txt'), '');
  const out = await buildFileTree(tmpDir);
  expect(out).toContain('visible.txt');
  expect(out).not.toContain('.hidden');
  expect(out).not.toContain('.secret');
  expect(out).not.toContain('inside.txt');
});

test('buildFileTree: defaults to cwd when no root given', async () => {
  await writeFile(join(tmpDir, 'in-cwd.txt'), '');
  const out = await buildFileTree();
  expect(out).toContain('in-cwd.txt');
});

test('buildFileTree: puts directories before files at each level', async () => {
  await writeFile(join(tmpDir, 'zfile.txt'), '');
  await mkdir(join(tmpDir, 'adir'));
  const out = await buildFileTree(tmpDir);
  const lines = out.split('\n').filter((l) => l.startsWith('- '));
  expect(lines[0]).toBe('- adir/');
  expect(lines[1]).toBe('- zfile.txt');
});
