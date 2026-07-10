import { readFile } from 'fs/promises';
import { resolve } from 'path';
import type { Tool } from '../Agent';

export interface ReadFileConfig {
  bypassCwd?: boolean;
}

export const createReadFileTool = (config: ReadFileConfig = {}): Tool => ({
  name: 'ReadFile',
  description: 'Read the contents of a file at the given path.',
  ttl: 3,
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path.' },
    },
    required: ['path'],
  },
  callback: async ({ path }) => {
    const resolved = resolve(path);
    if (!config.bypassCwd && !resolved.startsWith(process.cwd())) {
      return 'Error: path is outside the current working directory.';
    }
    return readFile(resolved, 'utf-8');
  },
});
