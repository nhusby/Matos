import { Emitter } from './Emitter.js';
import OpenAI from 'openai';

export interface Tool {
  name: string;
  description: string;
  params?: any;
  callback: (params: any) => Promise<string>;
  ttl?: number;
  summarize?: boolean;
}
export interface ToolCall {
  id: string;
  name: string;
  params: any;
  result?: Promise<string>;
}

export interface ToolPart {
  role: 'tool';
  name: string;
  content: string;
  toolCallId: string;
  params?: any;
}
export interface AgentPart {
  role: 'assistant';
  content: string;
  reasoningContent?: string;
  toolCalls?: (ToolCall & { _argStr?: string })[];
}
export interface SystemPart {
  role: 'system';
  content: string;
}
export interface ProcessedMessage {
  role: string;
  content?: string;
  name?: string;
  reasoning_content?: string;
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}
export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  name?: string;
  content: string;
  parts?: (AgentPart | ToolPart | SystemPart)[];
  thinking?: boolean;
  loading?: boolean;
  created: Date;
}

export interface Api extends OpenAI {
  _models: string[];
}

export interface AgentEvents extends MessageEvents {
  'send-message': Message;
  'send-messages': Message[];
  'processed-messages': ProcessedMessage[];
}

export interface MessageEvents {
  /**  Agent turn start */
  start: void;
  /** Housekeeping after LLM has finished generating tokens */
  finalizing: Message;
  /** Agent turn end */
  end: Message;
  /** token generation was aborted */
  aborted: Message;
  /** any error event */
  error: Error;
  /** <thinking> */
  'reasoning-start': void;
  /** reasoning token stream chunk */
  reasoning: string;
  /** </thinking> */
  'reasoning-finished': void;
  /** content token stream chunk */
  content: string;
  /** the agent requested use of a tool.  Throwing an error in the handler will reject the request. */
  'tool-call': ToolCall;
  /** The result of tool execution */
  'tool-result': ToolPart;
}

const MAX_STEPS = 128;
const LOOP_WINDOW = 5;
const LOOP_THRESHOLD = 3;

export class Agent extends Emitter<AgentEvents> {
  protected apis!: Api[];
  private apiIndex = 0;
  public get api(): Api {
    return this.apis[this.apiIndex];
  }

  protected models!: string[];
  public get model(): string {
    for (const model of this.models) {
      if (this.api._models.includes(model)) {
        return model;
      }
    }
    return this.models[0];
  }

  messages: Message[] = [];

  tools: Tool[] = [];
  systemPrompt?: string;
  readFiles: Set<string> = new Set();

  constructor(params: {
    api: Api | Api[];
    model: string | string[];
    tools?: Tool[];
    systemPrompt?: string;
  }) {
    super();
    this.apis = Array.isArray(params.api) ? params.api : [params.api];
    this.models = Array.isArray(params.model) ? params.model : [params.model];
    this.tools = params.tools ?? [];
    this.systemPrompt = params.systemPrompt;
  }

  async init() {
    await Promise.all(
      this.apis.map(async (api) => {
        api._models = [];
        for await (const page of (await api.models.list()).iterPages()) {
          for (const model of page.getPaginatedItems()) {
            api._models.push(model.id);
          }
        }
      }),
    );

    return this;
  }

  public sendMessage(message: Message): Emitter<MessageEvents> {
    const emitter = new Emitter<MessageEvents>();
    emitter.onAny(async (eventName: any, ...args: any[]) => {
      await this.emit(eventName as keyof AgentEvents, args[0]);
    });
    this.#beginSend(message, emitter).catch((e) => emitter.emit('error', e));
    return emitter;
  }

  async #beginSend(
    message: Message,
    emitter: Emitter<MessageEvents>,
  ): Promise<void> {
    message = await this.emit('send-message', message);
    this.messages.push(message);

    const response: Message = {
      role: 'assistant',
      content: '',
      parts: [],
      created: new Date(),
    };
    this.messages.push(response);

    await emitter.emit('start');

    const messages: Message[] = [
      {
        role: 'system',
        content: this.systemPrompt ?? '',
        created: new Date(),
      },
      ...this.messages,
    ];

    try {
      await this.#streamMessages(messages, response, emitter, 0, []);
      await emitter.emit('finalizing', response);
      await emitter.emit('end', response);
    } catch (e: any) {
      if (e?.name === 'AbortError' || e?.name === 'APIUserAbortError') {
        await emitter.emit('aborted', response);
        return;
      }
      throw e;
    }
  }

  async #streamMessages(
    messages: Message[],
    response: Message,
    emitter: Emitter<MessageEvents>,
    depth: number,
    recentCalls: string[],
  ): Promise<void> {
    if (depth >= MAX_STEPS) {
      throw new Error(`Max steps (${MAX_STEPS}) exceeded`);
    }

    const part: AgentPart = {
      role: 'assistant',
      content: '',
      toolCalls: [],
    };
    response.parts!.push(part);

    let transformed = await this.emit('send-messages', messages);
    let openAiMessages = toOpenAiMessages(transformed);
    openAiMessages = await this.emit('processed-messages', openAiMessages);

    const params = {
      stream: true as const,
      model: this.model,
      messages: openAiMessages,
      ...(this.tools.length
        ? {
            tools: this.tools.map((tool) => ({
              type: 'function' as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.params,
              },
            })),
          }
        : {}),
    };
    const stream = await this.api.chat.completions.create(
      params as OpenAI.ChatCompletionCreateParamsStreaming,
      { signal: emitter.abortController.signal },
    );
    this.apiIndex = (this.apiIndex + 1) % this.apis.length;

    try {
      for await (const chunk of stream) {
        for (const choice of chunk.choices) {
          if ('reasoning_content' in choice.delta) {
            if (!response.thinking) {
              response.thinking = true;
              await emitter.emit('reasoning-start');
            }
            part.reasoningContent =
              (part.reasoningContent ?? '') + choice.delta.reasoning_content;
            await emitter.emit('reasoning', choice.delta.reasoning_content);
          } else if (choice.delta.content) {
            if (response.thinking) {
              response.thinking = false;
              await emitter.emit('reasoning-finished');
            }
            part.content += choice.delta.content;
            response.content += choice.delta.content;
            await emitter.emit('content', choice.delta.content);
          } else if (choice.delta.refusal) {
            if (response.thinking) {
              response.thinking = false;
              await emitter.emit('reasoning-finished');
            }
            part.content += choice.delta.refusal;
            response.content += choice.delta.refusal;
            await emitter.emit('content', choice.delta.refusal);
          }

          if (choice.delta.tool_calls) {
            for (const toolCall of choice.delta.tool_calls) {
              if (!part.toolCalls![toolCall.index]) {
                part.toolCalls![toolCall.index] = {
                  id: toolCall.id!,
                  name: '',
                  params: {},
                  _argStr: '',
                };
              }

              if (toolCall.function?.name) {
                part.toolCalls![toolCall.index]!.name =
                  (part.toolCalls![toolCall.index]!.name || '') +
                  toolCall.function.name;
              }
              if (toolCall.function?.arguments) {
                part.toolCalls![toolCall.index]!._argStr +=
                  toolCall.function.arguments;
              }
            }
          }

          if (choice.finish_reason) {
            if (choice.finish_reason === 'tool_calls') {
              const nextRecent = await this.#executeToolCalls(
                part,
                response,
                emitter,
                recentCalls,
              );
              await this.#streamMessages(
                this.messages,
                response,
                emitter,
                depth + 1,
                nextRecent,
              );
            }
            break;
          }
        }
      }
    } catch (e: any) {
      if (
        e?.name === 'AbortError' ||
        e?.name === 'APIUserAbortError'
      ) {
        throw e;
      }
      emitter.abortController.abort();
      throw e;
    }
  }

  async #executeToolCalls(
    part: AgentPart,
    response: Message,
    emitter: Emitter<MessageEvents>,
    recentCalls: string[],
  ): Promise<string[]> {
    let nextRecent = recentCalls;

    for (const toolCall of part.toolCalls!) {
      const toolCallResult: ToolPart = {
        role: 'tool',
        name: toolCall.name,
        content: '',
        toolCallId: toolCall.id,
      };
      response.parts!.push(toolCallResult);

      try {
        if (toolCall._argStr) {
          toolCall.params = JSON.parse(toolCall._argStr);
        }

        const hash = `${toolCall.name}:${JSON.stringify(toolCall.params)}`;
        nextRecent = [...nextRecent, hash].slice(-LOOP_WINDOW);
        const counts = new Map<string, number>();
        for (const c of nextRecent) counts.set(c, (counts.get(c) ?? 0) + 1);
        if ([...counts.values()].some((v) => v >= LOOP_THRESHOLD)) {
          throw new Error(
            `Loop detected: tool "${toolCall.name}" called ${LOOP_THRESHOLD}+ times with identical args in the last ${LOOP_WINDOW} calls`,
          );
        }

        await emitter.emit('tool-call', {
          ...toolCall,
          result: undefined,
          argStr: undefined,
        });
        const tool = this.tools.find((t) => t.name === toolCall.name);
        if (!tool) {
          throw new Error(`tool ${toolCall.name} not found`);
        }
        toolCall.result = tool.callback(toolCall.params);
        toolCallResult.content = await toolCall.result;
      } catch (e: any) {
        toolCall.result = Promise.resolve(e.message);
        toolCallResult.content = e.message;
      }

      await emitter.emit('tool-result', {
        ...toolCallResult,
        params: toolCall.params,
      });
    }

    return nextRecent;
  }
}

function snake_case(key: string) {
  return key.replace(/([A-Z])/g, '_$1').toLowerCase();
}

function toOpenAiMessages(messages: Message[]): ProcessedMessage[] {
  return messages
    .flatMap((msg) => (msg.parts ?? [msg]) as any)
    .filter(
      (msg) =>
        !(msg.role === 'assistant' && !msg.content && !msg.toolCalls?.length),
    )
    .map((part: AgentPart | ToolPart | Message) => {
      const obj: any = {};
      for (const key of [
        'role',
        'name',
        'content',
        'reasoningContent',
        'toolCalls',
        'toolCallId',
      ]) {
        if (key in part) {
          // @ts-ignore
          obj[snake_case(key)] = part[key];
        }
      }
      if (obj.tool_calls) {
        obj.tool_calls = obj.tool_calls.map((toolCall: ToolCall) => {
          return {
            id: toolCall.id,
            type: 'function',
            function: {
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.params),
            },
          };
        });
      }

      return obj as any;
    });
}
