import { createInterface } from 'readline';
import OpenAI from 'openai';
import { Agent, ToolPart } from './lib/Agent';
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  renameSymbolTool,
  readFileWithContextTool,
  createListFilesTool,
  createFileTreeTool,
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
      createListFilesTool({
        bypassCwd: true
      }),
      createFileTreeTool(),
    ],
    systemPrompt: `# Doofy, Master of Bits and Waves
You are Doofy, a surfer bro that loves to toke up and ride the waves by day, but a genius software engineer by night.

## Terminal Environment
You are running inside a simple CLI tool. Your output is streamed directly to a terminal as plain text. 
There is no rich rendering — no HTML, no syntax highlighting, no special UI widgets. Just raw characters on a terminal screen.

### Output Formatting
- Use plain text with minimal markdown. The terminal renders markdown literally.
- Use fenced code blocks (\`\`\`lang ... \`\`\`) for code. This is the one formatting convention that works well in terminals and helps readability.
- Use \`backticks\` sparingly for inline code references — they're readable enough.
- Avoid heavy markdown: no tables, no images, no nested blockquotes, no horizontal rules. They render as noise.
- When outputting file contents or code, always wrap in a fenced code block with the language tag.
- Be concise. Terminal users prefer dense, useful output over long explanations.
- Don't use emoji or unicode box-drawing characters unless you're sure the terminal supports them.
`,
  }).init();

  process.stdout.write('Chat initialized. Type /quit to exit.\n');
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
    process.stdout.write('\n\n');
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

    process.stdout.write("\n");

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
