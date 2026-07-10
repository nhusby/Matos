import Parser from 'tree-sitter';
import { TYPESCRIPT_QUERIES } from './queries/typescript.js';
import { GO_QUERIES } from './queries/go.js';
import { PYTHON_QUERIES } from './queries/python.js';
import { PERL_QUERIES } from './queries/perl.js';
import { getParser, parseSource } from './registry.js';
import { languageForPath, type Language } from './languages.js';

type QueryBundle = Readonly<Record<string, string>>;

const QUERY_BUNDLES: Record<Language, QueryBundle> = {
  typescript: TYPESCRIPT_QUERIES,
  tsx: TYPESCRIPT_QUERIES,
  go: GO_QUERIES,
  python: PYTHON_QUERIES,
  perl: PERL_QUERIES,
};

const queryCache = new Map<string, Parser.Query>();

function getQuery(lang: Language, key: string): Parser.Query | null {
  const source = QUERY_BUNDLES[lang]?.[key];
  if (!source) return null;
  const cacheKey = `${lang}:${key}`;
  const cached = queryCache.get(cacheKey);
  if (cached) return cached;
  try {
    const q = new Parser.Query(getParser(lang).getLanguage(), source);
    queryCache.set(cacheKey, q);
    return q;
  } catch (e) {
    console.warn(
      `[tree-sitter] Failed to compile ${key} query for ${lang}:`,
      (e as Error).message,
    );
    return null;
  }
}

export interface ExportInfo {
  name: string;
}

export interface SymbolInfo {
  kind: 'function' | 'method' | 'class';
  name: string;
  sourceText: string;
  filePath: string;
  startLine: number;
  endLine: number;
  className?: string;
}

export interface ImportInfo {
  source: string;
  symbols: string[];
}

export interface ExtendsInfo {
  className: string;
  parentNames: string[];
}

function linesFromNode(node: Parser.SyntaxNode): {
  startLine: number;
  endLine: number;
} {
  return {
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

function findEnclosingClass(node: Parser.SyntaxNode): string | undefined {
  const classTypes = new Set([
    'class_declaration',
    'class_definition',
    'package_statement',
  ]);
  let p: Parser.SyntaxNode | null = node.parent;
  while (p) {
    if (classTypes.has(p.type)) {
      const nameNode = p.childForFieldName('name');
      return nameNode?.text;
    }
    p = p.parent;
  }
  return undefined;
}

function extractCapturesByMatch(
  query: Parser.Query,
  root: Parser.SyntaxNode,
): Parser.QueryMatch[] {
  return query.matches(root);
}

function findCapture(
  matches: Parser.QueryMatch[],
  name: string,
): Parser.SyntaxNode | undefined {
  for (const m of matches) {
    for (const c of m.captures) {
      if (c.name === name) return c.node;
    }
  }
  return undefined;
}

function findAllCaptures(
  matches: Parser.QueryMatch[],
  name: string,
): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = [];
  for (const m of matches) {
    for (const c of m.captures) {
      if (c.name === name) out.push(c.node);
    }
  }
  return out;
}

export function extractExports(
  filePath: string,
  content: string,
): ExportInfo[] {
  const lang = languageForPath(filePath);
  if (!lang) return [];
  const query = getQuery(lang, 'exports');
  if (!query) return [];
  const tree = parseSource(lang, content);
  const matches = extractCapturesByMatch(query, tree.rootNode);

  const names = new Set<string>();
  for (const m of matches) {
    for (const c of m.captures) {
      if (c.name === 'export.name' && c.node.text) {
        names.add(c.node.text);
      }
    }
  }
  return [...names].map((name) => ({ name }));
}

export function extractSymbols(
  filePath: string,
  content: string,
): SymbolInfo[] {
  const lang = languageForPath(filePath);
  if (!lang) return [];
  const query = getQuery(lang, 'symbols');
  if (!query) return [];
  const tree = parseSource(lang, content);
  const matches = extractCapturesByMatch(query, tree.rootNode);
  const symbols: SymbolInfo[] = [];

  for (const m of matches) {
    const decl = findCapture([m], 'symbol.decl');
    const name = findCapture([m], 'symbol.name');
    if (!decl || !name) continue;

    const declType = decl.type;
    let kind: SymbolInfo['kind'] = 'function';
    let className: string | undefined;

    if (
      declType === 'class_declaration' ||
      declType === 'class_definition' ||
      declType === 'package_statement' ||
      declType === 'type_declaration'
    ) {
      kind = 'class';
    } else if (
      declType === 'method_definition' ||
      declType === 'method_declaration'
    ) {
      kind = 'method';
      const enclosingClass = findEnclosingClass(decl);
      if (enclosingClass) className = enclosingClass;
    } else if (
      declType === 'function_declaration' ||
      declType === 'function_definition' ||
      declType === 'subroutine_declaration_statement'
    ) {
      const enclosingClass = findEnclosingClass(decl);
      if (enclosingClass) {
        kind = 'method';
        className = enclosingClass;
      } else {
        kind = 'function';
      }
    }

    const lines = linesFromNode(decl);
    symbols.push({
      kind,
      name: name.text,
      sourceText: decl.text,
      filePath,
      startLine: lines.startLine,
      endLine: lines.endLine,
      ...(className ? { className } : {}),
    });
  }

  return symbols;
}

export function scanImports(filePath: string, content: string): ImportInfo[] {
  const lang = languageForPath(filePath);
  if (!lang) return [];
  const tree = parseSource(lang, content);
  return scanImportsFromTree(lang, tree.rootNode);
}

function scanImportsFromTree(
  lang: Language,
  root: Parser.SyntaxNode,
): ImportInfo[] {
  switch (lang) {
    case 'typescript':
    case 'tsx':
      return scanTypeScriptImports(root);
    case 'go':
      return scanGoImports(root);
    case 'python':
      return scanPythonImports(root);
    case 'perl':
      return scanPerlImports(root);
  }
  return [];
}

function nodeTextSafe(
  node: Parser.SyntaxNode | null | undefined,
): string | undefined {
  if (!node) return undefined;
  try {
    return node.text;
  } catch {
    return undefined;
  }
}

function cleanSource(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, '');
}

function scanTypeScriptImports(root: Parser.SyntaxNode): ImportInfo[] {
  const imports: ImportInfo[] = [];
  walkTree(root, (n) => {
    if (n.type !== 'import_statement') return;
    const sourceNode = findChildByType(n, 'string');
    const sourceText = nodeTextSafe(sourceNode);
    if (!sourceText) return;
    const clause = n.namedChildren.find((c) => c.type === 'import_clause');
    const symbols = clause ? extractTSSymbols(clause) : [];
    imports.push({ source: cleanSource(sourceText), symbols });
  });
  return imports;
}

function extractTSSymbols(clause: Parser.SyntaxNode): string[] {
  const symbols: string[] = [];
  walkTree(clause, (n) => {
    if (n.type === 'identifier') symbols.push(n.text);
    else if (
      n.type === 'import_clause' ||
      n.type === 'named_imports' ||
      n.type === 'namespace_import'
    )
      return;
  });
  return symbols;
}

function scanGoImports(root: Parser.SyntaxNode): ImportInfo[] {
  const imports: ImportInfo[] = [];
  walkTree(root, (n) => {
    if (n.type !== 'import_declaration') return;
    const specs = collectByType(n, 'import_spec');
    for (const spec of specs) {
      const pathNode = findChildByType(spec, 'interpreted_string_literal');
      const pathText = nodeTextSafe(pathNode);
      if (!pathText) continue;
      const aliasNode = spec.namedChildren.find(
        (c) => c.type === 'package_identifier',
      );
      const symbols = aliasNode ? [aliasNode.text] : [];
      imports.push({ source: cleanSource(pathText), symbols });
    }
  });
  return imports;
}

function scanPythonImports(root: Parser.SyntaxNode): ImportInfo[] {
  const imports: ImportInfo[] = [];
  walkTree(root, (n) => {
    if (n.type === 'import_statement') {
      const nameNode = findChildByType(n, 'dotted_name');
      if (nameNode) imports.push({ source: nameNode.text, symbols: [] });
    } else if (n.type === 'import_from_statement') {
      const moduleNode = n.childForFieldName('module_name');
      const module = moduleNode ? moduleNode.text : '';
      const symbols: string[] = [];
      for (const child of n.namedChildren) {
        if (child === moduleNode) continue;
        walkTree(child, (c) => {
          if (c.type === 'identifier') symbols.push(c.text);
        });
      }
      imports.push({ source: module, symbols });
    }
  });
  return imports;
}

function scanPerlImports(root: Parser.SyntaxNode): ImportInfo[] {
  const imports: ImportInfo[] = [];
  walkTree(root, (n) => {
    if (n.type !== 'use_statement') return;
    const mod = findChildByType(n, 'package_name');
    if (mod) imports.push({ source: mod.text, symbols: [] });
  });
  return imports;
}

function walkTree(
  node: Parser.SyntaxNode,
  visit: (n: Parser.SyntaxNode) => void,
): void {
  visit(node);
  for (const c of node.children) walkTree(c, visit);
}

function findChildByType(
  node: Parser.SyntaxNode,
  type: string,
): Parser.SyntaxNode | null {
  for (const c of node.children) {
    if (c.type === type) return c;
  }
  for (const c of node.children) {
    const found = findChildByType(c, type);
    if (found) return found;
  }
  return null;
}

function collectByType(
  node: Parser.SyntaxNode,
  type: string,
): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = [];
  walkTree(node, (n) => {
    if (n.type === type) out.push(n);
  });
  return out;
}

export function extractExtends(
  filePath: string,
  content: string,
): ExtendsInfo[] {
  const lang = languageForPath(filePath);
  if (!lang) return [];
  const query = getQuery(lang, 'extendsClause');
  if (!query) return [];
  const tree = parseSource(lang, content);
  const matches = extractCapturesByMatch(query, tree.rootNode);

  const results: ExtendsInfo[] = [];
  for (const m of matches) {
    const classNode = findCapture([m], 'class.name');
    const extendsNodes = findAllCaptures([m], 'class.extends');
    if (!classNode) continue;
    if (!extendsNodes.length) continue;
    results.push({
      className: classNode.text,
      parentNames: extendsNodes.map((n) => n.text),
    });
  }
  return results;
}

export function findNthIdentifier(
  filePath: string,
  content: string,
  name: string,
  occurrence: number,
): { row: number; column: number } | undefined {
  const lang = languageForPath(filePath);
  if (!lang) return undefined;
  const query = getQuery(lang, 'identifiers');
  if (!query) return undefined;
  const tree = parseSource(lang, content);
  const captures = query.captures(tree.rootNode);

  let count = 0;
  for (const c of captures) {
    if (c.node.text === name) {
      count++;
      if (count === occurrence) {
        return {
          row: c.node.startPosition.row,
          column: c.node.startPosition.column,
        };
      }
    }
  }
  return undefined;
}
