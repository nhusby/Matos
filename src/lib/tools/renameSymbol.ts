import ts from 'typescript';
import { resolve } from 'path';
import { readFile, writeFile } from 'fs/promises';
import type { Tool } from '../Agent';
import { createLanguageService } from './languageServiceHost.js';

export const renameSymbolTool: Tool = {
  name: 'RenameSymbol',
  description:
    'Rename a JS/TS symbol (variable, class, interface, property, function, etc.) across all files in the project. Uses the TypeScript Language Service for semantic-aware renaming — only renames actual code references, not comments or strings. Requires line and column to identify which symbol to rename.',
  params: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path containing the symbol to rename.',
      },
      line: {
        type: 'number',
        description: '1-based line number where the symbol appears.',
      },
      column: {
        type: 'number',
        description:
          '1-based column number (character offset within the line) where the symbol starts.',
      },
      newName: { type: 'string', description: 'New name for the symbol.' },
    },
    required: ['path', 'line', 'column', 'newName'],
  },
  callback: async ({ path, line, column, newName }) => {
    const filePath = resolve(path);

    const { service: ls, program } = createLanguageService();
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) return `Error: Could not load file ${path}`;

    const position = ts.getPositionOfLineAndCharacter(
      sourceFile,
      line - 1,
      column - 1,
    );

    const renameInfo = ls.getRenameInfo(filePath, position);
    if (!renameInfo.canRename)
      return `Error: Cannot rename: ${renameInfo.localizedErrorMessage}`;

    const locations = ls.findRenameLocations(filePath, position, false, false, false);
    if (!locations?.length)
      return `Error: No references found at ${path}:${line}:${column}`;

    const byFile = new Map<string, ts.RenameLocation[]>();
    for (const loc of locations) {
      if (!byFile.has(loc.fileName)) byFile.set(loc.fileName, []);
      byFile.get(loc.fileName)!.push(loc);
    }

    const results: string[] = [];

    for (const [fileName, locs] of byFile) {
      let content = await readFile(fileName, 'utf-8');
      // Apply in reverse order to preserve offsets
      const sorted = [...locs].sort(
        (a, b) => b.textSpan.start - a.textSpan.start,
      );
      for (const loc of sorted) {
        const { start, length } = loc.textSpan;
        content =
          content.slice(0, start) + newName + content.slice(start + length);
      }
      await writeFile(fileName, content, 'utf-8');
      results.push(`${locs.length} occurrence(s) in ${fileName}`);
    }

    return `Renamed to "${newName}" across ${byFile.size} file(s):\n${results.join('\n')}`;
  },
};
