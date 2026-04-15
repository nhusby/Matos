import ts from 'typescript';
import { resolve, relative } from 'path';
import type { Tool } from '../Agent';
import { createLanguageService } from './languageServiceHost.js';

const MAX_EXTENDS_DEPTH = 3;

function resolveExtendsChain(
  filePath: string,
  service: ts.LanguageService,
  program: ts.Program,
  maxDepth: number,
): Map<string, string> {
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

    const sourceFile = program.getSourceFile(resolved);
    if (!sourceFile) continue;

    ts.forEachChild(sourceFile, (node) => {
      if (!ts.isClassDeclaration(node) && !ts.isClassExpression(node)) return;
      if (!node.heritageClauses) return;

      for (const clause of node.heritageClauses) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        if (clause.types.length === 0) continue;

        const extExpr = clause.types[0].expression;
        const defs = service.getDefinitionAtPosition(
          resolved,
          extExpr.getStart(),
        );
        if (!defs?.length) continue;

        const defFile = defs[0].fileName;
        if (defFile.includes('node_modules')) continue;
        if (!ts.sys.fileExists(defFile)) continue;

        extendsMap.set(resolved, defFile);
        queue.push({ path: defFile, depth: depth + 1 });
      }
    });
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

function formatClassSignature(
  decl: ts.ClassDeclaration | ts.ClassExpression,
  typeChecker: ts.TypeChecker,
): string {
  const sourceFile = decl.getSourceFile();
  const parts: string[] = [];

  let header = '';
  if (decl.modifiers) {
    header += decl.modifiers.map((m) => m.getText(sourceFile)).join(' ') + ' ';
  }
  header += 'class ';
  if (decl.name) header += decl.name.getText(sourceFile);
  if (decl.typeParameters) {
    header +=
      '<' +
      decl.typeParameters.map((tp) => tp.getText(sourceFile)).join(', ') +
      '>';
  }
  if (decl.heritageClauses) {
    for (const hc of decl.heritageClauses) {
      header += ' ' + hc.getText(sourceFile);
    }
  }
  parts.push(header + ' {');

  for (const member of decl.members) {
    if (ts.isMethodDeclaration(member)) {
      const sig = typeChecker.getSignatureFromDeclaration(member);
      if (sig) {
        const sigStr = typeChecker.signatureToString(sig);
        const modifiers = member.modifiers
          ? member.modifiers.map((m) => m.getText(sourceFile)).join(' ') + ' '
          : '';
        const name = member.name?.getText(sourceFile) ?? '';
        parts.push(`  ${modifiers}${name}${sigStr};`);
      }
    } else if (ts.isPropertyDeclaration(member)) {
      const type = typeChecker.getTypeAtLocation(member);
      const typeStr = typeChecker.typeToString(type);
      const modifiers = member.modifiers
        ? member.modifiers.map((m) => m.getText(sourceFile)).join(' ') + ' '
        : '';
      const name = member.name?.getText(sourceFile) ?? '';
      const optional = member.questionToken ? '?' : '';
      parts.push(`  ${modifiers}${name}${optional}: ${typeStr};`);
    } else if (ts.isConstructorDeclaration(member)) {
      const sig = typeChecker.getSignatureFromDeclaration(member);
      if (sig) {
        const sigStr = typeChecker.signatureToString(sig);
        parts.push(`  constructor${sigStr};`);
      }
    }
  }

  parts.push('}');
  return parts.join('\n');
}

function formatSignature(
  decl: ts.Declaration,
  typeChecker: ts.TypeChecker,
  printer: ts.Printer,
): string | undefined {
  const sourceFile = decl.getSourceFile();
  const parts: string[] = [];

  const jsDocs = (decl as any).jsDoc as ts.JSDoc[] | undefined;
  if (jsDocs?.length) {
    for (const doc of jsDocs) {
      parts.push(printer.printNode(ts.EmitHint.Unspecified, doc, sourceFile));
    }
  }

  if (ts.isInterfaceDeclaration(decl)) {
    parts.push(printer.printNode(ts.EmitHint.Unspecified, decl, sourceFile));
  } else if (ts.isTypeAliasDeclaration(decl)) {
    parts.push(printer.printNode(ts.EmitHint.Unspecified, decl, sourceFile));
  } else if (ts.isEnumDeclaration(decl)) {
    parts.push(printer.printNode(ts.EmitHint.Unspecified, decl, sourceFile));
  } else if (ts.isFunctionDeclaration(decl)) {
    const sig = typeChecker.getSignatureFromDeclaration(decl);
    if (sig) {
      const sigStr = typeChecker.signatureToString(sig);
      const modifiers = decl.modifiers
        ? decl.modifiers.map((m) => m.getText(sourceFile)).join(' ') + ' '
        : '';
      parts.push(`${modifiers}${sigStr}`);
    }
  } else if (ts.isClassDeclaration(decl) || ts.isClassExpression(decl)) {
    parts.push(formatClassSignature(decl, typeChecker));
  } else if (ts.isVariableDeclaration(decl)) {
    const type = typeChecker.getTypeAtLocation(decl);
    const typeStr = typeChecker.typeToString(type);
    const varName = ts.isIdentifier(decl.name)
      ? decl.name.getText(sourceFile)
      : decl.name.getText(sourceFile);
    parts.push(`const ${varName}: ${typeStr}`);
  } else {
    return undefined;
  }

  return parts.join('\n');
}

function collectImportSymbols(
  importDecl: ts.ImportDeclaration,
  typeChecker: ts.TypeChecker,
): { symbol: ts.Symbol; name: string }[] {
  const clause = importDecl.importClause!;
  const symbols: { symbol: ts.Symbol; name: string }[] = [];

  if (clause.name) {
    const sym = typeChecker.getSymbolAtLocation(clause.name);
    if (sym) symbols.push({ symbol: sym, name: clause.name.getText() });
  }

  if (clause.namedBindings) {
    if (ts.isNamedImports(clause.namedBindings)) {
      for (const elem of clause.namedBindings.elements) {
        const sym = typeChecker.getSymbolAtLocation(elem.name);
        if (sym) symbols.push({ symbol: sym, name: elem.name.getText() });
      }
    } else if (ts.isNamespaceImport(clause.namedBindings)) {
      const sym = typeChecker.getSymbolAtLocation(clause.namedBindings.name);
      if (sym)
        symbols.push({
          symbol: sym,
          name: clause.namedBindings.name.getText(),
        });
    }
  }

  return symbols;
}

function extractImportSignatures(
  files: string[],
  fullContentFiles: Set<string>,
  service: ts.LanguageService,
  program: ts.Program,
  typeChecker: ts.TypeChecker,
  printer: ts.Printer,
): Map<string, string> {
  const emitted = new Map<string, string>();

  for (const filePath of files) {
    const sourceFile = program.getSourceFile(resolve(filePath));
    if (!sourceFile) continue;

    ts.forEachChild(sourceFile, (node) => {
      if (!ts.isImportDeclaration(node)) return;
      if (!node.importClause) return;

      if (!ts.isStringLiteral(node.moduleSpecifier)) return;

      const importSymbols = collectImportSymbols(node, typeChecker);
      for (const { symbol } of importSymbols) {
        const resolved =
          symbol.flags & ts.SymbolFlags.Alias
            ? typeChecker.getAliasedSymbol(symbol)
            : symbol;
        const decls = resolved.getDeclarations();
        if (!decls?.length) continue;

        const decl = decls[0];
        const declFile = decl.getSourceFile().fileName;
        if (fullContentFiles.has(resolve(declFile))) continue;

        const key = `${resolved.name}::${declFile}`;
        if (emitted.has(key)) continue;

        const signature = formatSignature(decl, typeChecker, printer);
        if (signature) emitted.set(key, signature);
      }
    });
  }

  return emitted;
}

function formatOutput(
  signatures: Map<string, string>,
  extendsMap: Map<string, string>,
  targetFilePath: string,
): string {
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

  const orderedParents = getExtendsOrder(extendsMap, targetFilePath);
  for (const parentPath of orderedParents) {
    const relPath = relative(process.cwd(), parentPath);
    sections.push(`<ExtendedClass path="${relPath}">`);
    sections.push('```typescript');
    const content = ts.sys.readFile(parentPath);
    sections.push(content ?? `// Could not read ${relPath}`);
    sections.push('```');
    sections.push('</ExtendedClass>');
  }

  const relTarget = relative(process.cwd(), targetFilePath);
  sections.push(`<SourceFile path="${relTarget}">`);
  sections.push('```typescript');
  const targetContent = ts.sys.readFile(targetFilePath);
  sections.push(targetContent ?? `// Could not read ${relTarget}`);
  sections.push('```');
  sections.push('</SourceFile>');

  return sections.join('\n');
}

export const readFileWithContextTool: Tool = {
  name: 'ReadFileWithContext',
  description:
    'Read a TypeScript/JavaScript file with enriched context. Includes imported symbol type signatures (with JSDoc), extended class source files (recursively up to 3 levels), and the target file contents.',
  params: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the TypeScript or JavaScript file to read.',
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

    if (!ts.sys.fileExists(filePath)) {
      return `Error: File not found: ${path}`;
    }

    const ext = filePath.slice(filePath.lastIndexOf('.'));
    if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
      return ts.sys.readFile(filePath) ?? `Error: Could not read ${path}`;
    }

    const { service, program, typeChecker } = createLanguageService();
    const extendsMap = resolveExtendsChain(
      filePath,
      service,
      program,
      maxDepth,
    );

    const allFiles = [...getExtendsOrder(extendsMap, filePath), filePath];
    const fullContentFiles = new Set(allFiles.map((f) => resolve(f)));

    const printer = ts.createPrinter({ removeComments: false });
    const signatures = extractImportSignatures(
      allFiles,
      fullContentFiles,
      service,
      program,
      typeChecker,
      printer,
    );

    return formatOutput(signatures, extendsMap, filePath);
  },
};
