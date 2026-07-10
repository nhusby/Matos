import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileWithContextTool } from '../../lib/tools/readFileWithContext';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'matos-rfwc-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test('readFileWithContext: returns plain content for unsupported extension', async () => {
  const filePath = join(tmpDir, 'readme.md');
  await writeFile(filePath, '# Hello\n\nThis is markdown.\n');
  const out = (await readFileWithContextTool.callback!({
    path: filePath,
  } as any)) as string;
  expect(out).toContain('# Hello');
  expect(out).not.toContain('<SourceFile');
});

test('readFileWithContext: wraps supported source file in SourceFile block', async () => {
  const filePath = join(tmpDir, 'a.ts');
  await writeFile(filePath, 'export const x = 1;\n');
  const out = (await readFileWithContextTool.callback!({
    path: filePath,
  } as any)) as string;
  expect(out).toContain('<SourceFile');
  expect(out).toContain('export const x = 1;');
  expect(out).toContain('</SourceFile>');
  expect(out).toContain('```typescript');
});

test('readFileWithContext: returns error for missing file', async () => {
  const out = (await readFileWithContextTool.callback!({
    path: join(tmpDir, 'nope.ts'),
  } as any)) as string;
  expect(out).toMatch(/^Error: File not found/);
});

test('readFileWithContext: includes extends chain parent files', async () => {
  const parentPath = join(tmpDir, 'base.ts');
  await writeFile(parentPath, 'export class Base { method() {} }\n');

  const childPath = join(tmpDir, 'child.ts');
  await writeFile(
    childPath,
    `import { Base } from './base';\nexport class Child extends Base {}\n`,
  );

  const out = (await readFileWithContextTool.callback!({
    path: childPath,
  } as any)) as string;
  expect(out).toContain('<ExtendedClass');
  expect(out).toContain('export class Base { method() {} }');
  expect(out).toContain('export class Child extends Base');
});

test('readFileWithContext: respects maxExtendsDepth', async () => {
  const grandparentPath = join(tmpDir, 'gp.ts');
  await writeFile(grandparentPath, 'export class GP {}\n');

  const parentPath = join(tmpDir, 'p.ts');
  await writeFile(
    parentPath,
    `import { GP } from './gp';\nexport class P extends GP {}\n`,
  );

  const childPath = join(tmpDir, 'c.ts');
  await writeFile(
    childPath,
    `import { P } from './p';\nexport class C extends P {}\n`,
  );

  // depth=0 → no parents at all
  const zero = (await readFileWithContextTool.callback!({
    path: childPath,
    maxExtendsDepth: 0,
  } as any)) as string;
  expect(zero).not.toContain('<ExtendedClass');

  // depth=1 → only direct parent (P), not grandparent (GP)
  const one = (await readFileWithContextTool.callback!({
    path: childPath,
    maxExtendsDepth: 1,
  } as any)) as string;
  expect(one).toContain('export class P extends GP');
  expect(one).not.toContain('export class GP {}');
});

test('readFileWithContext: handles Go file with embedding', async () => {
  const filePath = join(tmpDir, 'main.go');
  await writeFile(
    filePath,
    `package main
import "fmt"
type Base struct{}
func (b Base) Hello() { fmt.Println("hi") }
type World struct { Base }
func (w World) Name() string { return "x" }
`,
  );
  const out = (await readFileWithContextTool.callback!({
    path: filePath,
  } as any)) as string;
  expect(out).toContain('<SourceFile');
  expect(out).toContain('type World struct');
  expect(out).toContain('```go');
});

test('readFileWithContext: handles empty file', async () => {
  const filePath = join(tmpDir, 'empty.ts');
  await writeFile(filePath, '');
  const out = (await readFileWithContextTool.callback!({
    path: filePath,
  } as any)) as string;
  expect(out).toContain('<SourceFile');
});

test('readFileWithContext: does not duplicate parent in body when already in extends chain', async () => {
  const parentPath = join(tmpDir, 'parent.ts');
  await writeFile(parentPath, 'export class Parent {}\n');

  const childPath = join(tmpDir, 'main.ts');
  await writeFile(
    childPath,
    `import { Parent } from './parent';\nexport class Child extends Parent {}\n`,
  );

  const out = (await readFileWithContextTool.callback!({
    path: childPath,
  } as any)) as string;
  // Parent should appear in ExtendedClass block, Child in SourceFile block
  const extendedCount = (out.match(/<ExtendedClass/g) || []).length;
  const sourceCount = (out.match(/<SourceFile/g) || []).length;
  expect(extendedCount).toBe(1);
  expect(sourceCount).toBe(1);
});

test('readFileWithContext: handles file with no imports or extends', async () => {
  const filePath = join(tmpDir, 'solo.ts');
  await writeFile(filePath, 'export const answer = 42;\n');
  const out = (await readFileWithContextTool.callback!({
    path: filePath,
  } as any)) as string;
  expect(out).not.toContain('<ExtendedClass');
  expect(out).toContain('export const answer = 42;');
});
