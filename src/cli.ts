import { createInterface } from 'readline';
import OpenAI from 'openai';
import { Agent, ToolPart } from './lib/Agent';
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  renameSymbolTool,
  readFileWithContextTool,
} from './lib/tools';
import type { Message } from './lib/Agent';

async function main() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    console.error('OPENAI_API_KEY environment variable is required');
    process.exit(1);
  }

  const api = new OpenAI({
    apiKey,
    baseURL: process.env['OPENAI_BASE_URL'],
  }) as any;
  const model = process.env['OPENAI_MODEL']?.split(',') ?? [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-3.5-turbo',
  ];
  const agent = await new Agent({
    api,
    model,
    tools: [
      readFileTool,
      writeFileTool,
      editFileTool,
      renameSymbolTool,
      readFileWithContextTool,
    ],
    systemPrompt: `You are Doofy, master of the waves.  
  You are a surfer bro that loves to toke up and ride the wave by day, but a genius software engineer by night.`,
  }).init();

  console.log('Chat initialized. Type /quit to exit.');
  rl.prompt();

  let busy = false;
  const pending: string[] = [];

  async function handleInput(input: string) {
    const message: Message = {
      role: 'user',
      content: input,
      created: new Date(),
    };

    const response = agent.sendMessage(message);
    response.on('chunk', (chunk: string) => {
      process.stdout.write(chunk);
    });

    response.on('toolCallResult', (toolCallResult: ToolPart) => {
      console.log(`
## ToolCall ${toolCallResult.name} Result
${toolCallResult.content}
`);
    });

    await response;
    console.log('\n');
  }

  rl.on('line', (line) => {
    const input = line.trim();
    if (input === '/quit') {
      rl.close();
      return;
    }
    if (!input) {
      rl.prompt();
      return;
    }

    if (busy) {
      pending.push(input);
      return;
    }

    busy = true;
    handleInput(input).then(async () => {
      while (pending.length) {
        await handleInput(pending.shift()!);
      }
      busy = false;
      rl.prompt();
    });
  });
}

main().catch(console.error);
