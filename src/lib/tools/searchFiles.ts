import { readdir, readFile, stat } from 'fs/promises';
import { resolve, join, relative } from 'path';
import type { Tool } from '../Agent';

export interface SearchFilesConfig {
  bypassCwd?: boolean;
}

export const createSearchFilesTool = (config: SearchFilesConfig = {}): Tool => ({
  name: 'SearchFiles',
  description:
    'Search for a text pattern across files in a directory. Returns matching file paths, line numbers, and the matching lines. Supports substring and basic regex search.',
  params: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Text pattern or regular expression to search for.',
      },
      path: {
        type: 'string',
        description: 'Directory or file path to search in. Defaults to current working directory.',
      },
      include: {
        type: 'string',
        description: 'Comma-separated file extensions to include, e.g. "*.ts,*.tsx". Defaults to all files.',
      },
      excludeDirs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Directory names to skip, e.g. ["node_modules", ".git"]. Defaults to ["node_modules", ".git", "dist", "build"].',
      },
      regex: {
        type: 'boolean',
        description: 'Set to true to treat the pattern as a regular expression.',
      },
      caseSensitive: {
        type: 'boolean',
        description: 'Set to true for case-sensitive search. Defaults to false (case-insensitive).',
      },
    },
    required: ['pattern'],
  },
  callback: async ({
    pattern,
    path: searchPath,
    include,
    excludeDirs,
    regex,
    caseSensitive,
  }: {
    pattern: string;
    path?: string;
    include?: string;
    excludeDirs?: string[];
    regex?: boolean;
    caseSensitive?: boolean;
  }) => {
    const root = resolve(searchPath ?? process.cwd());

    if (!config.bypassCwd && !root.startsWith(process.cwd())) {
      return 'Error: path is outside the current working directory.';
    }

    const excludeSet = new Set(
      excludeDirs ?? ['node_modules', '.git', 'dist', 'build'],
    );

    const extensions =
      include
        ?.split(',')
        .map((s) => s.trim().replace(/^\*\./, '.'))
        .filter(Boolean) ?? null;

    let searchRegex: RegExp;
    try {
      searchRegex = regex
        ? new RegExp(pattern, caseSensitive ? 'g' : 'gi')
        : new RegExp(
            pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            caseSensitive ? 'g' : 'gi',
          );
    } catch (e: any) {
      return `Error: invalid pattern — ${e.message}`;
    }

    const rootStat = await stat(root);
    const isFile = rootStat.isFile();
    const searchDir = isFile ? resolve(root, '..') : root;

    const results: string[] = [];
    let totalMatches = 0;
    const MAX_MATCHES = 200;

    async function walk(dir: string): Promise<void> {
      if (totalMatches >= MAX_MATCHES) return;

      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (totalMatches >= MAX_MATCHES) break;

        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          if (excludeSet.has(entry.name) || entry.name.startsWith('.')) {
            continue;
          }
          await walk(fullPath);
        } else if (entry.isFile()) {
          if (isFile && fullPath !== root) continue;
          if (extensions) {
            const ext = entry.name.includes('.')
              ? '.' + entry.name.split('.').pop()!
              : '';
            if (!extensions.includes(ext)) continue;
          }

          try {
            const content = await readFile(fullPath, 'utf-8');
            const lines = content.split('\n');
            const relPath = relative(process.cwd(), fullPath);

            for (let i = 0; i < lines.length; i++) {
              searchRegex.lastIndex = 0;
              if (searchRegex.test(lines[i])) {
                results.push(`${relPath}:${i + 1}: ${lines[i]}`);
                totalMatches++;
                if (totalMatches >= MAX_MATCHES) break;
              }
            }
          } catch {
            // skip unreadable files
          }
        }
      }
    }

    await walk(searchDir);

    if (results.length === 0) {
      return 'No matches found.';
    }

    const header =
      totalMatches >= MAX_MATCHES
        ? `Found ${MAX_MATCHES}+ matches (truncated):\n`
        : `Found ${results.length} match${results.length === 1 ? '' : 'es'}:\n`;

    return header + results.join('\n');
  },
});
