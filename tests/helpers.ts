import type { Api, Message, Tool, ToolPart } from '../src/lib/Agent.js';

export const createMockTool = (
  name: string,
  ttl?: number,
  summarize?: boolean,
): Tool => ({
  name,
  description: `Mock tool ${name}`,
  callback: async () => 'mock result',
  ttl,
  summarize,
});

export const createMockApi = (): Api => {
  return {
    _models: ['gpt-4o', 'gpt-3.5-turbo'],
    chat: {
      completions: {
        create: async (params: any) => {
          console.log(
            `[MOCK API] Would call OpenAI with model: ${params.model}`,
          );
          return {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: `Summarized: This is a mock summary of a tool call.`,
                },
              },
            ],
          };
        },
      },
    },
    models: {
      list: async () => ({
        iterPages: async function* () {
          yield [{ getPaginatedItems: () => [] }];
        },
      }),
    },
  } as unknown as Api;
};

export const makeMessage = (
  role: Message['role'],
  content: string,
  parts?: any[],
): Message => ({
  role,
  content,
  parts,
  created: new Date(),
});

export const makeAgentPart = (content: string, toolCalls?: any[]): any => ({
  role: 'assistant' as const,
  content,
  reasoningContent: '',
  toolCalls,
});

export const makeToolPart = (
  name: string,
  content: string,
  toolCallId: string,
): ToolPart => ({
  role: 'tool',
  name,
  content,
  toolCallId,
});
