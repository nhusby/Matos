import { rename, stat } from 'fs/promises';
import { resolve, relative } from 'path';
import type { Tool } from '../Agent';
import { findImporters } from './findImporters';

export const renameFileTool: Tool = {
  name: 'RenameFile',
  description:
    'Rename or move a file. For TypeScript and JavaScript files, also returns a list of files that import the old path so their imports can be updated.',
  ttl: 3,
  params: {
    type: 'object',
    properties: {
      oldPath: {
        type: 'string',
        description: 'Current absolute or relative file path.',
      },
      newPath: {
        type: 'string',
        description: 'New absolute or relative file path.',
      },
    },
    required: ['oldPath', 'newPath'],
  },
  callback: async ({
    oldPath,
    newPath,
  }: {
    oldPath: string;
    newPath: string;
  }) => {
    const resolvedOld = resolve(oldPath);
    const resolvedNew = resolve(newPath);

    if (!resolvedOld.startsWith(process.cwd())) {
      return 'Error: old path is outside the current working directory.';
    }
    if (!resolvedNew.startsWith(process.cwd())) {
      return 'Error: new path is outside the current working directory.';
    }

    const oldStat = await stat(resolvedOld).catch(() => null);
    if (!oldStat) return `Error: ${oldPath} does not exist.`;
    if (oldStat.isDirectory())
      return `Error: ${oldPath} is a directory. This tool only renames files.`;

    const newStat = await stat(resolvedNew).catch(() => null);
    if (newStat) return `Error: ${newPath} already exists.`;

    // Find importers before renaming (non-blocking — errors here shouldn't prevent renaming)
    let importers: string[] = [];
    try {
      importers = await findImporters(resolvedOld);
    } catch {}

    await rename(resolvedOld, resolvedNew);

    const relOld = relative(process.cwd(), resolvedOld);
    const relNew = relative(process.cwd(), resolvedNew);

    let result = `Successfully renamed ${relOld} -> ${relNew}`;
    if (importers.length > 0) {
      result += `\n\nThe following files import ${relOld} and may need their import paths updated:\n${importers.join('\n')}`;
    }
    return result;
  },
};
