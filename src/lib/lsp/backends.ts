import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';
import { createLanguageService } from '../tools/languageServiceHost.js';
import { languageForPath } from '../parsers/languages.js';
import { findNthIdentifier } from '../parsers/extractors.js';
import { readFile, writeFile } from 'fs/promises';
import { lspManager } from './manager.js';
import type { Position, Range, TextEdit, WorkspaceEdit } from './protocol.js';

export interface RenameEdit {
  start: number;
  length: number;
  newText: string;
}

export interface RenameResult {
  byFile: Map<string, RenameEdit[]>;
}

export interface ImportedName {
  name: string;
  source: string;
}

export interface RenameBackend {
  findEdits(
    filePath: string,
    occurrence: number,
    name: string,
    newName: string,
  ): Promise<RenameResult>;
}

export interface SignaturesBackend {
  available: boolean;
  importedSignatures(
    filePath: string,
    filesInScope: string[],
    fullContentFiles: Set<string>,
  ): Promise<Map<string, string>>;
}

class TsRenameBackend implements RenameBackend {
  async findEdits(
    filePath: string,
    occurrence: number,
    name: string,
    newName: string,
  ): Promise<RenameResult> {
    const resolved = resolve(filePath);
    const content = await readFile(resolved, 'utf-8');
    const pos = findNthIdentifier(resolved, content, name, occurrence);
    if (!pos) {
      throw new Error(
        `Could not find occurrence ${occurrence} of "${name}" in ${resolved}`,
      );
    }

    const { service: ls, program } = createLanguageService();
    const sourceFile = program.getSourceFile(resolved);
    if (!sourceFile) throw new Error(`Could not load file ${resolved}`);

    const offset = sourceFile.getPositionOfLineAndCharacter(
      pos.row,
      pos.column,
    );

    const renameInfo = ls.getRenameInfo(resolved, offset);
    if (!renameInfo.canRename) {
      throw new Error(`Cannot rename: ${renameInfo.localizedErrorMessage}`);
    }
    if (renameInfo.displayName !== name) {
      throw new Error(
        `Symbol at occurrence ${occurrence} is "${renameInfo.displayName}", not "${name}"`,
      );
    }

    const locations = ls.findRenameLocations(
      resolved,
      offset,
      false,
      false,
      false,
    );
    if (!locations?.length) {
      throw new Error(`No references found for "${name}" in ${resolved}`);
    }

    const byFile = new Map<string, RenameEdit[]>();
    for (const loc of locations) {
      if (!byFile.has(loc.fileName)) byFile.set(loc.fileName, []);
      byFile.get(loc.fileName)!.push({
        start: loc.textSpan.start,
        length: loc.textSpan.length,
        newText: newName,
      });
    }
    return { byFile };
  }
}

class TsSignaturesBackend implements SignaturesBackend {
  available = true;

  async importedSignatures(
    filePath: string,
    filesInScope: string[],
    fullContentFiles: Set<string>,
  ): Promise<Map<string, string>> {
    const { service, program, typeChecker } = createLanguageService();
    const printer = ts.createPrinter({ removeComments: false });
    return extractTsImportSignatures(
      filesInScope,
      fullContentFiles,
      service,
      program,
      typeChecker,
      printer,
    );
  }
}

class LspRenameBackend implements RenameBackend {
  constructor(private lang: string) {}

  async findEdits(
    filePath: string,
    occurrence: number,
    name: string,
    newName: string,
  ): Promise<RenameResult> {
    const client = lspManager.getClient(this.lang as any);
    if (!client || !client.isReady) {
      throw new Error(
        `Rename unavailable: ${this.lang} language server not running. Configure ~/.matos/config.json.`,
      );
    }
    if (!client.supportsRename()) {
      throw new Error(
        `Rename unavailable: ${this.lang} language server does not support rename.`,
      );
    }

    const content = await readFile(filePath, 'utf-8');
    const pos = findNthIdentifier(filePath, content, name, occurrence);
    if (!pos) {
      throw new Error(
        `Could not find occurrence ${occurrence} of "${name}" in ${filePath}`,
      );
    }

    const lspPos: Position = { line: pos.row, character: pos.column };
    const edit: WorkspaceEdit | null = await client.rename(
      filePath,
      lspPos,
      newName,
    );
    if (!edit) return { byFile: new Map() };

    const byFile = new Map<string, RenameEdit[]>();
    const editsByUri = this.flattenWorkspaceEdit(edit, content);
    for (const [uri, edits] of editsByUri) {
      const path = fileURLToPath(uri);
      const fileContent = await readFile(path, 'utf-8');
      const translated = edits.map((e) => ({
        newText: e.newText,
        start: offsetFromRange(fileContent, e.range).start,
        length:
          offsetFromRange(fileContent, e.range).end -
          offsetFromRange(fileContent, e.range).start,
      }));
      byFile.set(path, translated);
    }
    return { byFile };
  }

  private flattenWorkspaceEdit(
    edit: WorkspaceEdit,
    originalContent: string,
  ): Map<string, TextEdit[]> {
    const out = new Map<string, TextEdit[]>();
    if (edit.changes) {
      for (const [uri, edits] of Object.entries(edit.changes)) {
        out.set(uri, edits);
      }
    }
    if (edit.documentChanges) {
      for (const change of edit.documentChanges) {
        const existing = out.get(change.textDocument.uri) ?? [];
        existing.push(...change.edits);
        out.set(change.textDocument.uri, existing);
      }
    }
    void originalContent;
    return out;
  }
}

class LspSignaturesBackend implements SignaturesBackend {
  constructor(private lang: string) {}

  get available(): boolean {
    const client = lspManager.getClient(this.lang as any);
    return !!client?.isReady && client.supportsHover();
  }

  async importedSignatures(
    filePath: string,
    filesInScope: string[],
    fullContentFiles: Set<string>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const client = lspManager.getClient(this.lang as any);
    if (!client?.isReady || !client.supportsHover()) return out;

    for (const file of filesInScope) {
      if (fullContentFiles.has(resolve(file))) continue;
      try {
        const content = await readFile(file, 'utf-8');
        const { extractSymbols } = await import('../parsers/extractors.js');
        for (const sym of extractSymbols(file, content)) {
          const hover = await client
            .hover(file, {
              line: sym.startLine - 1,
              character: 0,
            })
            .catch(() => null);
          if (!hover) continue;
          const text = hoverToString(hover);
          if (text) out.set(`${sym.name}::${file}`, text);
        }
      } catch {
        // skip file
      }
    }
    return out;
  }
}

const TS_LANGS = new Set(['typescript', 'tsx']);
const tsRename = new TsRenameBackend();
const tsSigs = new TsSignaturesBackend();
const lspRenameCache = new Map<string, LspRenameBackend>();
const lspSigsCache = new Map<string, LspSignaturesBackend>();

export function pickRenameBackend(filePath: string): RenameBackend {
  const lang = languageForPath(filePath);
  if (lang && TS_LANGS.has(lang)) return tsRename;
  if (!lang) throw new Error(`Unsupported file type: ${filePath}`);
  if (!lspRenameCache.has(lang))
    lspRenameCache.set(lang, new LspRenameBackend(lang));
  return lspRenameCache.get(lang)!;
}

export function pickSignaturesBackend(filePath: string): SignaturesBackend {
  const lang = languageForPath(filePath);
  if (lang && TS_LANGS.has(lang)) return tsSigs;
  if (!lang)
    return lspSigsCache.get('none') ?? new LspSignaturesBackend('none');
  if (!lspSigsCache.has(lang))
    lspSigsCache.set(lang, new LspSignaturesBackend(lang));
  return lspSigsCache.get(lang)!;
}

function offsetFromRange(
  content: string,
  range: Range,
): { start: number; end: number } {
  const lines = content.split('\n');
  let start = 0;
  for (let i = 0; i < range.start.line; i++) start += lines[i]!.length + 1;
  start += range.start.character;
  let end = 0;
  for (let i = 0; i < range.end.line; i++) end += lines[i]!.length + 1;
  end += range.end.character;
  return { start, end };
}

function hoverToString(hover: { contents: unknown }): string | undefined {
  const c = hover.contents;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((item) =>
        typeof item === 'string'
          ? item
          : item && typeof item === 'object' && 'value' in item
            ? (item as { value: string }).value
            : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  if (c && typeof c === 'object' && 'value' in c) {
    return (c as { value: string }).value;
  }
  return undefined;
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
      if (sym) {
        symbols.push({
          symbol: sym,
          name: clause.namedBindings.name.getText(),
        });
      }
    }
  }

  return symbols;
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
    const varName = decl.name.getText(sourceFile);
    parts.push(`const ${varName}: ${typeStr}`);
  } else {
    return undefined;
  }

  return parts.join('\n');
}

function extractTsImportSignatures(
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

export async function applyRenameResult(
  result: RenameResult,
): Promise<string[]> {
  const out: string[] = [];
  for (const [fileName, edits] of result.byFile) {
    let content = await readFile(fileName, 'utf-8');
    const sorted = [...edits].sort((a, b) => b.start - a.start);
    for (const edit of sorted) {
      content =
        content.slice(0, edit.start) +
        edit.newText +
        content.slice(edit.start + edit.length);
    }
    await writeFile(fileName, content, 'utf-8');
    out.push(`${edits.length} occurrence(s) in ${fileName}`);
  }
  return out;
}
