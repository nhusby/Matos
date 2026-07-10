import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { Agent } from './Agent';

const HISTORY_DIR = '.doofy';
const HISTORY_FILE = join(HISTORY_DIR, 'history.json');

function serializeMessage(msg: any): any {
  const parts = msg.parts?.map((part: any) => {
    const serialized: Record<string, any> = {};
    for (const [key, value] of Object.entries(part)) {
      // Skip Promise objects and undefined values
      if (
        value === undefined ||
        (typeof value === 'object' &&
          value !== null &&
          (typeof (value as any).then === 'function' ||
            ('result' in part &&
              (value as any).constructor?.name === 'Promise')))
      )
        continue;
      serialized[key] = value;
    }
    return serialized;
  });

  return {
    role: msg.role,
    name: msg.name,
    content:
      typeof msg.content === 'string' ? msg.content : (msg.content ?? ''),
    parts,
    thinking: msg.thinking,
    loading: msg.loading,
    created:
      msg.created instanceof Date ? msg.created.toISOString() : msg.created,
  };
}

function deserializeMessage(msg: any): any {
  const deserialized: Record<string, any> = {
    role: msg.role,
    content: msg.content ?? '',
    parts: msg.parts?.map((part: any) => ({
      ...part,
      toolCalls: part.toolCalls?.map((tc: any) => ({
        ...tc,
        result: undefined, // strip resolved results to avoid issues
      })),
    })),
    created: new Date(msg.created),
  };

  if (msg.name !== undefined) deserialized.name = msg.name;
  if (msg.thinking !== undefined) deserialized.thinking = msg.thinking;
  if (msg.loading !== undefined) deserialized.loading = msg.loading;

  return deserialized;
}

export async function saveHistory(agent: Agent): Promise<void> {
  mkdirSync(HISTORY_DIR, { recursive: true });

  const snapshot = {
    version: 1,
    timestamp: new Date().toISOString(),
    messages: agent.messages.map(serializeMessage),
    readFiles: [...agent.readFiles],
  };

  writeFileSync(HISTORY_FILE, JSON.stringify(snapshot, null, 2));
}

export async function loadHistory(
  agent: Agent,
): Promise<{ loaded: boolean; messageCount: number }> {
  if (!existsSync(HISTORY_FILE)) {
    return { loaded: false, messageCount: 0 };
  }

  try {
    const raw = readFileSync(HISTORY_FILE, 'utf-8');
    const snapshot = JSON.parse(raw);

    agent.messages = snapshot.messages.map(deserializeMessage);
    agent.readFiles = new Set(snapshot.readFiles ?? []);

    return { loaded: true, messageCount: agent.messages.length };
  } catch (e) {
    return { loaded: false, messageCount: 0 };
  }
}
