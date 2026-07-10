import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { findImporters } from '../../src/lib/tools/findImporters.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'matos-importers-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test('findImporters: finds TS files that import a target by stem', async () => {
  const targetPath = join(tmpDir, 'target.ts');
  await writeFile(targetPath, 'export const thing = 1;');
  await writeFile(
    join(tmpDir, 'a.ts'),
    `import { thing } from './target';`,
  );
  await writeFile(
    join(tmpDir, 'b.ts'),
    `import { thing } from './target';`,
  );
  await writeFile(
    join(tmpDir, 'unrelated.ts'),
    `import { other } from './other';`,
  );

  const importers = await findImporters(targetPath, tmpDir);
  expect(importers).toHaveLength(2);
  expect(importers.some((s) => s.startsWith('a.ts:'))).toBe(true);
  expect(importers.some((s) => s.startsWith('b.ts:'))).toBe(true);
  expect(importers.some((s) => s.startsWith('unrelated.ts:'))).toBe(false);
});

test('findImporters: skips node_modules and dot-directories', async () => {
  const targetPath = join(tmpDir, 'target.ts');
  await writeFile(targetPath, 'export const thing = 1;');

  await mkdir(join(tmpDir, 'node_modules'), { recursive: true });
  await writeFile(
    join(tmpDir, 'node_modules', 'pkg.ts'),
    `import { thing } from '../target';`,
  );

  await mkdir(join(tmpDir, '.cache'), { recursive: true });
  await writeFile(
    join(tmpDir, '.cache', 'cached.ts'),
    `import { thing } from '../target';`,
  );

  const importers = await findImporters(targetPath, tmpDir);
  expect(importers).toHaveLength(0);
});

test('findImporters: matches different file extension import paths', async () => {
  const targetPath = join(tmpDir, 'target.ts');
  await writeFile(targetPath, 'export const thing = 1;');
  // Even without extension, the stem 'target' should match
  await writeFile(
    join(tmpDir, 'c.ts'),
    `import { thing } from './target';`,
  );
  const importers = await findImporters(targetPath, tmpDir);
  expect(importers).toHaveLength(1);
});

test('findImporters: handles Go imports', async () => {
  const targetPath = join(tmpDir, 'target.go');
  await writeFile(targetPath, 'package target\n');
  // Go imports reference by package name, not file. Within a single
  // project we don't have inter-package imports in the same dir, so
  // we just verify no false positives across languages.
  await writeFile(
    join(tmpDir, 'main.go'),
    `package main\nimport "fmt"\n`,
  );
  const importers = await findImporters(targetPath, tmpDir);
  expect(importers).toHaveLength(0);
});

test('findImporters: returns empty when target file does not exist', async () => {
  const importers = await findImporters(join(tmpDir, 'nope.ts'), tmpDir);
  expect(importers).toEqual([]);
});

test('findImporters: returns empty for unsupported target extension', async () => {
  const targetPath = join(tmpDir, 'target.md');
  await writeFile(targetPath, '# readme');
  const importers = await findImporters(targetPath, tmpDir);
  expect(importers).toEqual([]);
});

test('findImporters: walks nested subdirectories', async () => {
  const targetPath = join(tmpDir, 'target.ts');
  await writeFile(targetPath, 'export const thing = 1;');

  await mkdir(join(tmpDir, 'sub', 'deep'), { recursive: true });
  await writeFile(
    join(tmpDir, 'sub', 'deep', 'importer.ts'),
    `import { thing } from '../../target';`,
  );

  const importers = await findImporters(targetPath, tmpDir);
  expect(importers).toHaveLength(1);
  expect(importers[0]).toContain('sub/deep/importer.ts');
});
