import ts from 'typescript';
import { resolve, relative } from 'path';
import { readFile, writeFile } from 'fs/promises';
import type { Tool } from '../Agent';
import { createLanguageService } from './languageServiceHost.js';

function findNthIdentifierPosition(
  sourceFile: ts.SourceFile,
  name: string,
  occurrence: number,
): number | undefined {
  let count = 0;
  let found: number | undefined;

  const visit = (node: ts.Node) => {
    if (found !== undefined) return;
    if (ts.isIdentifier(node) && node.text === name) {
      count++;
      if (count === occurrence) {
        found = node.getStart(sourceFile);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return found;
}

export const renameSymbolTool: Tool = {
  name: 'RenameSymbol',
  description:
    'Rename a symbol (variable, class, interface, property, function, etc.) across all files in the project. Uses the TypeScript Language Service for strict semantic-aware renaming of code references.',
  params: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path containing the symbol to rename.',
      },
      name: {
        type: 'string',
        description: 'The current name of the symbol to rename.',
      },
      occurrence: {
        type: 'number',
        description:
          'Which occurrence of the name in the file (1-based). Use this when the same name appears multiple times and you want a specific one. Default: 1.',
      },
      newName: { type: 'string', description: 'New name for the symbol.' },
    },
    required: ['path', 'name', 'newName'],
  },
  callback: async ({ path, name, occurrence, newName }) => {
    const filePath = resolve(path);
    const n = occurrence ?? 1;

    const { service: ls, program } = createLanguageService();
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) return `Error: Could not load file ${path}`;

    const position = findNthIdentifierPosition(sourceFile, name, n);
    if (position === undefined)
      return `Error: Could not find occurrence ${n} of "${name}" in ${relative(process.cwd(), filePath)}`;

    const renameInfo = ls.getRenameInfo(filePath, position);
    if (!renameInfo.canRename)
      return `Error: Cannot rename: ${renameInfo.localizedErrorMessage}`;

    if (renameInfo.displayName !== name)
      return `Error: Symbol at occurrence ${n} is "${renameInfo.displayName}", not "${name}". Check the file and retry.`;

    const locations = ls.findRenameLocations(
      filePath,
      position,
      false,
      false,
      false,
    );
    if (!locations?.length)
      return `Error: No references found for "${name}" in ${relative(process.cwd(), filePath)}`;

    const byFile = new Map<string, ts.RenameLocation[]>();
    for (const loc of locations) {
      if (!byFile.has(loc.fileName)) byFile.set(loc.fileName, []);
      byFile.get(loc.fileName)!.push(loc);
    }

    const results: string[] = [];

    for (const [fileName, locs] of byFile) {
      let content = await readFile(fileName, 'utf-8');
      const sorted = [...locs].sort(
        (a, b) => b.textSpan.start - a.textSpan.start,
      );
      for (const loc of sorted) {
        const { start, length } = loc.textSpan;
        content =
          content.slice(0, start) + newName + content.slice(start + length);
      }
      await writeFile(fileName, content, 'utf-8');
      results.push(`${locs.length} occurrence(s) in ${relative(process.cwd(), fileName)}`);
    }

    return `Renamed to "${newName}" across ${byFile.size} file(s):\n${results.join('\n')}`;
  },
};
