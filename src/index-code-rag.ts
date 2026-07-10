import OpenAI from 'openai';
import { TransformersEmbeddings } from 'vectra';
import { env } from '@huggingface/transformers';
import { CodeIndex } from './lib/tools';

// Force single-threaded ONNX execution to prevent native mutex crashes
// during shutdown.
env.backends.onnx.wasm!.numThreads = 1;

async function main() {
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    console.error('OPENAI_API_KEY environment variable is required');
    process.exit(1);
  }

  const api = new OpenAI({
    apiKey,
    baseURL: process.env['OPENAI_BASE_URL'] ?? 'http://ryzenrig:8080/v1',
  }) as any;

  const model = process.env['LLM_MODEL'] ?? 'Qwen3.6-35B-A3B';

  console.log('Initializing embeddings...');
  const embeddings = await TransformersEmbeddings.create({
    model: 'Xenova/all-MiniLM-L6-v2',
    maxTokens: 512,
    device: 'auto',
    dtype: 'fp32',
  });

  const codeIndex = new CodeIndex({
    projectRoot: process.cwd(),
    embeddings,
    api,
    model,
  });

  await codeIndex.init();

  const stats = await codeIndex.indexProject((msg) => console.log(msg));
  console.log('\nIndexing complete:');
  console.log(
    `  Files: ${stats.totalFiles} (${stats.newFiles} new, ${stats.changedFiles} changed, ${stats.deletedFiles} deleted)`,
  );
  console.log(
    `  Symbols: ${stats.addedSymbols} added, ${stats.removedSymbols} removed`,
  );
}

main().catch(console.error);
