import { readdir, readFile } from 'fs/promises';
import { resolve, relative, extname, join } from 'path';
import { homedir } from 'os';
import ignore from 'ignore';
import ts from 'typescript';
import type { Tool } from '../Agent';

const JS_TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);

async function readIgnoreFile(dir: string, filename: string): Promise<string[]> {
  try {
    return (await readFile(join(dir, filename), 'utf-8'))
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('#'));
  } catch {
    return [];
  }
}

function extractExports(filePath: string, content: string): string[] {
  const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const names: string[] = [];

  for (const node of sf.statements) {
    if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) names.push(el.name.text);
      }
      continue;
    }

    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      names.push('default');
      continue;
    }

    const modifiers = ts.canHaveModifiers(node)
      ? Array.from(ts.getModifiers(node) ?? [])
      : [];
    if (!modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const isDefault = modifiers.some(
      (m) => m.kind === ts.SyntaxKind.DefaultKeyword,
    );

    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) names.push(d.name.text);
      }
    } else if (
      'name' in node &&
      node.name &&
      ts.isIdentifier(node.name as ts.Node)
    ) {
      names.push((node.name as ts.Identifier).text);
    } else if (isDefault) {
      names.push('default');
    }
  }

  return names;
}

interface IgnoreCtx {
  global: ReturnType<typeof ignore>;
  local: ReturnType<typeof ignore>[];
}

async function walkTree(
  dir: string,
  root: string,
  ctx: IgnoreCtx,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const relDir = relative(root, dir);
  const prefix = relDir ? relDir + '/' : '';

  const localPatterns =
    dir === root
      ? []
      : [
          ...(await readIgnoreFile(dir, '.gitignore')),
          ...(await readIgnoreFile(dir, '.aiignore')),
        ];
  const localIg = localPatterns.length ? ignore().add(localPatterns) : null;

  const childCtx: IgnoreCtx = {
    global: ctx.global,
    local: localIg ? [...ctx.local, localIg] : ctx.local,
  };

  const filtered = entries.filter((e) => {
    if (e.name.startsWith('.')) return false;
    const relPath = prefix + e.name;
    if (
      ctx.global.ignores(relPath) ||
      (e.isDirectory() && ctx.global.ignores(relPath + '/'))
    )
      return false;
    const nameCheck = e.isDirectory() ? e.name + '/' : e.name;
    for (const ig of ctx.local) {
      if (ig.ignores(e.name) || ig.ignores(nameCheck)) return false;
    }
    if (localIg && (localIg.ignores(e.name) || localIg.ignores(nameCheck)))
      return false;
    return true;
  });

  filtered.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  const lines: string[] = [];
  for (const entry of filtered) {
    if (entry.isDirectory()) {
      lines.push(`- ${entry.name}/`);
      const subLines = await walkTree(join(dir, entry.name), root, childCtx);
      lines.push(...subLines.map((l) => `  ${l}`));
    } else {
      const ext = extname(entry.name);
      if (JS_TS_EXTS.has(ext)) {
        try {
          const content = await readFile(join(dir, entry.name), 'utf-8');
          const exports = extractExports(entry.name, content);
          lines.push(
            exports.length
              ? `- ${entry.name} - exports: ${exports.join(', ')}`
              : `- ${entry.name}`,
          );
        } catch {
          lines.push(`- ${entry.name}`);
        }
      } else {
        lines.push(`- ${entry.name}`);
      }
    }
  }

  return lines;
}

export async function buildFileTree(root?: string): Promise<string> {
  const expanded = root?.startsWith('~') ? root.replace('~', homedir()) : root;
  const resolved = resolve(expanded ?? process.cwd());
  const globalPatterns = [
    ...(await readIgnoreFile(resolved, '.gitignore')),
    ...(await readIgnoreFile(resolved, '.aiignore')),
  ];
  const ctx: IgnoreCtx = {
    global: ignore().add(globalPatterns),
    local: [],
  };
  return (await walkTree(resolved, resolved, ctx)).join('\n');
}

export function createFileTreeTool(): Tool {
  return {
    name: 'FileTree',
    description:
      'Get a recursive markdown tree of the file structure. TS/JS files include their exports.',
    params: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Root path. Defaults to current working directory.',
        },
      },
    },
    callback: async ({ path: rootPath }: { path?: string }) =>
      buildFileTree(rootPath),
  };
}
