import { Emitter } from './Emitter.js';
import { EmitterPromise } from './EmitterPromise.js';
import { pruneContext } from './ContextPruner.js';
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

export class Agent extends Emitter {
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
    for (const api of this.apis) {
      api._models = [];
      for await (const page of (await api.models.list()).iterPages()) {
        for (const model of page.getPaginatedItems()) {
          api._models.push(model.id);
        }
      }
    }

    return this;
  }

  public sendMessage(message: Message): EmitterPromise<Message> {
    this.messages.push(message);
    const response: Message = {
      role: 'assistant',
      content: '',
      parts: [],
      created: new Date(),
    };
    this.messages.push(response);

    return this.sendMessages(
      [
        {
          role: 'system',
          content: this.systemPrompt ?? '',
          created: new Date(),
        },
        ...this.messages,
      ],
      response,
    );
  }

  public sendMessages(
    messages: Message[],
    response: Message,
  ): EmitterPromise<Message> {
    const emitter = new EmitterPromise<Message>();
    const part: AgentPart = {
      role: 'assistant',
      content: '',
      toolCalls: [],
    };
    response.parts!.push(part);

    (async () => {
      [messages] = await this.emitReplace('send', messages) as any;
      const abortController = new AbortController();
      const params = {
        stream: true as const,
        signal: abortController.signal,
        model: this.model,
        messages: toOpenAiMessages(messages),
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
      );
      this.apiIndex = (this.apiIndex + 1) % this.apis.length;
      for await (const chunk of stream) {
        try {
          for (const choice of chunk.choices) {
            if ("reasoning_content" in choice.delta) {
              if (!response.thinking) {
                response.thinking = true;
                await emitter.emitAsync('chunk', "<thinking>");
              }
              part.reasoningContent = (part.reasoningContent ?? '') + choice.delta.reasoning_content;
              await emitter.emitAsync('chunk', choice.delta.reasoning_content);
            } else if (choice.delta.content) {
              if (response.thinking) {
                response.thinking = false;
                await emitter.emitAsync('chunk', "</thinking>\n\n");
              }
              part.content += choice.delta.content;
              response.content += choice.delta.content;
              await emitter.emitAsync('chunk', choice.delta.content);
            } else if (choice.delta.refusal) {
              if (response.thinking) {
                response.thinking = false;
                await emitter.emitAsync('chunk', "</thinking>\n\n");
              }
              part.content += choice.delta.refusal;
              response.content += choice.delta.refusal;
              await emitter.emitAsync('chunk', choice.delta.refusal);
            }
            if (choice.delta.tool_calls) {
              for (const toolCall of choice.delta.tool_calls) {
                if (!part.toolCalls![toolCall.index]) {
                  // MaybeDo emit/invoke ToolCalls as they come in?
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
                    await emitter.emitAsync('toolCall', {
                      ...toolCall,
                      result: undefined,
                      argStr: undefined,
                    });
                    const tool = this.tools.find(
                      (tool) => tool.name === toolCall.name,
                    );
                    if (!tool) {
                      throw new Error(`tool ${toolCall.name} not found`);
                    }
                    toolCall.result = tool.callback(toolCall.params);
                    toolCallResult.content = await toolCall.result;
                  } catch (e: any) {
                    toolCall.result = Promise.resolve(e.message);
                  }
                  await emitter.emitAsync('toolCallResult', toolCallResult);
                }
                await this.sendMessages(this.messages, response).onAny(
                  (event, data) => emitter.emitAsync(event, data),
                );
              } else {
                await emitter.emitAsync('finished', response);
                await this.emitAsync('complete', response);
                pruneContext(this.messages, this.tools, {
                  api: this.api,
                  model: this.model,
                });
              }
              break;
            }
          }
        } catch (error: any) {
          emitter.emit('error', error);
          abortController.abort();
          throw error;
        }
      }

      return response;
    })().then(
      (response) => {
        emitter.resolve(response!);
      },
      (e) => emitter.reject(e),
    );

    return emitter;
  }
}

function snake_case(key: string) {
  return key.replace(/([A-Z])/g, '_$1').toLowerCase();
}

function toOpenAiMessages(messages: Message[]) {
  return messages
    .flatMap((msg) => (msg.parts ?? [msg]) as any)
    .filter((msg) => !(msg.role === 'assistant' && !msg.content && !msg.toolCalls?.length))
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
