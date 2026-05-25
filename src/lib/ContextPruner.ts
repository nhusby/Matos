import type { Api, Message, Tool, AgentPart, SystemPart, ToolPart } from './Agent.js';
import type OpenAI from 'openai';

export interface SummarizeContext {
  api: Api;
  model: string;
}

export async function pruneContext(
  messages: Message[],
  tools: Tool[],
  summarizeCtx?: SummarizeContext,
): Promise<Set<string>> {
  const prunedFiles = new Set<string>();
  const toolConfig = new Map<string, Pick<Tool, 'ttl' | 'summarize'>>(
    tools.map((t) => [t.name, { ttl: t.ttl, summarize: t.summarize }]),
  );

  const totalTurns = messages.filter((m) => m.role === 'assistant').length;

  const turnIndexOf = new Map<Message, number>();
  let turnIdx = 0;
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      turnIndexOf.set(msg, turnIdx++);
    }
  }

  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.parts) continue;
    const age = totalTurns - turnIndexOf.get(msg)!;

    for (let i = msg.parts.length - 1; i >= 0; i--) {
      const part = msg.parts[i];

      if (part.role === 'assistant') {
        if (part.reasoningContent && age > 3) {
          delete part.reasoningContent;
        }
        continue;
      }

      if (part.role !== 'tool') continue;

      const config = toolConfig.get(part.name);
      if (!config?.ttl || age < config.ttl) continue;

      // Extract file path for readFile/readFileWithContext tools
      if ((part.name === 'ReadFile' || part.name === 'ReadFileWithContext')) {
        const tc = findToolCall(part.toolCallId, messages);
        if (tc?.params?.path) {
          prunedFiles.add(tc.params.path);
        }
      }

      if (config.summarize && summarizeCtx) {
        const summary = await summarizeToolPart(
          part,
          messages,
          summarizeCtx,
        );
        removeToolCallEntry(part.toolCallId, msg.parts);
        msg.parts[i] = { role: 'system', content: summary } as SystemPart;
      } else {
        removeToolCallEntry(part.toolCallId, msg.parts);
        msg.parts.splice(i, 1);
      }
    }
  }

  // Remove system messages with ttl (the injected file context)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'system') continue;
    const ttl = (msg as any).ttl;
    if (typeof ttl === 'number' && ttl > 0) {
      (msg as any).ttl -= 1;
      if ((msg as any).ttl <= 0) {
        messages.splice(i, 1);
      }
    }
  }

  return prunedFiles;
}

async function summarizeToolPart(
  toolPart: ToolPart,
  messages: Message[],
  ctx: SummarizeContext,
): Promise<string> {
  const call = findToolCall(toolPart.toolCallId, messages);
  const args = call ? JSON.stringify(call.params) : '';

  const prefix = messages.map((m) => ({
    role: m.role,
    content: m.content || undefined,
  })).filter((m) => m.content);

  const response = await ctx.api.chat.completions.create({
    model: ctx.model,
    messages: [
      ...prefix as OpenAI.ChatCompletionMessageParam[],
      {
        role: 'user',
        content: `Summarize the following tool call and its result in 1-2 sentences, preserving key information that would be needed for future context. Focus on what was learned, not the mechanics of the call.\n\nTool: ${toolPart.name}\nArguments: ${args}\nResult: ${toolPart.content}`,
      },
    ],
  });

  return response.choices[0]!.message.content!;
}

function removeToolCallEntry(toolCallId: string, parts: (AgentPart | ToolPart | SystemPart)[]) {
  for (const part of parts) {
    if (part.role === 'assistant' && part.toolCalls) {
      const idx = part.toolCalls.findIndex((tc) => tc.id === toolCallId);
      if (idx !== -1) {
        part.toolCalls.splice(idx, 1);
        return;
      }
    }
  }
}

function findToolCall(toolCallId: string, messages: Message[]) {
  for (const msg of messages) {
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      if (part.role === 'assistant' && part.toolCalls) {
        const tc = part.toolCalls.find((tc) => tc.id === toolCallId);
        if (tc) return tc;
      }
    }
  }
  return undefined;
}
