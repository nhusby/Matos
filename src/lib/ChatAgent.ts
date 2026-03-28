import { readFile } from 'fs/promises';
import { Agent } from './Agent';
import type { Tool } from './Agent';

const readFileTool: Tool = {
  name: 'ReadFile',
  description: 'Read the contents of a file at the given path.',
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path.' },
    },
    required: ['path'],
  },
  callback: async ({ path }) => readFile(path, 'utf-8'),
};

const helloWorldTool: Tool = {
  name: 'HelloWorld',
  description: 'Returns a greeting.',
  params: {
    type: 'object',
    properties: {},
  },
  callback: async ({ name }) => `Hello, world!`,
};

export class ChatAgent extends Agent {
  tools = [readFileTool, helloWorldTool];
}
