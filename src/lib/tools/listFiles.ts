import { readdir } from 'fs/promises';
import { resolve } from 'path';
import { homedir } from 'os';
import type { Tool } from '../Agent';

export interface ListFilesConfig {
  bypassCwd?: boolean;
}

export const createListFilesTool = (config: ListFilesConfig = {}): Tool => ({
  name: 'ListFiles',
  description:
    'List files and directories at the given path. Directories have a trailing slash.',
  ttl: 3,
  params: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path. Defaults to current working directory.',
      },
    },
  },
  callback: async ({ path: dirPath }: { path?: string }) => {
    const expanded = dirPath?.startsWith('~')
      ? dirPath.replace('~', homedir())
      : dirPath;
    const resolved = resolve(expanded ?? process.cwd());
    if (!config.bypassCwd && !resolved.startsWith(process.cwd())) {
      return 'Error: path is outside the current working directory.';
    }
    const entries = await readdir(resolved, { withFileTypes: true });
    return entries
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      })
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .join('\n');
  },
});
