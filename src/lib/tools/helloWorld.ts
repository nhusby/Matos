import type { Tool } from '../Agent';

export const helloWorldTool: Tool = {
  name: 'HelloWorld',
  description: 'Returns a greeting.',
  params: {
    type: 'object',
    properties: {},
  },
  callback: async () => `Hello, world!`,
};
