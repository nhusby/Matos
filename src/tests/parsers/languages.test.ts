import { test, expect } from 'bun:test';
import {
  languageForPath,
  isSupportedPath,
  SUPPORTED_EXTENSIONS,
} from '../../lib/parsers/languages';

test('languageForPath maps TypeScript extensions', () => {
  expect(languageForPath('foo.ts')).toBe('typescript');
  expect(languageForPath('foo.mts')).toBe('typescript');
  expect(languageForPath('foo.cts')).toBe('typescript');
  expect(languageForPath('foo.js')).toBe('typescript');
  expect(languageForPath('foo.mjs')).toBe('typescript');
  expect(languageForPath('foo.cjs')).toBe('typescript');
});

test('languageForPath maps TSX/JSX to tsx language', () => {
  expect(languageForPath('component.tsx')).toBe('tsx');
  expect(languageForPath('component.jsx')).toBe('tsx');
});

test('languageForPath maps Go', () => {
  expect(languageForPath('main.go')).toBe('go');
});

test('languageForPath maps Python', () => {
  expect(languageForPath('app.py')).toBe('python');
  expect(languageForPath('types.pyi')).toBe('python');
});

test('languageForPath maps Perl', () => {
  expect(languageForPath('lib.pl')).toBe('perl');
  expect(languageForPath('Mod.pm')).toBe('perl');
  expect(languageForPath('test.t')).toBe('perl');
});

test('languageForPath is case-insensitive on extensions', () => {
  expect(languageForPath('Foo.TS')).toBe('typescript');
  expect(languageForPath('Foo.GO')).toBe('go');
  expect(languageForPath('Foo.PY')).toBe('python');
});

test('languageForPath handles dotted filenames', () => {
  expect(languageForPath('foo.test.ts')).toBe('typescript');
  expect(languageForPath('foo.spec.tsx')).toBe('tsx');
  expect(languageForPath('my.app.go')).toBe('go');
});

test('languageForPath returns undefined for unsupported extensions', () => {
  expect(languageForPath('README.md')).toBeUndefined();
  expect(languageForPath('data.json')).toBeUndefined();
  expect(languageForPath('style.css')).toBeUndefined();
  expect(languageForPath('binary.exe')).toBeUndefined();
  expect(languageForPath('rust.rs')).toBeUndefined();
});

test('languageForPath returns undefined for files without extension', () => {
  expect(languageForPath('Makefile')).toBeUndefined();
  expect(languageForPath('Dockerfile')).toBeUndefined();
});

test('languageForPath handles absolute paths', () => {
  expect(languageForPath('/Users/foo/src/index.ts')).toBe('typescript');
  expect(languageForPath('/tmp/test.go')).toBe('go');
});

test('SUPPORTED_EXTENSIONS contains all expected extensions', () => {
  for (const ext of [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.go',
    '.py',
    '.pyi',
    '.pl',
    '.pm',
    '.t',
  ]) {
    expect(SUPPORTED_EXTENSIONS.has(ext)).toBe(true);
  }
});

test('isSupportedPath is true for supported, false otherwise', () => {
  expect(isSupportedPath('foo.ts')).toBe(true);
  expect(isSupportedPath('foo.go')).toBe(true);
  expect(isSupportedPath('foo.unknown')).toBe(false);
});
