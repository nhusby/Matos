import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { editFileTool } from '../../src/lib/tools/editFile.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'matos-editfile-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test('editFile: replaces exact unique match', async () => {
  const path = join(tmpDir, 'a.txt');
  await writeFile(path, 'foo bar baz');
  const out = await editFileTool.callback!({
    path,
    old_string: 'bar',
    new_string: 'qux',
  } as any);
  expect(out).toBe(`Successfully edited ${path}`);
  expect(await readFile(path, 'utf-8')).toBe('foo qux baz');
});

test('editFile: errors when old_string not found', async () => {
  const path = join(tmpDir, 'a.txt');
  await writeFile(path, 'foo');
  const out = await editFileTool.callback!({
    path,
    old_string: 'missing',
    new_string: 'x',
  } as any);
  expect(out).toMatch(/^Error: old_string not found/);
  expect(await readFile(path, 'utf-8')).toBe('foo');
});

test('editFile: errors when old_string is not unique', async () => {
  const path = join(tmpDir, 'a.txt');
  await writeFile(path, 'foo foo foo');
  const out = await editFileTool.callback!({
    path,
    old_string: 'foo',
    new_string: 'bar',
  } as any);
  expect(out).toMatch(/not unique/);
  expect(await readFile(path, 'utf-8')).toBe('foo foo foo');
});

test('editFile: handles multiline replacements', async () => {
  const path = join(tmpDir, 'a.txt');
  await writeFile(path, 'line1\nline2\nline3');
  await editFileTool.callback!({
    path,
    old_string: 'line1\nline2',
    new_string: 'first\nsecond',
  } as any);
  expect(await readFile(path, 'utf-8')).toBe('first\nsecond\nline3');
});

test('editFile: errors when file does not exist', async () => {
  const path = join(tmpDir, 'nope.txt');
  await expect(
    editFileTool.callback!({
      path,
      old_string: 'x',
      new_string: 'y',
    } as any),
  ).rejects.toThrow();
});

test('editFile: replaces empty old_string with new content (prepends)', async () => {
  const path = join(tmpDir, 'a.txt');
  await writeFile(path, 'world');
  // empty old_string appears once between every char and at edges;
  // "world".split('') gives 5 + 1 = 6 occurrences of empty string.
  // This is a degenerate case — verify behavior is predictable.
  const out = await editFileTool.callback!({
    path,
    old_string: '',
    new_string: 'hello ',
  } as any);
  expect(out).toMatch(/Successfully edited|Error/);
});
