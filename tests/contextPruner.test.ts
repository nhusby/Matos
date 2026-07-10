import { test, expect } from 'bun:test';
import { pruneContext } from '../src/lib/ContextPruner.js';
import type { Message, Tool } from '../src/lib/Agent.js';
import {
  createMockApi,
  createMockTool,
  makeAgentPart,
  makeMessage,
  makeToolPart,
} from './helpers.js';

test('removes tool calls older than TTL when summarize is false', async () => {
  const tools = [createMockTool('read_file', 2, false)];

  const messages: Message[] = [
    makeMessage('system', 'You are a helpful assistant'),
    makeMessage('user', 'Read this file for me'),
  ];

  const oldAssistantMsg: Message = {
    role: 'assistant',
    content: 'Reading...',
    parts: [
      makeAgentPart('Let me read that.', [
        {
          id: 'call_1',
          name: 'read_file',
          params: { path: '/test.txt' },
          _argStr: '{"path":"/test.txt"}',
        },
      ]),
      makeToolPart('read_file', '<file contents>', 'call_1'),
    ],
    created: new Date(),
  };
  messages.push(oldAssistantMsg);

  const currentAssistantMsg = makeMessage('assistant', 'I see the file.', [
    makeAgentPart('I see the file.'),
  ]);
  messages.push(currentAssistantMsg);

  await pruneContext(messages, tools);

  const oldMsgParts = oldAssistantMsg.parts!;
  expect(oldMsgParts.some((p) => p.role === 'tool')).toBe(false);
});

test('keeps tool calls within TTL', async () => {
  const tools = [createMockTool('read_file', 5, false)];

  const messages: Message[] = [
    makeMessage('system', 'You are a helpful assistant'),
    makeMessage('user', 'Read this file for me'),
  ];

  const oldAssistantMsg = makeMessage('assistant', 'Reading...', [
    makeAgentPart('Let me read that.', [
      { id: 'call_1', name: 'read_file', params: { path: '/test.txt' } },
    ]),
    makeToolPart('read_file', '<file contents>', 'call_1'),
  ]);
  messages.push(oldAssistantMsg);

  await pruneContext(messages, tools);

  const oldMsgParts = oldAssistantMsg.parts!;
  expect(
    oldMsgParts.some(
      (p) => p.role === 'tool' && p.toolCallId === 'call_1',
    ),
  ).toBe(true);
});

test('removes reasoning content from messages older than 3 turns', async () => {
  const tools: Tool[] = [];

  const messages: Message[] = [
    makeMessage('system', 'You are a helpful assistant'),
    makeMessage('user', 'Question 1?'),
    makeMessage('assistant', 'Answer 1.', [
      { role: 'assistant', content: '', reasoningContent: 'thinking...' },
    ]),
    makeMessage('user', 'Question 2?'),
    makeMessage('assistant', 'Answer 2.', [
      { role: 'assistant', content: '', reasoningContent: 'thinking again...' },
    ]),
    makeMessage('user', 'Question 3?'),
    makeMessage('assistant', 'Answer 3.', [
      {
        role: 'assistant',
        content: '',
        reasoningContent: 'third time thinking...',
      },
    ]),
    makeMessage('user', 'Question 4?'),
    makeMessage('assistant', 'Answer 4.', [
      {
        role: 'assistant',
        content: '',
        reasoningContent: 'fourth time thinking...',
      },
    ]),
  ];

  await pruneContext(messages, tools);

  const firstAssistant = messages.find(
    (m, i) => m.role === 'assistant' && i === 2,
  );
  if (firstAssistant?.parts?.[0]) {
    expect('reasoningContent' in firstAssistant.parts[0]).toBe(false);
  }

  const lastAssistant = messages[messages.length - 1];
  expect(lastAssistant?.parts?.[0]?.reasoningContent).toBeTruthy();
});

test('summarizes tool calls when summarize flag is true', async () => {
  const api = createMockApi();
  const tools = [createMockTool('web_search', 2, true)];

  const messages: Message[] = [
    makeMessage('system', 'You are a helpful assistant'),
    makeMessage('user', 'Search for something'),
  ];

  const oldAssistantMsg = makeMessage('assistant', 'Searching...', [
    makeAgentPart('Let me search.', [
      { id: 'call_2', name: 'web_search', params: { query: 'weather' } },
    ]),
    makeToolPart(
      'web_search',
      '{"temp": "72°F", "condition": "sunny"}',
      'call_2',
    ),
  ]);
  messages.push(oldAssistantMsg);

  const currentAssistantMsg = makeMessage('assistant', 'Got the weather.', [
    makeAgentPart('Got the weather.'),
  ]);
  messages.push(currentAssistantMsg);

  await pruneContext(messages, tools, { api, model: 'gpt-4o' });

  const oldMsgParts = oldAssistantMsg.parts!;
  expect(oldMsgParts.some((p) => p.role === 'system')).toBe(true);
  expect(oldMsgParts.some((p) => p.role === 'tool')).toBe(false);
});

test('handles messages without parts gracefully', async () => {
  const tools: Tool[] = [];

  const messages: Message[] = [
    makeMessage('system', 'System prompt'),
    makeMessage('user', 'Hello'),
    makeMessage('assistant', 'Hi there!'),
    makeMessage('user', 'How are you?'),
    makeMessage('assistant', "I'm good!"),
  ];

  await pruneContext(messages, tools);

  expect(messages.length).toBe(5);
});

test('handles empty message array', async () => {
  const tools: Tool[] = [];
  const messages: Message[] = [];

  await pruneContext(messages, tools);

  expect(messages.length).toBe(0);
});

test('removes tool call references from assistant parts', async () => {
  const tools = [createMockTool('read_file', 1, false)];

  const messages: Message[] = [
    makeMessage('system', 'You are a helpful assistant'),
    makeMessage('user', 'Read this file'),
  ];

  const oldAssistantMsg = makeMessage('assistant', 'Reading...', [
    makeAgentPart('Let me read that.', [
      { id: 'call_ref', name: 'read_file', params: { path: '/test.txt' } },
    ]),
    makeToolPart('read_file', '<file contents>', 'call_ref'),
  ]);
  messages.push(oldAssistantMsg);

  const currentAssistantMsg = makeMessage('assistant', 'Done.', [
    makeAgentPart('Done.'),
  ]);
  messages.push(currentAssistantMsg);

  await pruneContext(messages, tools);

  const oldMsgParts = oldAssistantMsg.parts!;
  const agentPart = oldMsgParts.find((p) => p.role === 'assistant') as any;
  expect(agentPart?.toolCalls?.length ?? 0).toBe(0);
});

test('preserves tool calls with no TTL config', async () => {
  const tools = [createMockTool('read_file')];

  const messages: Message[] = [
    makeMessage('system', 'You are a helpful assistant'),
    makeMessage('user', 'Read this file'),
  ];

  const oldAssistantMsg = makeMessage('assistant', 'Reading...', [
    makeAgentPart('Let me read that.', [
      { id: 'call_nottl', name: 'read_file', params: { path: '/test.txt' } },
    ]),
    makeToolPart('read_file', '<file contents>', 'call_nottl'),
  ]);
  messages.push(oldAssistantMsg);

  const currentAssistantMsg = makeMessage('assistant', 'Done.', [
    makeAgentPart('Done.'),
  ]);
  messages.push(currentAssistantMsg);

  await pruneContext(messages, tools);

  const oldMsgParts = oldAssistantMsg.parts!;
  expect(
    oldMsgParts.some(
      (p) => p.role === 'tool' && p.toolCallId === 'call_nottl',
    ),
  ).toBe(true);
});
