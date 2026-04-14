import { readFile } from 'fs/promises';
import { resolve } from 'path';
import type { Tool } from '../Agent';

export const readFileTool: Tool = {
  name: 'ReadFile',
  description: 'Read the contents of a file at the given path.',
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path.' },
    },
    required: ['path'],
  },
  callback: async ({ path }) => readFile(resolve(path), 'utf-8'),
};
