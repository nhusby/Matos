import { resolve, relative } from 'path';
import type { Tool } from '../Agent';
import { pickRenameBackend, applyRenameResult } from '../lsp/backends.js';

export const renameSymbolTool: Tool = {
  name: 'RenameSymbol',
  description:
    'Rename a symbol (variable, class, interface, property, function, etc.) across all files in the project. TS/JS uses the TypeScript Language Service; Go/Python/Perl require an LSP server configured in ~/.matos/config.json.',
  ttl: 3,
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

    let result;
    try {
      const backend = pickRenameBackend(filePath);
      result = await backend.findEdits(filePath, n, name, newName);
    } catch (e: any) {
      return `Error: ${e.message}`;
    }

    if (result.byFile.size === 0) {
      return `Error: No references found for "${name}" in ${relative(process.cwd(), filePath)}`;
    }

    const summary = await applyRenameResult(result);
    return `Renamed to "${newName}" across ${result.byFile.size} file(s):\n${summary.join('\n')}`;
  },
};
