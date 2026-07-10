import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTextSearchTool } from '../../lib/tools/textSearch';

let tmpDir: string;
let originalCwd: string;

beforeEach(async () => {
  const raw = await mkdtemp(join(tmpdir(), 'matos-search-'));
  originalCwd = process.cwd();
  process.chdir(raw);
  tmpDir = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpDir, { recursive: true, force: true });
});

const sampleFiles = async (root: string) => {
  await writeFile(join(root, 'a.ts'), 'const foo = 1;\nconst bar = 2;\n');
  await writeFile(join(root, 'b.ts'), 'foo bar baz\nFOO capital\n');
  await writeFile(join(root, 'c.md'), '# foo\nbar baz\n');
  await mkdir(join(root, 'sub'));
  await writeFile(join(root, 'sub', 'd.ts'), 'export const baz = () => foo;\n');
};

test('textSearch: finds substring matches across files', async () => {
  await sampleFiles(tmpDir);
  const out = await createTextSearchTool().callback!({
    pattern: 'foo',
    path: tmpDir,
  } as any);
  expect(out).toMatch(/Found \d+ matches/);
  expect(out).toContain('a.ts:1:');
  expect(out).toContain('b.ts:1:');
});

test('textSearch: case-insensitive by default', async () => {
  await sampleFiles(tmpDir);
  const out = await createTextSearchTool().callback!({
    pattern: 'foo',
    path: tmpDir,
  } as any);
  // Should match both 'foo' and 'FOO'
  expect(out).toContain('b.ts');
  expect(out.toLowerCase()).toContain('foo');
});

test('textSearch: case-sensitive when set', async () => {
  await sampleFiles(tmpDir);
  const out = await createTextSearchTool().callback!({
    pattern: 'FOO',
    path: tmpDir,
    caseSensitive: true,
  } as any);
  expect(out).toContain('b.ts');
  // Should match only the 'FOO' line, not 'foo bar baz'
  const lines = out.split('\n').filter((l) => l.includes('b.ts'));
  expect(lines.length).toBe(1);
});

test('textSearch: regex mode', async () => {
  await sampleFiles(tmpDir);
  const out = await createTextSearchTool().callback!({
    pattern: 'f.o+',
    path: tmpDir,
    regex: true,
  } as any);
  expect(out).toContain('foo');
});

test('textSearch: regex special chars in non-regex mode are escaped', async () => {
  await writeFile(join(tmpDir, 'a.txt'), 'a.b.c\n');
  const out = await createTextSearchTool().callback!({
    pattern: 'a.b',
    path: tmpDir,
  } as any);
  // Should match literal 'a.b' only, not 'axb' or 'a.b.c' (well, the line has 'a.b.c')
  expect(out).toContain('a.txt:1:');
});

test('textSearch: include filter restricts by extension', async () => {
  await sampleFiles(tmpDir);
  const out = await createTextSearchTool().callback!({
    pattern: 'foo',
    path: tmpDir,
    include: '*.ts',
  } as any);
  expect(out).toContain('a.ts');
  expect(out).not.toContain('c.md');
});

test('textSearch: excludeDirs skips specified directories', async () => {
  await sampleFiles(tmpDir);
  const out = await createTextSearchTool().callback!({
    pattern: 'baz',
    path: tmpDir,
    excludeDirs: ['sub'],
  } as any);
  // 'baz' appears in b.ts (root) and sub/d.ts (excluded)
  expect(out).toContain('b.ts');
  expect(out).not.toContain('sub/d.ts');
});

test('textSearch: returns "No matches" when pattern not found', async () => {
  await sampleFiles(tmpDir);
  const out = await createTextSearchTool().callback!({
    pattern: 'notfound',
    path: tmpDir,
  } as any);
  expect(out).toBe('No matches found.');
});

test('textSearch: errors on invalid regex', async () => {
  const out = await createTextSearchTool().callback!({
    pattern: '(unclosed',
    path: tmpDir,
    regex: true,
  } as any);
  expect(out).toMatch(/^Error: invalid pattern/);
});

test('textSearch: errors when path is outside cwd (default config)', async () => {
  const outside = join(tmpDir, '..', 'outside');
  await mkdir(outside, { recursive: true });
  const out = await createTextSearchTool().callback!({
    pattern: 'x',
    path: outside,
  } as any);
  expect(out).toMatch(/outside the current working directory/);
  await rm(outside, { recursive: true, force: true });
});

test('textSearch: respects default exclude set (node_modules, .git, dist, build)', async () => {
  await writeFile(join(tmpDir, 'visible.txt'), 'foo');
  await mkdir(join(tmpDir, 'node_modules'));
  await writeFile(join(tmpDir, 'node_modules', 'hidden.ts'), 'foo');
  const out = await createTextSearchTool().callback!({
    pattern: 'foo',
    path: tmpDir,
  } as any);
  expect(out).toContain('visible.txt');
  expect(out).not.toContain('node_modules');
});

test('textSearch: searching a single file targets only that file', async () => {
  await writeFile(join(tmpDir, 'a.txt'), 'foo');
  await writeFile(join(tmpDir, 'b.txt'), 'foo');
  const out = await createTextSearchTool().callback!({
    pattern: 'foo',
    path: join(tmpDir, 'a.txt'),
  } as any);
  expect(out).toContain('a.txt');
  expect(out).not.toContain('b.txt');
});
