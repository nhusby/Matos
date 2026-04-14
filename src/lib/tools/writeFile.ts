import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import type { Tool } from '../Agent';

export const writeFileTool: Tool = {
  name: 'WriteFile',
  description: 'Write content to a file, creating it if it does not exist.',
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path.' },
      content: { type: 'string', description: 'Content to write to the file.' },
    },
    required: ['path', 'content'],
  },
  callback: async ({ path, content }) => {
    await writeFile(resolve(path), content, 'utf-8');
    return `Successfully wrote to ${path}`;
  },
};
