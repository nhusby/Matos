import type { Tool } from '../Agent';
import type { CodeIndex } from './codeIndex';

export interface SemanticSearchConfig {
  codeIndex: CodeIndex;
}

export const createSemanticSearchTool = (
  config: SemanticSearchConfig,
): Tool => ({
  name: 'SemanticSearch',
  description:
    'Semantic code search. Finds functions, methods, and classes by meaning, not just text match. Describe what you are looking for in natural language. Returns matching symbols with file paths, line numbers, descriptions, and source code. Use this when looking for existing code that does something specific, especially when you are not sure of the exact function or variable names.',
  params: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Natural language description of the code you are looking for. Describe its purpose or behavior.',
      },
      topK: {
        type: 'number',
        description: 'Maximum number of results to return. Default: 5.',
      },
      kind: {
        type: 'string',
        description:
          'Filter by symbol kind: "function", "method", or "class". Optional.',
      },
    },
    required: ['query'],
  },
  callback: async ({
    query,
    topK,
    kind,
  }: {
    query: string;
    topK?: number;
    kind?: string;
  }) => {
    let results = await config.codeIndex.search(query, topK ?? 5);

    if (kind) {
      results = results.filter((r) => r.kind === kind);
    }

    if (results.length === 0) {
      return 'No matching symbols found. Try a different query or run /index to build the code index.';
    }

    const lines = [`Found ${results.length} matching symbol(s):\n`];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const suffix = r.className ? ` (method of ${r.className})` : '';
      lines.push(
        `${i + 1}. ${r.name} (${r.kind})${suffix} — ${r.relativePath}:${r.startLine}-${r.endLine}`,
      );
      lines.push(`   ${r.description}`);
      lines.push('```typescript');
      const truncated =
        r.sourceText.length > 500
          ? r.sourceText.slice(0, 500) + '\n  // ... truncated'
          : r.sourceText;
      lines.push(truncated);
      lines.push('```\n');
    }

    return lines.join('\n');
  },
});
