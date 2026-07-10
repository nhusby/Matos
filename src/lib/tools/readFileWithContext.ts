import { resolve, relative, join, dirname, basename } from 'path';
import { readFile, stat } from 'fs/promises';
import type { Tool } from '../Agent';
import {
  extractExtends,
  scanImports,
} from '../parsers/extractors.js';
import { languageForPath } from '../parsers/languages.js';
import { pickSignaturesBackend } from '../lsp/backends.js';

const MAX_EXTENDS_DEPTH = 3;

const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'];

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function resolveImportPath(
  importerPath: string,
  source: string,
): Promise<string | undefined> {
  if (!source) return undefined;
  if (!source.startsWith('.') && !source.startsWith('/')) return undefined;
  const base = resolve(dirname(importerPath), source);
  for (const ext of ['', ...RESOLVE_EXTS]) {
    const candidate = base + ext;
    if (await fileExists(candidate)) return candidate;
  }
  for (const ext of RESOLVE_EXTS) {
    const candidate = join(base, 'index' + ext);
    if (await fileExists(candidate)) return candidate;
  }
  return undefined;
}

async function buildImportMap(
  filePath: string,
  content: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const imp of scanImports(filePath, content)) {
    if (!imp.source) continue;
    const resolved = await resolveImportPath(filePath, imp.source);
    if (!resolved) continue;
    for (const sym of imp.symbols) map.set(sym, resolved);
    map.set(imp.source, resolved);
    map.set(basename(imp.source), resolved);
  }
  return map;
}

async function resolveExtendsChain(
  filePath: string,
  maxDepth: number,
): Promise<Map<string, string>> {
  const extendsMap = new Map<string, string>();
  const visited = new Set<string>();
  const queue: { path: string; depth: number }[] = [
    { path: filePath, depth: 0 },
  ];

  while (queue.length > 0) {
    const { path, depth } = queue.shift()!;
    const resolved = resolve(path);
    if (visited.has(resolved) || depth >= maxDepth) continue;
    visited.add(resolved);

    if (!languageForPath(resolved)) continue;
    const content = await readFile(resolved, 'utf-8').catch(() => '');
    if (!content) continue;

    const importMap = await buildImportMap(resolved, content);
    for (const info of extractExtends(resolved, content)) {
      for (const parentName of info.parentNames) {
        const parentPath = importMap.get(parentName);
        if (!parentPath || parentPath.includes('node_modules')) continue;
        extendsMap.set(resolved, parentPath);
        queue.push({ path: parentPath, depth: depth + 1 });
      }
    }
  }

  return extendsMap;
}

function getExtendsOrder(
  extendsMap: Map<string, string>,
  targetPath: string,
): string[] {
  const chain: string[] = [];
  let current = targetPath;
  while (extendsMap.has(current)) {
    const parent = extendsMap.get(current)!;
    chain.unshift(parent);
    current = parent;
  }
  return chain;
}

function fenceLang(p: string): string {
  const lang = languageForPath(p);
  if (lang === 'typescript' || lang === 'tsx') return 'typescript';
  return lang ?? '';
}

async function formatOutput(
  signatures: Map<string, string>,
  extendsMap: Map<string, string>,
  targetFilePath: string,
): Promise<string> {
  const sections: string[] = [];

  if (signatures.size > 0) {
    sections.push('<ImportedSignatures>');
    sections.push('```typescript');
    for (const sig of signatures.values()) {
      sections.push(sig);
      sections.push('');
    }
    sections.push('```');
    sections.push('</ImportedSignatures>');
  }

  for (const parentPath of getExtendsOrder(extendsMap, targetFilePath)) {
    const relPath = relative(process.cwd(), parentPath);
    const content = await readFile(parentPath, 'utf-8').catch(
      () => `// Could not read ${relPath}`,
    );
    sections.push(`<ExtendedClass path="${relPath}">`);
    sections.push('```' + fenceLang(parentPath));
    sections.push(content);
    sections.push('```');
    sections.push('</ExtendedClass>');
  }

  const relTarget = relative(process.cwd(), targetFilePath);
  const targetContent = await readFile(targetFilePath, 'utf-8').catch(
    () => `// Could not read ${relTarget}`,
  );
  sections.push(`<SourceFile path="${relTarget}">`);
  sections.push('```' + fenceLang(targetFilePath));
  sections.push(targetContent);
  sections.push('```');
  sections.push('</SourceFile>');

  return sections.join('\n');
}

export const readFileWithContextTool: Tool = {
  name: 'ReadFileWithContext',
  description:
    'Read a source file with enriched context. Includes imported symbol type signatures (TS/JS via TypeScript, others via LSP if configured), extended class source files (recursively up to 3 levels), and the target file contents.',
  ttl: 3,
  params: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to a source file (TS/JS/Go/Python/Perl supported).',
      },
      maxExtendsDepth: {
        type: 'number',
        description:
          'Maximum depth for resolving extended classes. Default: 3.',
      },
    },
    required: ['path'],
  },
  callback: async ({ path, maxExtendsDepth }) => {
    const filePath = resolve(path);
    const maxDepth = maxExtendsDepth ?? MAX_EXTENDS_DEPTH;

    if (!(await fileExists(filePath))) {
      return `Error: File not found: ${path}`;
    }

    const lang = languageForPath(filePath);
    if (!lang) {
      return await readFile(filePath, 'utf-8').catch(
        () => `Error: Could not read ${path}`,
      );
    }

    const extendsMap = await resolveExtendsChain(filePath, maxDepth);
    const allFiles = [...getExtendsOrder(extendsMap, filePath), filePath];
    const fullContentFiles = new Set(allFiles.map((f) => resolve(f)));

    const sigBackend = pickSignaturesBackend(filePath);
    let signatures = new Map<string, string>();
    if (sigBackend.available) {
      try {
        signatures = await sigBackend.importedSignatures(
          filePath,
          allFiles,
          fullContentFiles,
        );
      } catch (e) {
        console.warn(
          '[readFileWithContext] signature extraction failed:',
          (e as Error).message,
        );
      }
    }

    return formatOutput(signatures, extendsMap, filePath);
  },
};
