import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import type { Tool } from '../Agent';

export const editFileTool: Tool = {
  name: 'EditFile',
  description:
    'Edit a file by replacing an exact match of old_string with new_string. old_string must be unique in the file.',
  ttl: 3,
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path.' },
      old_string: {
        type: 'string',
        description: 'Exact text to find in the file.',
      },
      new_string: {
        type: 'string',
        description: 'Text to replace old_string with.',
      },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  callback: async ({ path, old_string, new_string }) => {
    const resolved = resolve(path);
    const content = await readFile(resolved, 'utf-8');

    const count = content.split(old_string).length - 1;
    if (count === 0) return `Error: old_string not found in ${path}`;
    if (count > 1)
      return `Error: old_string is not unique in ${path} (found ${count} matches)`;

    await writeFile(resolved, content.replace(old_string, new_string), 'utf-8');
    return `Successfully edited ${path}`;
  },
};
