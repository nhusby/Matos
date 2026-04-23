import { unlink, stat } from 'fs/promises';
import { resolve, relative } from 'path';
import type { Tool } from '../Agent';
import { findImporters } from './findImporters';

export const deleteFileTool: Tool = {
  name: 'DeleteFile',
  description:
    'Delete a file. For TypeScript and JavaScript files, also returns a list of files that import the deleted file so they can be updated.',
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path to delete.' },
    },
    required: ['path'],
  },
  callback: async ({ path }: { path: string }) => {
    const resolved = resolve(path);
    if (!resolved.startsWith(process.cwd())) {
      return 'Error: path is outside the current working directory.';
    }

    const fileStat = await stat(resolved).catch(() => null);
    if (!fileStat) return `Error: ${path} does not exist.`;
    if (fileStat.isDirectory()) return `Error: ${path} is a directory. Use a different approach to delete directories.`;

    // Find importers before deleting (non-blocking — errors here shouldn't prevent deletion)
    let importers: string[] = [];
    try { importers = await findImporters(resolved); } catch {}

    await unlink(resolved);
    const relPath = relative(process.cwd(), resolved);

    let result = `Successfully deleted ${relPath}`;
    if (importers.length > 0) {
      result += `\n\nThe following files import ${relPath} and may need to be updated:\n${importers.join('\n')}`;
    }
    return result;
  },
};
