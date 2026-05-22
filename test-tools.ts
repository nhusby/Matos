import { pruneContext } from './src/lib/ContextPruner.js';
import type { Api, Message, Tool, ToolPart } from './src/lib/Agent.js';

// Mock tool that tracks if it was called (not used in pruning, but needed for config)
const createMockTool = (name: string, ttl?: number, summarize?: boolean): Tool => ({
  name,
  description: `Mock tool ${name}`,
  callback: async () => 'mock result',
  ttl,
  summarize,
});

// Mock API that doesn't actually call OpenAI
const createMockApi = (): Api => {
  const api = {
    _models: ['gpt-4o', 'gpt-3.5-turbo'],
    chat: {
      completions: {
        create: async (params: any) => {
          console.log(`[MOCK API] Would call OpenAI with model: ${params.model}`);
          return {
            choices: [{
              message: { role: 'assistant', content: `Summarized: This is a mock summary of a tool call.` }
            }]
          };
        }
      }
    },
    models: {
      list: async () => ({
        iterPages: async function* () {
          yield [{ getPaginatedItems: () => [] }];
        }
      })
    }
  } as unknown as Api;
  return api;
};

// Helper to create a simple message
const makeMessage = (role: Message['role'], content: string, parts?: any[]): Message => ({
  role,
  content,
  parts,
  created: new Date(),
});

// Helper to create an agent part with tool calls
const makeAgentPart = (content: string, toolCalls?: any[]): any => ({
  role: 'assistant' as const,
  content,
  reasoningContent: '',
  toolCalls,
});

// Helper to create a tool result part
const makeToolPart = (name: string, content: string, toolCallId: string): ToolPart => ({
  role: 'tool',
  name,
  content,
  toolCallId,
});

let passed = 0;
let failed = 0;

const test = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (e: any) {
    console.error(`❌ FAIL: ${name}`);
    console.error(`   Error: ${e.message}`);
    failed++;
  }
};

// ============================================================
// TESTS
// ============================================================

await test('removes tool calls older than TTL when summarize is false', async () => {
  const tools = [createMockTool('read_file', 2, false)]; // TTL of 2 turns
  
  // Create a mock message structure simulating an old conversation
  const messages: Message[] = [
    makeMessage('system', 'You are a helpful assistant'),
    makeMessage('user', 'Read this file for me'),
  ];
  
  // Old assistant turn (turn index 0) with tool call and result
  const oldAssistantMsg: Message = {
    role: 'assistant',
    content: 'Reading...',
    parts: [
      makeAgentPart('Let me read that.', [
        { id: 'call_1', name: 'read_file', params: { path: '/test.txt' }, _argStr: '{"path":"/test.txt"}' }
      ]),
      makeToolPart('read_file', '<file contents>', 'call_1')
    ],
    created: new Date(),
  };
  messages.push(oldAssistantMsg);
  
  // Current assistant turn (turn index 1) - this is the "current" one being pruned against
  const currentAssistantMsg: Message = makeMessage('assistant', 'I see the file.', [
    makeAgentPart('I see the file.')
  ]);
  messages.push(currentAssistantMsg);

  // Total turns = 2 (two assistant messages)
  // Old tool part age = 2 - 0 = 2, which is > TTL of 2... wait, need to check logic
  
  await pruneContext(messages, tools);
  
  // The old tool result should be removed (age > ttl)
  const oldMsgParts = oldAssistantMsg.parts!;
  const hasToolResult = oldMsgParts.some(p => p.role === 'tool');
  if (hasToolResult) {
    throw new Error('Tool result should have been pruned');
  }
});

await test('keeps tool calls within TTL', async () => {
  const tools = [createMockTool('read_file', 5, false)]; // TTL of 5 turns
  
  const messages: Message[] = [
    makeMessage('system', 'You are a helpful assistant'),
    makeMessage('user', 'Read this file for me'),
  ];
  
  const oldAssistantMsg: Message = makeMessage('assistant', 'Reading...', [
    makeAgentPart('Let me read that.', [
      { id: 'call_1', name: 'read_file', params: { path: '/test.txt' } }
    ]),
    makeToolPart('read_file', '<file contents>', 'call_1')
  ]);
  messages.push(oldAssistantMsg);
  
  // Only one assistant turn so far, age = 1 - 0 = 1, TTL is 5
  // Should NOT be pruned

  await pruneContext(messages, tools);
  
  const oldMsgParts = oldAssistantMsg.parts!;
  const hasToolResult = oldMsgParts.some(p => p.role === 'tool' && p.toolCallId === 'call_1');
  if (!hasToolResult) {
    throw new Error('Tool result should still be present (within TTL)');
  }
});

await test('removes reasoning content from messages older than 3 turns', async () => {
  const tools: Tool[] = []; // No tools needed for this test
  
  const messages: Message[] = [
    makeMessage('system', 'You are a helpful assistant'),
    makeMessage('user', 'Question 1?'),
    makeMessage('assistant', 'Answer 1.', [{ role: 'assistant', content: '', reasoningContent: 'thinking...' }]),
    makeMessage('user', 'Question 2?'),
    makeMessage('assistant', 'Answer 2.', [{ role: 'assistant', content: '', reasoningContent: 'thinking again...' }]),
    makeMessage('user', 'Question 3?'),
    makeMessage('assistant', 'Answer 3.', [{ role: 'assistant', content: '', reasoningContent: 'third time thinking...' }]),
    makeMessage('user', 'Question 4?'),
    makeMessage('assistant', 'Answer 4.', [{ role: 'assistant', content: '', reasoningContent: 'fourth time thinking...' }]),
  ];

  await pruneContext(messages, tools);
  
  // First assistant message (turn 0) should have reasoning removed (age = 4 - 0 = 4 > 3)
  const firstAssistant = messages.find((m, i) => m.role === 'assistant' && i === 2);
  if (firstAssistant?.parts?.[0] && 'reasoningContent' in firstAssistant.parts[0]) {
    throw new Error('Old reasoning content should have been removed');
  }
  
  // Last assistant message (turn 4) should keep reasoning (age = 5 - 4 = 1 <= 3)
  const lastAssistant = messages[messages.length - 1];
  if (!lastAssistant?.parts?.[0]?.reasoningContent) {
    throw new Error('Recent reasoning content should be kept');
  }
});

await test('summarizes tool calls when summarize flag is true', async () => {
  const api = createMockApi();
  const tools = [createMockTool('web_search', 2, true)]; // TTL of 2, summarize: true
  
  const messages: Message[] = [
    makeMessage('system', 'You are a helpful assistant'),
    makeMessage('user', 'Search for something'),
  ];
  
  const oldAssistantMsg: Message = makeMessage('assistant', 'Searching...', [
    makeAgentPart('Let me search.', [
      { id: 'call_2', name: 'web_search', params: { query: 'weather' } }
    ]),
    makeToolPart('web_search', '{"temp": "72°F", "condition": "sunny"}', 'call_2')
  ]);
  messages.push(oldAssistantMsg);
  
  const currentAssistantMsg: Message = makeMessage('assistant', 'Got the weather.', [
    makeAgentPart('Got the weather.')
  ]);
  messages.push(currentAssistantMsg);

  await pruneContext(messages, tools, { api, model: 'gpt-4o' });
  
  // The tool result should be replaced with a system message containing summary
  const oldMsgParts = oldAssistantMsg.parts!;
  const hasSystemPart = oldMsgParts.some(p => p.role === 'system');
  if (!hasSystemPart) {
    throw new Error('Tool result should have been replaced with system summary');
  }
  
  // Original tool entry should be gone
  const hasToolResult = oldMsgParts.some(p => p.role === 'tool');
  if (hasToolResult) {
    throw new Error('Original tool result should be removed when summarizing');
  }
});

await test('handles messages without parts gracefully', async () => {
  const tools: Tool[] = [];
  
  const messages: Message[] = [
    makeMessage('system', 'System prompt'),
    makeMessage('user', 'Hello'),
    makeMessage('assistant', 'Hi there!'), // No parts array
    makeMessage('user', 'How are you?'),
    makeMessage('assistant', 'I\'m good!'),
  ];

  await pruneContext(messages, tools);
  
  // Should not throw and messages should remain unchanged (no parts to process)
  if (messages.length !== 5) {
    throw new Error('Message count changed unexpectedly');
  }
});

await test('handles empty message array', async () => {
  const tools: Tool[] = [];
  const messages: Message[] = [];

  await pruneContext(messages, tools);
  
  if (messages.length !== 0) {
    throw new Error('Empty array should stay empty');
  }
});

await test('removes tool call references from assistant parts', async () => {
  const tools = [createMockTool('read_file', 1, false)]; // TTL of 1 turn
  
  const messages: Message[] = [
    makeMessage('system', 'You are a helpful assistant'),
    makeMessage('user', 'Read this file'),
  ];
  
  const oldAssistantMsg: Message = makeMessage('assistant', 'Reading...', [
    makeAgentPart('Let me read that.', [
      { id: 'call_ref', name: 'read_file', params: { path: '/test.txt' } }
    ]),
    makeToolPart('read_file', '<file contents>', 'call_ref')
  ]);
  messages.push(oldAssistantMsg);
  
  const currentAssistantMsg: Message = makeMessage('assistant', 'Done.', [
    makeAgentPart('Done.')
  ]);
  messages.push(currentAssistantMsg);

  await pruneContext(messages, tools);
  
  // The tool result is removed (age >= ttl), so the reference should also be cleaned up
  const oldMsgParts = oldAssistantMsg.parts!;
  const agentPart = oldMsgParts.find(p => p.role === 'assistant') as any;
  
  if (agentPart?.toolCalls && agentPart.toolCalls.length > 0) {
    throw new Error('Tool call references should be cleaned up when result is pruned');
  }
});

await test('preserves tool calls with no TTL config', async () => {
  const tools = [createMockTool('read_file')]; // No TTL set
  
  const messages: Message[] = [
    makeMessage('system', 'You are a helpful assistant'),
    makeMessage('user', 'Read this file'),
  ];
  
  const oldAssistantMsg: Message = makeMessage('assistant', 'Reading...', [
    makeAgentPart('Let me read that.', [
      { id: 'call_nottl', name: 'read_file', params: { path: '/test.txt' } }
    ]),
    makeToolPart('read_file', '<file contents>', 'call_nottl')
  ]);
  messages.push(oldAssistantMsg);
  
  const currentAssistantMsg: Message = makeMessage('assistant', 'Done.', [
    makeAgentPart('Done.')
  ]);
  messages.push(currentAssistantMsg);

  await pruneContext(messages, tools);
  
  // No TTL means tool should never be pruned
  const oldMsgParts = oldAssistantMsg.parts!;
  const hasToolResult = oldMsgParts.some(p => p.role === 'tool' && p.toolCallId === 'call_nottl');
  if (!hasToolResult) {
    throw new Error('Tool without TTL config should never be pruned');
  }
});

// ============================================================
// RESULTS
// ============================================================
console.log('\n========================================');
console.log(`Tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
console.log('========================================\n');

process.exit(failed > 0 ? 1 : 0);
