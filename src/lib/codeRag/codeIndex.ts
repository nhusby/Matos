import { createHash } from 'crypto';
import { readdir, readFile, stat, writeFile } from 'fs/promises';
import { resolve, join, relative } from 'path';
import { LocalIndex } from 'vectra';
import type { EmbeddingsModel } from 'vectra';
import type { Api } from '../Agent';
import { extractSymbols } from './symbolExtractor';
import type { ExtractedSymbol } from './symbolExtractor';

const JS_TS_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mts',
  '.mjs',
  '.cts',
  '.cjs',
  '.go',
  '.py',
  '.pyi',
  '.pl',
  '.pm',
  '.t',
]);
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.code-rag-index',
]);

export interface CodeIndexConfig {
  projectRoot: string;
  embeddings: EmbeddingsModel;
  api: Api;
  model: string;
}

export interface SearchResult {
  score: number;
  filePath: string;
  relativePath: string;
  name: string;
  kind: 'function' | 'method' | 'class';
  className?: string;
  startLine: number;
  endLine: number;
  description: string;
  sourceText: string;
}

export interface IndexStats {
  totalFiles: number;
  changedFiles: number;
  newFiles: number;
  deletedFiles: number;
  totalSymbols: number;
  addedSymbols: number;
  removedSymbols: number;
}

interface HashCache {
  [filePath: string]: string;
}

export class CodeIndex {
  private index: LocalIndex;
  private hashCachePath: string;
  private hashCache: HashCache = {};
  private config: CodeIndexConfig;

  constructor(config: CodeIndexConfig) {
    this.config = config;
    const indexDir = join(config.projectRoot, '.code-rag-index');
    this.index = new LocalIndex(indexDir);
    this.hashCachePath = join(indexDir, 'hash-cache.json');
  }

  /**
   * Release the ONNX Runtime inference session held by the embeddings model.
   * Without this, native threads stay alive and cause
   * "mutex lock failed: Invalid argument" crashes when the process exits.
   */
  async dispose(): Promise<void> {
    const embeddings = this.config.embeddings as any;
    try {
      // _extractor is the transformers.js pipeline callable (a Pipeline instance)
      // Pipeline.dispose() calls model.dispose() which releases each ONNX session
      await embeddings?._extractor?.dispose?.();
    } catch {
      // best-effort — the session may already be gone
    }
  }

  async init(): Promise<void> {
    if (!(await this.index.isIndexCreated())) {
      await this.index.createIndex({
        version: 1,
        metadata_config: { indexed: ['filePath', 'kind', 'name'] },
      });
    }
    try {
      const raw = await readFile(this.hashCachePath, 'utf-8');
      this.hashCache = JSON.parse(raw);
    } catch {
      this.hashCache = {};
    }
  }

  async indexProject(onProgress?: (msg: string) => void): Promise<IndexStats> {
    const stats: IndexStats = {
      totalFiles: 0,
      changedFiles: 0,
      newFiles: 0,
      deletedFiles: 0,
      totalSymbols: 0,
      addedSymbols: 0,
      removedSymbols: 0,
    };

    onProgress?.('Scanning files...');
    const filesOnDisk = await this.walkDir(this.config.projectRoot);
    stats.totalFiles = filesOnDisk.length;

    const cachedPaths = new Set(Object.keys(this.hashCache));
    const diskPaths = new Set(filesOnDisk);

    const deletedPaths = [...cachedPaths].filter((p) => !diskPaths.has(p));
    stats.deletedFiles = deletedPaths.length;

    if (deletedPaths.length > 0) {
      onProgress?.(`Removing ${deletedPaths.length} deleted file(s)...`);
      for (const filePath of deletedPaths) {
        const items = await this.index.listItemsByMetadata({
          filePath: { $eq: filePath },
        });
        for (const item of items) {
          await this.index.deleteItem(item.id);
          stats.removedSymbols++;
        }
        delete this.hashCache[filePath];
      }
    }

    const toProcess: { filePath: string; content: string }[] = [];
    for (const filePath of filesOnDisk) {
      const content = await readFile(filePath, 'utf-8');
      const hash = createHash('sha256').update(content).digest('hex');
      if (this.hashCache[filePath] === hash) continue;
      if (cachedPaths.has(filePath)) stats.changedFiles++;
      else stats.newFiles++;
      toProcess.push({ filePath, content });
      this.hashCache[filePath] = hash;
    }

    if (toProcess.length === 0 && deletedPaths.length === 0) {
      onProgress?.('Index is up to date.');
      return stats;
    }

    onProgress?.(`Extracting symbols from ${toProcess.length} file(s)...`);
    const allSymbols: (ExtractedSymbol & { content: string })[] = [];
    for (const { filePath, content } of toProcess) {
      const symbols = extractSymbols(filePath, content);
      for (const sym of symbols) {
        allSymbols.push({ ...sym, content });
      }
    }
    stats.totalSymbols = allSymbols.length;

    onProgress?.(
      `Generating descriptions for ${allSymbols.length} symbol(s)...`,
    );
    const descriptions = await this.generateDescriptions(
      allSymbols,
      onProgress,
    );

    onProgress?.(`Embedding ${descriptions.length} description(s)...`);
    const embeddingResponse = await this.config.embeddings.createEmbeddings(
      descriptions.map((d) => d.description),
    );
    const vectors = embeddingResponse.output!;

    onProgress?.('Updating index...');
    for (const filePath of toProcess) {
      const items = await this.index.listItemsByMetadata({
        filePath: { $eq: filePath.filePath },
      });
      for (const item of items) {
        await this.index.deleteItem(item.id);
        stats.removedSymbols++;
      }
    }

    await this.index.beginUpdate();
    for (let i = 0; i < allSymbols.length; i++) {
      const sym = allSymbols[i];
      const desc = descriptions[i];
      await this.index.insertItem({
        vector: vectors[i],
        metadata: {
          filePath: sym.filePath,
          relativePath: relative(this.config.projectRoot, sym.filePath),
          kind: sym.kind,
          name: sym.name,
          ...(sym.className && { className: sym.className }),
          startLine: sym.startLine,
          endLine: sym.endLine,
          description: desc.description,
          sourceText: sym.sourceText,
        },
      });
      stats.addedSymbols++;
    }
    await this.index.endUpdate();

    await writeFile(
      this.hashCachePath,
      JSON.stringify(this.hashCache, null, 2),
    );

    onProgress?.(
      `Done. ${stats.addedSymbols} symbols indexed across ${stats.totalFiles} files.`,
    );
    return stats;
  }

  async search(query: string, topK = 10): Promise<SearchResult[]> {
    const queryResponse = await this.config.embeddings.createEmbeddings(query);
    const queryVector = queryResponse.output![0];

    const results = await this.index.queryItems(queryVector, '', topK);

    return results.map((r) => ({
      score: r.score,
      filePath: r.item.metadata.filePath as string,
      relativePath: r.item.metadata.relativePath as string,
      name: r.item.metadata.name as string,
      kind: r.item.metadata.kind as 'function' | 'method' | 'class',
      className: r.item.metadata.className as string | undefined,
      startLine: r.item.metadata.startLine as number,
      endLine: r.item.metadata.endLine as number,
      description: r.item.metadata.description as string,
      sourceText: r.item.metadata.sourceText as string,
    }));
  }

  private async generateDescriptions(
    symbols: ExtractedSymbol[],
    onProgress?: (msg: string) => void,
  ): Promise<{ name: string; description: string }[]> {
    const results: { name: string; description: string }[] = [];

    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      if (i % 10 === 0) {
        onProgress?.(`Describing ${i + 1}/${symbols.length}...`);
      }

      try {
        const response = await this.config.api.chat.completions.create({
          model: this.config.model,
          messages: [
            {
              role: 'user',
              content: `Describe the following ${sym.kind} in 1-2 sentences. Focus on what it does, its purpose, and its key behaviors. Be concise but specific enough for semantic search.\n\n${sym.sourceText}`,
            },
          ],
        });
        const description =
          response.choices[0]?.message?.content?.trim() ??
          `${sym.kind} ${sym.name}`;
        results.push({ name: sym.name, description });
      } catch {
        results.push({
          name: sym.name,
          description: `${sym.kind} ${sym.name}`,
        });
      }
    }

    return results;
  }

  private async walkDir(dir: string): Promise<string[]> {
    const results: string[] = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        results.push(...(await this.walkDir(fullPath)));
      } else if (entry.isFile()) {
        const ext = entry.name.includes('.')
          ? '.' + entry.name.split('.').pop()!
          : '';
        if (JS_TS_EXTS.has(ext)) {
          results.push(fullPath);
        }
      }
    }

    return results;
  }
}
