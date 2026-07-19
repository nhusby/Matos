import { test, expect } from 'bun:test';
import {
  parseLlmDecision,
  llmDecideApproval,
} from '../../lib/approval/llmApproval.js';
import type { Api } from '../../lib/Agent.js';

// ------------------------------------------------------------- parseLlmDecision

test('parseLlmDecision: returns the matching keyword', () => {
  expect(parseLlmDecision('APPROVE')).toBe('approve');
  expect(parseLlmDecision('REJECT')).toBe('reject');
  expect(parseLlmDecision('PROMPT')).toBe('prompt');
});

test('parseLlmDecision: is case-insensitive', () => {
  expect(parseLlmDecision('approve')).toBe('approve');
  expect(parseLlmDecision('Reject')).toBe('reject');
  expect(parseLlmDecision('Prompt')).toBe('prompt');
});

test('parseLlmDecision: ignores surrounding prose', () => {
  expect(parseLlmDecision('The answer is: APPROVE.')).toBe('approve');
  expect(parseLlmDecision('I think REJECT is safest here.')).toBe('reject');
});

test('parseLlmDecision: picks the FIRST keyword when multiple appear', () => {
  // e.g. "PROMPT (not APPROVE)" should classify as prompt.
  expect(parseLlmDecision('PROMPT not APPROVE')).toBe('prompt');
  expect(parseLlmDecision('approve reject prompt')).toBe('approve');
});

test('parseLlmDecision: defaults to prompt on unrecognised text', () => {
  expect(parseLlmDecision('')).toBe('prompt');
  expect(parseLlmDecision('maybe?')).toBe('prompt');
  expect(parseLlmDecision('   \n  ')).toBe('prompt');
});

// ---------------------------------------------------------------- llmDecideApproval

/** Build a mock Api whose chat completion returns `content`. */
function mockApi(content: string | null): Api {
  return {
    _models: ['test-model'],
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { role: 'assistant', content } }],
        }),
      },
    },
  } as unknown as Api;
}

test('llmDecideApproval: returns the LLM decision', async () => {
  const decision = await llmDecideApproval(
    { api: mockApi('APPROVE'), model: 'test-model' },
    'ls -la',
  );
  expect(decision).toBe('approve');
});

test('llmDecideApproval: forwards the command as the user message', async () => {
  let captured: any;
  const api = {
    _models: ['test-model'],
    chat: {
      completions: {
        create: async (params: any) => {
          captured = params;
          return { choices: [{ message: { content: 'REJECT' } }] };
        },
      },
    },
  } as unknown as Api;

  await llmDecideApproval({ api, model: 'test-model' }, 'rm -rf /tmp/x');

  expect(captured.model).toBe('test-model');
  expect(captured.temperature).toBe(0);
  const userMsg = captured.messages.at(-1);
  expect(userMsg.role).toBe('user');
  expect(userMsg.content).toBe('rm -rf /tmp/x');
});

test('llmDecideApproval: falls back to prompt on empty content', async () => {
  const decision = await llmDecideApproval(
    { api: mockApi(null), model: 'test-model' },
    'something',
  );
  expect(decision).toBe('prompt');
});

test('llmDecideApproval: falls back to prompt when the API throws', async () => {
  const api = {
    _models: ['test-model'],
    chat: {
      completions: {
        create: async () => {
          throw new Error('network down');
        },
      },
    },
  } as unknown as Api;

  const decision = await llmDecideApproval(
    { api, model: 'test-model' },
    'ls',
  );
  // A broken classifier must never auto-approve — safe fallback is prompt.
  expect(decision).toBe('prompt');
});

test('llmDecideApproval: honours a custom prompt override', async () => {
  let captured: any;
  const api = {
    _models: ['test-model'],
    chat: {
      completions: {
        create: async (params: any) => {
          captured = params;
          return { choices: [{ message: { content: 'PROMPT' } }] };
        },
      },
    },
  } as unknown as Api;

  await llmDecideApproval(
    { api, model: 'test-model', prompt: 'custom instructions' },
    'x',
  );

  expect(captured.messages[0].content).toBe('custom instructions');
});
