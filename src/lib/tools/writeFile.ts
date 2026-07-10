import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import type { Tool } from '../Agent';
import { lspManager } from '../lsp/manager.js';

export interface WriteFileConfig {
  bypassCwd?: boolean;
}

export const createWriteFileTool = (config: WriteFileConfig = {}): Tool => ({
  name: 'WriteFile',
  description: 'Write content to a file, creating it if it does not exist.',
  ttl: 3,
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path.' },
      content: { type: 'string', description: 'Content to write to the file.' },
    },
    required: ['path', 'content'],
  },
  callback: async ({ path, content }) => {
    const resolved = resolve(path);
    if (!config.bypassCwd && !resolved.startsWith(process.cwd())) {
      return 'Error: path is outside the current working directory.';
    }
    await writeFile(resolved, content, 'utf-8');
    await lspManager.notifyWrote(resolved, content);
    return `Successfully wrote to ${path}`;
  },
});
