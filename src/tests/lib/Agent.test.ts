import { test, expect, describe } from 'bun:test';
import {
  Agent,
  type Api,
  type Message,
  type Tool,
  type ToolPart,
  type AgentPart,
} from '../../lib/Agent';
import { makeMessage } from '../helpers';

/* -------------------------------------------------------------------------- */
/*  Streaming mock API                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A single simulated streaming chunk.  Each field maps to the corresponding
 * OpenAI streaming delta field.
 */
interface MockChunk {
  content?: string;
  reasoning?: string;
  refusal?: string;
  toolCalls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
  finishReason?: string | null;
  /** When set, the iterator throws this error instead of yielding the chunk. */
  throw?: { name?: string; message: string };
}

/**
 * Builds a mock Api whose `chat.completions.create` returns an async iterable
 * over the chunks produced by `nextTurn()`.  Each call to `create` invokes
 * `nextTurn()` once, so tests control the sequence of streaming turns via a
 * closure-managed counter.
 *
 * The returned object also exposes a `calls` array capturing every params
 * object passed to `create`, enabling assertions about model, tools, and
 * messages.
 */
function createStreamApi(opts: {
  nextTurn: () => MockChunk[];
  models?: string[];
}): Api & { calls: any[] } {
  const calls: any[] = [];
  const modelsList = opts.models ?? ['m1'];

  const api: any = {
    _models: modelsList.slice(),
    chat: {
      completions: {
        create: async (params: any) => {
          calls.push(params);
          const turn = opts.nextTurn();
          let i = 0;
          return {
            [Symbol.asyncIterator]() {
              return {
                next: async (): Promise<IteratorResult<any>> => {
                  if (i >= turn.length) {
                    return { value: undefined, done: true };
                  }
                  const c = turn[i++]!;
                  if (c.throw) {
                    const err: any = new Error(c.throw.message);
                    if (c.throw.name) err.name = c.throw.name;
                    throw err;
                  }
                  const delta: any = {};
                  if (c.content !== undefined) delta.content = c.content;
                  if (c.reasoning !== undefined)
                    delta.reasoning_content = c.reasoning;
                  if (c.refusal !== undefined) delta.refusal = c.refusal;
                  if (c.toolCalls) delta.tool_calls = c.toolCalls;
                  return {
                    value: {
                      choices: [
                        {
                          index: 0,
                          delta,
                          finish_reason: c.finishReason ?? null,
                        },
                      ],
                    },
                    done: false,
                  };
                },
              };
            },
          };
        },
      },
    },
    models: {
      list: async () => ({
        iterPages: async function* () {
          yield {
            getPaginatedItems: () => modelsList.map((id) => ({ id })),
          };
        },
      }),
    },
  };

  api.calls = calls;
  return api as Api & { calls: any[] };
}

/** Convenience: a turn that yields content then stops. */
const contentTurn = (text: string): MockChunk[] => [
  { content: text, finishReason: 'stop' },
];

/* -------------------------------------------------------------------------- */

describe('Agent', () => {
  /* ----------------------------- constructor ----------------------------- */

  describe('constructor & getters', () => {
    test('accepts a single api and model', () => {
      const api = createStreamApi({ nextTurn: () => [] });
      const agent = new Agent({ api, model: 'm1' });
      expect(agent.api).toBe(api);
      expect(agent.model).toBe('m1');
    });

    test('accepts an array of apis and models', () => {
      const api1 = createStreamApi({ nextTurn: () => [], models: ['m1'] });
      const api2 = createStreamApi({ nextTurn: () => [], models: ['m2'] });
      const agent = new Agent({ api: [api1, api2], model: ['m1', 'm2'] });
      // api getter returns the first api before any streaming round-robins.
      expect(agent.api).toBe(api1);
    });

    test('defaults tools to an empty array and systemPrompt to undefined', () => {
      const api = createStreamApi({ nextTurn: () => [] });
      const agent = new Agent({ api, model: 'm1' });
      expect(agent.tools).toEqual([]);
      expect(agent.systemPrompt).toBeUndefined();
      expect(agent.messages).toEqual([]);
      expect(agent.readFiles).toBeInstanceOf(Set);
      expect(agent.readFiles.size).toBe(0);
    });

    test('model getter returns the first model that the current api supports', () => {
      const api = createStreamApi({ nextTurn: () => [], models: ['b', 'a'] });
      const agent = new Agent({ api, model: ['a', 'b', 'c'] });
      // 'a' is in ['b','a'] → returned first.
      expect(agent.model).toBe('a');
    });

    test('model getter falls back to models[0] when no model is supported by the api', () => {
      const api = createStreamApi({ nextTurn: () => [], models: ['x'] });
      const agent = new Agent({ api, model: ['a', 'b'] });
      expect(agent.model).toBe('a');
    });
  });

  /* -------------------------------- init() ------------------------------- */

  describe('init()', () => {
    test('populates _models from api.models.list()', async () => {
      const api = createStreamApi({ nextTurn: () => [], models: ['m1', 'm2'] });
      api._models = []; // simulate pre-init state
      const agent = new Agent({ api, model: 'm1' });
      await agent.init();
      expect(agent.api._models).toEqual(['m1', 'm2']);
    });

    test('populates _models for every api in an array', async () => {
      const api1 = createStreamApi({
        nextTurn: () => [],
        models: ['a1', 'a2'],
      });
      const api2 = createStreamApi({ nextTurn: () => [], models: ['b1'] });
      api1._models = [];
      api2._models = [];
      const agent = new Agent({ api: [api1, api2], model: 'a1' });
      await agent.init();
      expect(api1._models).toEqual(['a1', 'a2']);
      expect(api2._models).toEqual(['b1']);
    });

    test('aggregates models across multiple paginated responses', async () => {
      const api: any = {
        _models: [],
        chat: {
          completions: {
            create: async () => ({
              [Symbol.asyncIterator]() {
                return { next: async () => ({ done: true }) };
              },
            }),
          },
        },
        models: {
          list: async () => ({
            iterPages: async function* () {
              yield { getPaginatedItems: () => [{ id: 'p1a' }, { id: 'p1b' }] };
              yield { getPaginatedItems: () => [{ id: 'p2a' }] };
            },
          }),
        },
      };
      const agent = new Agent({ api, model: 'p1a' });
      await agent.init();
      expect(api._models).toEqual(['p1a', 'p1b', 'p2a']);
    });

    test('returns the agent instance for chaining', async () => {
      const api = createStreamApi({ nextTurn: () => [], models: ['m1'] });
      const agent = new Agent({ api, model: 'm1' });
      expect(await agent.init()).toBe(agent);
    });
  });

  /* ------------------------- sendMessage streaming ------------------------ */

  describe('sendMessage streaming', () => {
    test('streams content tokens and emits start/finalizing/end in order', async () => {
      const api = createStreamApi({
        nextTurn: () => [
          { content: 'Hello', finishReason: null },
          { content: ' world', finishReason: 'stop' },
        ],
      });
      const agent = new Agent({ api, model: 'm1' });

      const events: string[] = [];
      const contents: string[] = [];
      const emitter = agent.sendMessage(makeMessage('user', 'hi'));
      emitter.on('start', () => {
        events.push('start');
      });
      emitter.on('content', (s) => {
        contents.push(s);
        events.push('content');
      });
      emitter.on('finalizing', () => {
        events.push('finalizing');
      });
      emitter.on('end', () => {
        events.push('end');
      });

      const response = await emitter.toPromise();

      expect(contents).toEqual(['Hello', ' world']);
      expect(response.content).toBe('Hello world');
      expect(response.role).toBe('assistant');
      expect(response.parts).toHaveLength(1);
      expect(response.parts![0]!.content).toBe('Hello world');
      expect(events).toEqual([
        'start',
        'content',
        'content',
        'finalizing',
        'end',
      ]);
      // user message + assistant response are pushed onto agent.messages
      expect(agent.messages).toHaveLength(2);
      expect(agent.messages[0]!.role).toBe('user');
      expect(agent.messages[1]).toBe(response);
    });

    test('emits reasoning events before content', async () => {
      const api = createStreamApi({
        nextTurn: () => [
          { reasoning: 'thinking...', finishReason: null },
          { content: 'answer', finishReason: 'stop' },
        ],
      });
      const agent = new Agent({ api, model: 'm1' });

      const events: string[] = [];
      const emitter = agent.sendMessage(makeMessage('user', 'hi'));
      emitter.on('reasoning-start', () => events.push('reasoning-start'));
      emitter.on('reasoning', (s) => events.push(`reasoning:${s}`));
      emitter.on('reasoning-finished', () => events.push('reasoning-finished'));
      emitter.on('content', (s) => events.push(`content:${s}`));

      const response = await emitter.toPromise();
      expect(events).toEqual([
        'reasoning-start',
        'reasoning:thinking...',
        'reasoning-finished',
        'content:answer',
      ]);
      expect(response.content).toBe('answer');
      expect(response.thinking).toBe(false);
    });

    test('reasoning without subsequent content does not emit reasoning-finished', async () => {
      // Documents current behavior: reasoning-finished is only emitted when a
      // content/refusal delta follows reasoning.  A reasoning-only turn leaves
      // thinking=true and never fires reasoning-finished.
      const api = createStreamApi({
        nextTurn: () => [{ reasoning: 'just thinking', finishReason: 'stop' }],
      });
      const agent = new Agent({ api, model: 'm1' });

      const events: string[] = [];
      const emitter = agent.sendMessage(makeMessage('user', 'hi'));
      emitter.on('reasoning-start', () => events.push('reasoning-start'));
      emitter.on('reasoning-finished', () => events.push('reasoning-finished'));

      await emitter.toPromise();
      expect(events).toEqual(['reasoning-start']);
    });

    test('handles refusal deltas as content', async () => {
      const api = createStreamApi({
        nextTurn: () => [{ refusal: 'I cannot help', finishReason: 'stop' }],
      });
      const agent = new Agent({ api, model: 'm1' });

      const contents: string[] = [];
      const emitter = agent.sendMessage(makeMessage('user', 'hi'));
      emitter.on('content', (s) => contents.push(s));

      const response = await emitter.toPromise();
      expect(contents).toEqual(['I cannot help']);
      expect(response.content).toBe('I cannot help');
    });

    test('includes the systemPrompt as the first message sent to the API', async () => {
      const api = createStreamApi({ nextTurn: () => contentTurn('ok') });
      const agent = new Agent({
        api,
        model: 'm1',
        systemPrompt: 'You are a robot',
      });
      await agent.sendMessage(makeMessage('user', 'hi')).toPromise();
      expect(api.calls[0]!.messages[0].role).toBe('system');
      expect(api.calls[0]!.messages[0].content).toBe('You are a robot');
    });

    test('uses an empty system message when no systemPrompt is set', async () => {
      const api = createStreamApi({ nextTurn: () => contentTurn('ok') });
      const agent = new Agent({ api, model: 'm1' });
      await agent.sendMessage(makeMessage('user', 'hi')).toPromise();
      expect(api.calls[0]!.messages[0].role).toBe('system');
      expect(api.calls[0]!.messages[0].content).toBe('');
    });

    test('passes registered tools to the API in OpenAI function format', async () => {
      const echo: Tool = {
        name: 'echo',
        description: 'echoes params',
        params: { type: 'object', properties: {} },
        callback: async () => 'ok',
      };
      const api = createStreamApi({ nextTurn: () => contentTurn('ok') });
      const agent = new Agent({ api, model: 'm1', tools: [echo] });
      await agent.sendMessage(makeMessage('user', 'hi')).toPromise();
      expect(api.calls[0]!.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'echo',
            description: 'echoes params',
            parameters: { type: 'object', properties: {} },
          },
        },
      ]);
    });

    test('omits the tools param entirely when no tools are registered', async () => {
      const api = createStreamApi({ nextTurn: () => contentTurn('ok') });
      const agent = new Agent({ api, model: 'm1', tools: [] });
      await agent.sendMessage(makeMessage('user', 'hi')).toPromise();
      expect(api.calls[0]!.tools).toBeUndefined();
    });

    test('round-robins across multiple apis and selects the matching model per api', async () => {
      const turns: MockChunk[][] = [
        [
          {
            toolCalls: [
              {
                index: 0,
                id: 'c1',
                function: { name: 'echo', arguments: '{}' },
              },
            ],
            finishReason: 'tool_calls',
          },
        ],
        contentTurn('done'),
      ];
      let i = 0;
      const nextTurn = () => turns[i++]!;
      const api1 = createStreamApi({ nextTurn, models: ['m1'] });
      const api2 = createStreamApi({ nextTurn, models: ['m2'] });
      const echo: Tool = {
        name: 'echo',
        description: 'echo',
        callback: async () => 'ok',
      };
      const agent = new Agent({
        api: [api1, api2],
        model: ['m1', 'm2'],
        tools: [echo],
      });
      await agent.sendMessage(makeMessage('user', 'go')).toPromise();

      expect(api1.calls).toHaveLength(1);
      expect(api2.calls).toHaveLength(1);
      expect(api1.calls[0]!.model).toBe('m1');
      expect(api2.calls[0]!.model).toBe('m2');
    });
  });

  /* ----------------------------- tool calls ------------------------------ */

  describe('tool calls', () => {
    test('executes a tool call and recurses for the next turn', async () => {
      const echo: Tool = {
        name: 'echo',
        description: 'echoes',
        callback: async (p) => JSON.stringify(p),
      };
      let turn = 0;
      const api = createStreamApi({
        nextTurn: () => {
          if (turn === 0) {
            turn++;
            return [
              {
                toolCalls: [
                  {
                    index: 0,
                    id: 'c1',
                    function: { name: 'echo', arguments: '{"msg":"hi"}' },
                  },
                ],
                finishReason: 'tool_calls',
              },
            ];
          }
          return contentTurn('Done');
        },
      });
      const agent = new Agent({ api, model: 'm1', tools: [echo] });

      const toolCalls: any[] = [];
      const toolResults: any[] = [];
      const emitter = agent.sendMessage(makeMessage('user', 'go'));
      emitter.on('tool-call', (tc) => toolCalls.push(tc));
      emitter.on('tool-result', (tr) => toolResults.push(tr));

      const response = await emitter.toPromise();
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]!.name).toBe('echo');
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]!.content).toBe('{"msg":"hi"}');
      expect(toolResults[0]!.name).toBe('echo');
      expect(toolResults[0]!.toolCallId).toBe('c1');
      expect(response.content).toBe('Done');
    });

    test('executes multiple tool calls within a single assistant turn', async () => {
      const echo: Tool = {
        name: 'echo',
        description: 'echoes',
        callback: async (p) => JSON.stringify(p),
      };
      let turn = 0;
      const api = createStreamApi({
        nextTurn: () => {
          if (turn === 0) {
            turn++;
            return [
              {
                toolCalls: [
                  {
                    index: 0,
                    id: 'c1',
                    function: { name: 'echo', arguments: '{"a":1}' },
                  },
                  {
                    index: 1,
                    id: 'c2',
                    function: { name: 'echo', arguments: '{"a":2}' },
                  },
                ],
                finishReason: 'tool_calls',
              },
            ];
          }
          return contentTurn('done');
        },
      });
      const agent = new Agent({ api, model: 'm1', tools: [echo] });

      const toolResults: any[] = [];
      const emitter = agent.sendMessage(makeMessage('user', 'go'));
      emitter.on('tool-result', (tr) => toolResults.push(tr));
      await emitter.toPromise();

      expect(toolResults).toHaveLength(2);
      expect(toolResults[0]!.toolCallId).toBe('c1');
      expect(toolResults[0]!.content).toBe('{"a":1}');
      expect(toolResults[1]!.toolCallId).toBe('c2');
      expect(toolResults[1]!.content).toBe('{"a":2}');
    });

    test('accumulates tool-call name and arguments across split chunks', async () => {
      const echo: Tool = {
        name: 'echo',
        description: 'echoes',
        callback: async (p) => JSON.stringify(p),
      };
      let turn = 0;
      const api = createStreamApi({
        nextTurn: () => {
          if (turn === 0) {
            turn++;
            return [
              {
                toolCalls: [{ index: 0, id: 'c1', function: { name: 'echo' } }],
              },
              {
                toolCalls: [
                  { index: 0, function: { arguments: '{"msg":"hi"}' } },
                ],
              },
              { finishReason: 'tool_calls' },
            ];
          }
          return contentTurn('ok');
        },
      });
      const agent = new Agent({ api, model: 'm1', tools: [echo] });

      const toolResults: any[] = [];
      const emitter = agent.sendMessage(makeMessage('user', 'go'));
      emitter.on('tool-result', (tr) => toolResults.push(tr));
      await emitter.toPromise();

      expect(toolResults[0]!.content).toBe('{"msg":"hi"}');
      expect(toolResults[0]!.params).toEqual({ msg: 'hi' });
    });

    test('reports a "not found" error in the tool result when the tool is unknown', async () => {
      let turn = 0;
      const api = createStreamApi({
        nextTurn: () => {
          if (turn === 0) {
            turn++;
            return [
              {
                toolCalls: [
                  {
                    index: 0,
                    id: 'c1',
                    function: { name: 'ghost', arguments: '{}' },
                  },
                ],
                finishReason: 'tool_calls',
              },
            ];
          }
          return contentTurn('ok');
        },
      });
      const agent = new Agent({ api, model: 'm1', tools: [] });

      const toolResults: any[] = [];
      const emitter = agent.sendMessage(makeMessage('user', 'go'));
      emitter.on('tool-result', (tr) => toolResults.push(tr));
      await emitter.toPromise();

      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]!.content).toMatch(/not found/);
    });

    test('captures a thrown tool callback error in the tool result', async () => {
      const boom: Tool = {
        name: 'boom',
        description: 'always throws',
        callback: async () => {
          throw new Error('kaboom');
        },
      };
      let turn = 0;
      const api = createStreamApi({
        nextTurn: () => {
          if (turn === 0) {
            turn++;
            return [
              {
                toolCalls: [
                  {
                    index: 0,
                    id: 'c1',
                    function: { name: 'boom', arguments: '{}' },
                  },
                ],
                finishReason: 'tool_calls',
              },
            ];
          }
          return contentTurn('ok');
        },
      });
      const agent = new Agent({ api, model: 'm1', tools: [boom] });

      const toolResults: any[] = [];
      const emitter = agent.sendMessage(makeMessage('user', 'go'));
      emitter.on('tool-result', (tr) => toolResults.push(tr));
      await emitter.toPromise();

      expect(toolResults[0]!.content).toBe('kaboom');
    });

    test('captures a JSON parse error for invalid tool-call arguments', async () => {
      const echo: Tool = {
        name: 'echo',
        description: 'echoes',
        callback: async (p) => JSON.stringify(p),
      };
      let turn = 0;
      const api = createStreamApi({
        nextTurn: () => {
          if (turn === 0) {
            turn++;
            return [
              {
                toolCalls: [
                  {
                    index: 0,
                    id: 'c1',
                    function: { name: 'echo', arguments: 'not-json' },
                  },
                ],
                finishReason: 'tool_calls',
              },
            ];
          }
          return contentTurn('ok');
        },
      });
      const agent = new Agent({ api, model: 'm1', tools: [echo] });

      const toolResults: any[] = [];
      const emitter = agent.sendMessage(makeMessage('user', 'go'));
      emitter.on('tool-result', (tr) => toolResults.push(tr));
      await emitter.toPromise();

      expect(toolResults[0]!.content).toMatch(/JSON Parse error|Unexpected/i);
    });

    test('detects a repeated tool-call loop and reports it in the tool result', async () => {
      const echo: Tool = {
        name: 'echo',
        description: 'echoes',
        callback: async () => 'ok',
      };
      let turn = 0;
      const api = createStreamApi({
        nextTurn: () => {
          const n = turn;
          turn++;
          if (n < 3) {
            return [
              {
                toolCalls: [
                  {
                    index: 0,
                    id: `c${n}`,
                    function: { name: 'echo', arguments: '{"msg":"hi"}' },
                  },
                ],
                finishReason: 'tool_calls',
              },
            ];
          }
          return contentTurn('done');
        },
      });
      const agent = new Agent({ api, model: 'm1', tools: [echo] });

      const toolCalls: any[] = [];
      const toolResults: any[] = [];
      const emitter = agent.sendMessage(makeMessage('user', 'go'));
      emitter.on('tool-call', (tc) => toolCalls.push(tc));
      emitter.on('tool-result', (tr) => toolResults.push(tr));
      await emitter.toPromise();

      // The 3rd identical call trips the loop guard *before* emitting
      // tool-call, so only 2 tool-call events fire — but 3 tool-results.
      expect(toolCalls).toHaveLength(2);
      expect(toolResults).toHaveLength(3);
      expect(toolResults[0]!.content).toBe('ok');
      expect(toolResults[1]!.content).toBe('ok');
      expect(toolResults[2]!.content).toMatch(/Loop detected/);
    });
  });

  /* ----------------------------- event hooks ----------------------------- */

  describe('event hooks', () => {
    test('send-message hook can transform the incoming user message', async () => {
      const api = createStreamApi({ nextTurn: () => contentTurn('ok') });
      const agent = new Agent({ api, model: 'm1' });
      agent.on('send-message', (msg: Message) => ({
        ...msg,
        content: `${msg.content} [hooked]`,
      }));

      await agent.sendMessage(makeMessage('user', 'hello')).toPromise();
      expect(agent.messages[0]!.content).toBe('hello [hooked]');
    });

    test('send-messages hook can transform the messages array sent to the API', async () => {
      const api = createStreamApi({ nextTurn: () => contentTurn('ok') });
      const agent = new Agent({ api, model: 'm1' });
      agent.on('send-messages', (messages: Message[]) => [
        { role: 'system', content: 'INJECTED', created: new Date() },
        ...messages,
      ]);

      await agent.sendMessage(makeMessage('user', 'hi')).toPromise();
      expect(api.calls[0]!.messages[0].role).toBe('system');
      expect(api.calls[0]!.messages[0].content).toBe('INJECTED');
    });

    test('processed-messages hook receives the OpenAI-formatted messages', async () => {
      const api = createStreamApi({ nextTurn: () => contentTurn('ok') });
      const agent = new Agent({ api, model: 'm1' });

      let captured: any;
      agent.on('processed-messages', (msgs: any[]) => {
        captured = msgs;
      });
      await agent.sendMessage(makeMessage('user', 'hi')).toPromise();

      expect(captured).toBeDefined();
      expect(captured[0].role).toBe('system');
      expect(
        captured.some((m: any) => m.role === 'user' && m.content === 'hi'),
      ).toBe(true);
    });

    test('processed-messages hook return value replaces the messages sent to the API', async () => {
      const api = createStreamApi({ nextTurn: () => contentTurn('ok') });
      const agent = new Agent({ api, model: 'm1' });
      agent.on('processed-messages', (msgs: any[]) => [
        ...msgs,
        { role: 'user', content: 'INJECTED' },
      ]);

      await agent.sendMessage(makeMessage('user', 'hi')).toPromise();
      const last = api.calls[0]!.messages[api.calls[0]!.messages.length - 1];
      expect(last.role).toBe('user');
      expect(last.content).toBe('INJECTED');
    });
  });

  /* --------------------------- toOpenAiMessages -------------------------- */

  describe('toOpenAiMessages (via processed-messages)', () => {
    test('transforms parts to OpenAI format with snake_case keys', async () => {
      const api = createStreamApi({ nextTurn: () => contentTurn('ok') });
      const agent = new Agent({ api, model: 'm1' });

      // Pre-populate a conversation with richly-structured parts.
      agent.messages.push(makeMessage('user', 'hi'));
      agent.messages.push({
        role: 'assistant',
        content: 'hello',
        parts: [
          {
            role: 'assistant',
            content: 'hello',
            reasoningContent: 'thinking',
            toolCalls: [{ id: 'c1', name: 'foo', params: { x: 1 } }],
          } as AgentPart,
          {
            role: 'tool',
            name: 'foo',
            content: 'result',
            toolCallId: 'c1',
          } as ToolPart,
        ],
        created: new Date(),
      });

      let captured: any;
      agent.on('processed-messages', (msgs: any[]) => {
        captured = msgs;
      });
      await agent.sendMessage(makeMessage('user', 'next?')).toPromise();

      // Assistant part: reasoningContent → reasoning_content, toolCalls → tool_calls
      const assistantOut = captured.find(
        (m: any) => m.role === 'assistant' && m.content === 'hello',
      );
      expect(assistantOut).toBeDefined();
      expect(assistantOut.reasoning_content).toBe('thinking');
      expect(assistantOut.tool_calls).toEqual([
        {
          id: 'c1',
          type: 'function',
          function: { name: 'foo', arguments: '{"x":1}' },
        },
      ]);

      // Tool part: toolCallId → tool_call_id
      const toolOut = captured.find((m: any) => m.role === 'tool');
      expect(toolOut).toBeDefined();
      expect(toolOut.name).toBe('foo');
      expect(toolOut.content).toBe('result');
      expect(toolOut.tool_call_id).toBe('c1');
    });

    test('filters out assistant parts with no content and no tool calls', async () => {
      const api = createStreamApi({ nextTurn: () => contentTurn('ok') });
      const agent = new Agent({ api, model: 'm1' });

      agent.messages.push(makeMessage('user', 'hi'));
      // An assistant message whose only part is empty — should be dropped.
      agent.messages.push({
        role: 'assistant',
        content: '',
        parts: [{ role: 'assistant', content: '', toolCalls: [] } as AgentPart],
        created: new Date(),
      });

      let captured: any;
      agent.on('processed-messages', (msgs: any[]) => {
        captured = msgs;
      });
      await agent.sendMessage(makeMessage('user', 'again')).toPromise();

      const emptyAssistants = captured.filter(
        (m: any) =>
          m.role === 'assistant' && !m.content && !m.tool_calls?.length,
      );
      expect(emptyAssistants).toHaveLength(0);
    });
  });

  /* ------------------------------ edge cases ----------------------------- */

  describe('edge cases', () => {
    test('emits aborted and rejects when the stream throws an AbortError', async () => {
      const api = createStreamApi({
        nextTurn: () => [
          { content: 'partial', finishReason: null },
          { throw: { name: 'AbortError', message: 'aborted' } },
        ],
      });
      const agent = new Agent({ api, model: 'm1' });

      const contents: string[] = [];
      let aborted = false;
      let ended = false;
      const emitter = agent.sendMessage(makeMessage('user', 'hi'));
      emitter.on('content', (s) => contents.push(s));
      emitter.on('aborted', () => {
        aborted = true;
      });
      emitter.on('end', () => {
        ended = true;
      });

      await expect(emitter.toPromise()).rejects.toThrow('Aborted');
      expect(contents).toEqual(['partial']);
      expect(aborted).toBe(true);
      expect(ended).toBe(false);
    });

    test('emits error and rejects when the stream throws a generic error', async () => {
      const api = createStreamApi({
        nextTurn: () => [{ throw: { message: 'boom' } }],
      });
      const agent = new Agent({ api, model: 'm1' });

      let errored = false;
      let ended = false;
      const emitter = agent.sendMessage(makeMessage('user', 'hi'));
      emitter.on('error', () => {
        errored = true;
      });
      emitter.on('end', () => {
        ended = true;
      });

      await expect(emitter.toPromise()).rejects.toThrow('boom');
      expect(errored).toBe(true);
      expect(ended).toBe(false);
    });

    test('throws when the maximum step count is exceeded', async () => {
      const echo: Tool = {
        name: 'echo',
        description: 'echoes',
        callback: async () => 'ok',
      };
      let n = 0;
      const api = createStreamApi({
        nextTurn: () => {
          const i = n++;
          return [
            {
              toolCalls: [
                {
                  index: 0,
                  id: `c${i}`,
                  // Unique params per call so loop detection never trips.
                  function: {
                    name: 'echo',
                    arguments: JSON.stringify({ n: i }),
                  },
                },
              ],
              finishReason: 'tool_calls',
            },
          ];
        },
      });
      const agent = new Agent({ api, model: 'm1', tools: [echo] });

      await expect(
        agent.sendMessage(makeMessage('user', 'go')).toPromise(),
      ).rejects.toThrow(/Max steps/);
    });
  });
});
