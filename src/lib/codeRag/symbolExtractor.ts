import ts from 'typescript';

export interface ExtractedSymbol {
  kind: 'function' | 'method' | 'class';
  name: string;
  sourceText: string;
  filePath: string;
  startLine: number;
  endLine: number;
  className?: string;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node)
    ? Array.from(ts.getModifiers(node) ?? [])
    : [];
  return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function getLineInfo(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function extractFromClass(classDecl: ts.ClassDeclaration, sf: ts.SourceFile): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const className = classDecl.name?.text ?? '<anonymous>';

  if (classDecl.name) {
    symbols.push({
      kind: 'class',
      name: className,
      sourceText: sf.text.substring(classDecl.getStart(sf), classDecl.getEnd()),
      filePath: sf.fileName,
      startLine: getLineInfo(sf, classDecl.getStart(sf)),
      endLine: getLineInfo(sf, classDecl.getEnd()),
    });
  }

  for (const member of classDecl.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    const methodName = member.name && ts.isIdentifier(member.name) ? member.name.text : '<anonymous>';
    if (methodName === 'constructor') continue;

    symbols.push({
      kind: 'method',
      name: methodName,
      sourceText: sf.text.substring(member.getStart(sf), member.getEnd()),
      filePath: sf.fileName,
      startLine: getLineInfo(sf, member.getStart(sf)),
      endLine: getLineInfo(sf, member.getEnd()),
      className,
    });
  }

  return symbols;
}

export function extractSymbols(filePath: string, content: string): ExtractedSymbol[] {
  const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const symbols: ExtractedSymbol[] = [];

  for (const node of sf.statements) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      symbols.push({
        kind: 'function',
        name: node.name.text,
        sourceText: sf.text.substring(node.getStart(sf), node.getEnd()),
        filePath,
        startLine: getLineInfo(sf, node.getStart(sf)),
        endLine: getLineInfo(sf, node.getEnd()),
      });
      continue;
    }

    if (ts.isClassDeclaration(node) && node.name) {
      symbols.push(...extractFromClass(node, sf));
      continue;
    }

    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const init = decl.initializer;
        if (!init) continue;

        if (
          ts.isArrowFunction(init) ||
          ts.isFunctionExpression(init)
        ) {
          symbols.push({
            kind: 'function',
            name: decl.name.text,
            sourceText: sf.text.substring(node.getStart(sf), node.getEnd()),
            filePath,
            startLine: getLineInfo(sf, node.getStart(sf)),
            endLine: getLineInfo(sf, node.getEnd()),
          });
        }
      }
    }
  }

  return symbols;
}
