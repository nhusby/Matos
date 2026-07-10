import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  pickRenameBackend,
  pickSignaturesBackend,
  applyRenameResult,
} from '../../lib/lsp/backends';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'matos-backends-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ============================================================
// pickRenameBackend
// ============================================================

test('pickRenameBackend: TS files return TS backend', () => {
  const tsBackend = pickRenameBackend(join(tmpDir, 'a.ts'));
  const tsxBackend = pickRenameBackend(join(tmpDir, 'a.tsx'));
  const jsBackend = pickRenameBackend(join(tmpDir, 'a.js'));
  const mjsBackend = pickRenameBackend(join(tmpDir, 'a.mjs'));
  // Same instance for all TS langs (cached)
  expect(tsBackend).toBe(tsxBackend);
  expect(tsBackend).toBe(jsBackend);
  expect(tsBackend).toBe(mjsBackend);
});

test('pickRenameBackend: Go/Python/Perl return LSP backend', () => {
  const goBackend = pickRenameBackend(join(tmpDir, 'a.go'));
  const pyBackend = pickRenameBackend(join(tmpDir, 'a.py'));
  // Different language → different instance (per-lang cache)
  expect(goBackend).not.toBe(pyBackend);
});

test('pickRenameBackend: LSP backend is cached per language', () => {
  const b1 = pickRenameBackend(join(tmpDir, 'a.go'));
  const b2 = pickRenameBackend(join(tmpDir, 'b.go'));
  expect(b1).toBe(b2);
});

test('pickRenameBackend: throws on unsupported extension', () => {
  expect(() => pickRenameBackend(join(tmpDir, 'a.md'))).toThrow(/Unsupported/);
  expect(() => pickRenameBackend(join(tmpDir, 'noext'))).toThrow(/Unsupported/);
});

test('pickRenameBackend: LSP backend returns unavailable error when no server running', async () => {
  const backend = pickRenameBackend(join(tmpDir, 'a.go'));
  await expect(
    backend.findEdits(join(tmpDir, 'a.go'), 1, 'foo', 'bar'),
  ).rejects.toThrow(/not running/);
});

// ============================================================
// pickSignaturesBackend
// ============================================================

test('pickSignaturesBackend: TS files return TS backend', () => {
  const tsBackend = pickSignaturesBackend(join(tmpDir, 'a.ts'));
  expect(tsBackend.available).toBe(true);
});

test('pickSignaturesBackend: non-TS returns LSP backend (unavailable without server)', () => {
  const goBackend = pickSignaturesBackend(join(tmpDir, 'a.go'));
  expect(goBackend.available).toBe(false);
});

test('pickSignaturesBackend: unsupported extension returns unavailable backend', async () => {
  const backend = pickSignaturesBackend(join(tmpDir, 'a.md'));
  expect(backend.available).toBe(false);
  const result = await backend.importedSignatures('a.md', [], new Set());
  expect(result.size).toBe(0);
});

// ============================================================
// applyRenameResult
// ============================================================

test('applyRenameResult: applies single edit', async () => {
  const filePath = join(tmpDir, 'a.ts');
  await writeFile(filePath, 'const foo = 1;');
  const summary = await applyRenameResult({
    byFile: new Map([[filePath, [{ start: 6, length: 3, newText: 'bar' }]]]),
  });
  expect(await readFile(filePath, 'utf-8')).toBe('const bar = 1;');
  expect(summary).toEqual([`1 occurrence(s) in ${filePath}`]);
});

test('applyRenameResult: applies multiple edits in same file (reverse order)', async () => {
  const filePath = join(tmpDir, 'a.ts');
  await writeFile(filePath, 'foo + foo + foo');
  await applyRenameResult({
    byFile: new Map([
      [
        filePath,
        [
          { start: 0, length: 3, newText: 'bar' },
          { start: 6, length: 3, newText: 'bar' },
          { start: 12, length: 3, newText: 'bar' },
        ],
      ],
    ]),
  });
  expect(await readFile(filePath, 'utf-8')).toBe('bar + bar + bar');
});

test('applyRenameResult: applies edits across multiple files', async () => {
  const f1 = join(tmpDir, 'a.ts');
  const f2 = join(tmpDir, 'b.ts');
  await writeFile(f1, 'foo');
  await writeFile(f2, 'foo foo');
  await applyRenameResult({
    byFile: new Map([
      [f1, [{ start: 0, length: 3, newText: 'bar' }]],
      [
        f2,
        [
          { start: 0, length: 3, newText: 'bar' },
          { start: 4, length: 3, newText: 'bar' },
        ],
      ],
    ]),
  });
  expect(await readFile(f1, 'utf-8')).toBe('bar');
  expect(await readFile(f2, 'utf-8')).toBe('bar bar');
});

test('applyRenameResult: empty result returns empty summary', async () => {
  const summary = await applyRenameResult({ byFile: new Map() });
  expect(summary).toEqual([]);
});

test('applyRenameResult: handles overlapping-safe edit ordering', async () => {
  const filePath = join(tmpDir, 'a.ts');
  await writeFile(filePath, 'abcdef');
  // Two non-overlapping edits at the start and middle.
  // Reverse-order application means later offsets are applied first.
  await applyRenameResult({
    byFile: new Map([
      [
        filePath,
        [
          { start: 0, length: 1, newText: 'X' },
          { start: 3, length: 1, newText: 'Y' },
        ],
      ],
    ]),
  });
  expect(await readFile(filePath, 'utf-8')).toBe('XbcYef');
});
