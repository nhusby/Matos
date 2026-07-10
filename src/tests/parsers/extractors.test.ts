import { test, expect } from 'bun:test';
import {
  extractExports,
  extractSymbols,
  scanImports,
  extractExtends,
  findNthIdentifier,
} from '../../lib/parsers/extractors';

// ============================================================
// extractExports
// ============================================================

test('extractExports: TS named exports', () => {
  const code = `
export function foo() {}
export class Bar {}
export interface IBaz {}
export type Qux = string;
export enum Quux {}
export const x = 1;
`;
  const names = extractExports('m.ts', code)
    .map((e) => e.name)
    .sort();
  expect(names).toEqual(['Bar', 'IBaz', 'Quux', 'Qux', 'foo', 'x']);
});

test('extractExports: TS re-exports', () => {
  const code = `export { foo, bar } from './other';`;
  const names = extractExports('m.ts', code)
    .map((e) => e.name)
    .sort();
  expect(names).toEqual(['bar', 'foo']);
});

test('extractExports: TS files without exports return empty', () => {
  const code = `function helper() {} const x = 1;`;
  expect(extractExports('m.ts', code)).toEqual([]);
});

test('extractExports: Go top-level declarations', () => {
  const code = `package main
func Hello() {}
type World struct {}
type IThing interface {}
var Global = 1
const Pi = 3.14`;
  const names = extractExports('main.go', code)
    .map((e) => e.name)
    .sort();
  expect(names).toEqual(['Global', 'Hello', 'IThing', 'Pi', 'World']);
});

test('extractExports: Python top-level functions and classes', () => {
  const code = `
def top_level():
    pass

class Cls:
    def method(self):
        pass

    def other(self):
        pass

PRIVATE_VAL = 1
`;
  const names = extractExports('m.py', code)
    .map((e) => e.name)
    .sort();
  expect(names).toEqual(['Cls', 'PRIVATE_VAL', 'top_level']);
});

test('extractExports: Python methods are NOT exports', () => {
  const code = `
class C:
    def m1(self): pass
    def m2(self): pass
`;
  expect(extractExports('m.py', code).map((e) => e.name)).toEqual(['C']);
});

test('extractExports: TSX exports work via TS query bundle', () => {
  const code = `
export function Foo() { return <div/>; }
export const Bar = () => <span/>;
`;
  const names = extractExports('c.tsx', code)
    .map((e) => e.name)
    .sort();
  expect(names).toEqual(['Bar', 'Foo']);
});

test('extractExports: unsupported extension returns empty', () => {
  expect(extractExports('readme.md', 'whatever')).toEqual([]);
  expect(extractExports('no_ext', 'whatever')).toEqual([]);
});

test('extractExports: empty content returns empty', () => {
  expect(extractExports('m.ts', '')).toEqual([]);
});

// ============================================================
// extractSymbols
// ============================================================

test('extractSymbols: TS function declarations', () => {
  const code = `function foo() {} function bar() {}`;
  const syms = extractSymbols('m.ts', code);
  expect(syms).toHaveLength(2);
  expect(syms[0]).toMatchObject({ kind: 'function', name: 'foo' });
  expect(syms[1]).toMatchObject({ kind: 'function', name: 'bar' });
});

test('extractSymbols: TS class with methods', () => {
  const code = `
class Foo {
  method1() {}
  method2() {}
}
`;
  const syms = extractSymbols('m.ts', code);
  const kinds = syms.map((s) => `${s.kind}:${s.name}`);
  expect(kinds).toEqual(['class:Foo', 'method:method1', 'method:method2']);
  expect(syms[1].className).toBe('Foo');
  expect(syms[2].className).toBe('Foo');
});

test('extractSymbols: TS arrow-function exports are functions', () => {
  const code = `export const handler = () => {};`;
  const syms = extractSymbols('m.ts', code);
  expect(syms).toHaveLength(1);
  expect(syms[0].kind).toBe('function');
  expect(syms[0].name).toBe('handler');
});

test('extractSymbols: TS line numbers are 1-based', () => {
  const code = `\n\nfunction foo() {}\n`;
  const syms = extractSymbols('m.ts', code);
  expect(syms[0].startLine).toBe(3);
  expect(syms[0].endLine).toBe(3);
});

test('extractSymbols: Go functions, structs, interfaces, methods', () => {
  const code = `package main
func Foo() {}
type Bar struct{}
type IThing interface{}
func (b Bar) Method() {}
`;
  const syms = extractSymbols('main.go', code);
  const kinds = syms.map((s) => `${s.kind}:${s.name}`);
  expect(kinds).toEqual([
    'function:Foo',
    'class:Bar',
    'class:IThing',
    'method:Method',
  ]);
});

test('extractSymbols: Go struct is classified as class not function', () => {
  const code = `package main\ntype S struct{}`;
  const syms = extractSymbols('main.go', code);
  expect(syms[0].kind).toBe('class');
});

test('extractSymbols: Python functions inside classes are methods', () => {
  const code = `
class C:
    def method(self): pass
def standalone(): pass
`;
  const syms = extractSymbols('m.py', code);
  const method = syms.find((s) => s.name === 'method');
  const standalone = syms.find((s) => s.name === 'standalone');
  expect(method?.kind).toBe('method');
  expect(method?.className).toBe('C');
  expect(standalone?.kind).toBe('function');
  expect(standalone?.className).toBeUndefined();
});

test('extractSymbols: sourceText contains the full declaration', () => {
  const code = `function foo() { return 42; }`;
  const syms = extractSymbols('m.ts', code);
  expect(syms[0].sourceText).toBe('function foo() { return 42; }');
});

test('extractSymbols: unsupported extension returns empty', () => {
  expect(extractSymbols('m.unknown', 'code')).toEqual([]);
});

// ============================================================
// scanImports
// ============================================================

test('scanImports: TS named imports', () => {
  const code = `import { foo, bar } from './lib';`;
  const imports = scanImports('m.ts', code);
  expect(imports).toHaveLength(1);
  expect(imports[0].source).toBe('./lib');
  expect(imports[0].symbols).toEqual(['foo', 'bar']);
});

test('scanImports: TS namespace imports', () => {
  const code = `import * as lib from './lib';`;
  const imports = scanImports('m.ts', code);
  expect(imports[0].source).toBe('./lib');
  expect(imports[0].symbols).toEqual(['lib']);
});

test('scanImports: TS default imports', () => {
  const code = `import def from './lib';`;
  const imports = scanImports('m.ts', code);
  expect(imports[0].source).toBe('./lib');
  expect(imports[0].symbols).toEqual(['def']);
});

test('scanImports: TS mixed default + named', () => {
  const code = `import def, { a, b } from './lib';`;
  const imports = scanImports('m.ts', code);
  expect(imports[0].symbols).toEqual(['def', 'a', 'b']);
});

test('scanImports: TS multiple import statements', () => {
  const code = `
import { a } from './one';
import { b } from './two';
`;
  const imports = scanImports('m.ts', code);
  expect(imports).toHaveLength(2);
  expect(imports[0].source).toBe('./one');
  expect(imports[1].source).toBe('./two');
});

test('scanImports: Go single import', () => {
  const code = `package main
import "fmt"
`;
  const imports = scanImports('main.go', code);
  expect(imports).toHaveLength(1);
  expect(imports[0].source).toBe('fmt');
  expect(imports[0].symbols).toEqual([]);
});

test('scanImports: Go grouped imports', () => {
  const code = `package main
import (
  "fmt"
  "strings"
)
`;
  const imports = scanImports('main.go', code);
  expect(imports).toHaveLength(2);
  expect(imports[0].source).toBe('fmt');
  expect(imports[1].source).toBe('strings');
});

test('scanImports: Python from-imports exclude module name from symbols', () => {
  const code = `from foo import bar, baz`;
  const imports = scanImports('m.py', code);
  expect(imports).toHaveLength(1);
  expect(imports[0].source).toBe('foo');
  expect(imports[0].symbols).toEqual(['bar', 'baz']);
});

test('scanImports: Python plain imports', () => {
  const code = `import os\n`;
  const imports = scanImports('m.py', code);
  expect(imports[0].source).toBe('os');
});

test('scanImports: unsupported extension returns empty', () => {
  expect(scanImports('m.md', 'whatever')).toEqual([]);
});

test('scanImports: file with no imports returns empty', () => {
  expect(scanImports('m.ts', 'function foo() {}')).toEqual([]);
});

// ============================================================
// extractExtends
// ============================================================

test('extractExtends: TS class with extends', () => {
  const code = `class Dog extends Animal {}`;
  const info = extractExtends('m.ts', code);
  expect(info).toHaveLength(1);
  expect(info[0].className).toBe('Dog');
  expect(info[0].parentNames).toEqual(['Animal']);
});

test('extractExtends: TS class without extends returns empty', () => {
  const code = `class Foo {}`;
  expect(extractExtends('m.ts', code)).toEqual([]);
});

test('extractExtends: Python class with superclass', () => {
  const code = `class Dog(Animal):\n    pass`;
  const info = extractExtends('m.py', code);
  expect(info).toHaveLength(1);
  expect(info[0].className).toBe('Dog');
  expect(info[0].parentNames).toEqual(['Animal']);
});

test('extractExtends: Go returns empty (no extends concept)', () => {
  const code = `type Dog struct{ Animal }`;
  expect(extractExtends('main.go', code)).toEqual([]);
});

test('extractExtends: unsupported extension returns empty', () => {
  expect(extractExtends('m.md', 'class X extends Y')).toEqual([]);
});

// ============================================================
// findNthIdentifier
// ============================================================

test('findNthIdentifier: finds first occurrence', () => {
  const code = `const x = foo + foo;`;
  const pos = findNthIdentifier('m.ts', code, 'foo', 1);
  expect(pos).toBeDefined();
  expect(pos!.row).toBe(0);
  expect(pos!.column).toBe(10);
});

test('findNthIdentifier: finds second occurrence', () => {
  const code = `const x = foo + foo;`;
  const pos = findNthIdentifier('m.ts', code, 'foo', 2);
  expect(pos).toBeDefined();
  expect(pos!.column).toBe(16);
});

test('findNthIdentifier: returns undefined for missing name', () => {
  const code = `const x = 1;`;
  expect(findNthIdentifier('m.ts', code, 'missing', 1)).toBeUndefined();
});

test('findNthIdentifier: returns undefined when occurrence exceeds count', () => {
  const code = `foo`;
  expect(findNthIdentifier('m.ts', code, 'foo', 5)).toBeUndefined();
});

test('findNthIdentifier: returns undefined for unsupported extension', () => {
  expect(findNthIdentifier('m.md', 'content', 'foo', 1)).toBeUndefined();
});

test('findNthIdentifier: tracks line number for multiline', () => {
  const code = `const a = 1;\nconst b = foo();`;
  const pos = findNthIdentifier('m.ts', code, 'foo', 1);
  expect(pos!.row).toBe(1);
});
