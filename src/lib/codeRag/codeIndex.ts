import { createHash } from 'crypto';
import { readdir, readFile, stat, writeFile } from 'fs/promises';
import { resolve, join, relative } from 'path';
import ignore from 'ignore';
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
const ALWAYS_SKIP_DIRS = new Set(['node_modules', 'dist', 'build']);

const MAX_FILE_BYTES = 1_048_576; // 1 MB — skip before reading into memory

interface IgnoreCtx {
  global: ReturnType<typeof ignore>;
  local: ReturnType<typeof ignore>[];
}

async function readIgnoreFile(
  dir: string,
  filename: string,
): Promise<string[]> {
  try {
    return (await readFile(join(dir, filename), 'utf-8'))
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('#'));
  } catch {
    return [];
  }
}
const MAX_LINES = 5_000; // skip files exceeding this line count
const MINIFIED_AVG_LINE = 500; // avg chars/line above which source looks minified

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

  /** Delete all indexed items for a file and remove it from the hash cache. */
  private async purgeFilePath(filePath: string): Promise<number> {
    const items = await this.index.listItemsByMetadata({
      filePath: { $eq: filePath },
    });
    for (const item of items) await this.index.deleteItem(item.id);
    delete this.hashCache[filePath];
    return items.length;
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
    const globalPatterns = [
      ...(await readIgnoreFile(this.config.projectRoot, '.gitignore')),
      ...(await readIgnoreFile(this.config.projectRoot, '.aiignore')),
    ];
    const ignoreCtx: IgnoreCtx = {
      global: ignore().add(globalPatterns),
      local: [],
    };
    const filesOnDisk = await this.walkDir(
      this.config.projectRoot,
      this.config.projectRoot,
      ignoreCtx,
    );
    stats.totalFiles = filesOnDisk.length;

    const cachedPaths = new Set(Object.keys(this.hashCache));
    const diskPaths = new Set(filesOnDisk);

    const deletedPaths = [...cachedPaths].filter((p) => !diskPaths.has(p));
    stats.deletedFiles = deletedPaths.length;

    if (deletedPaths.length > 0) {
      onProgress?.(`Removing ${deletedPaths.length} deleted file(s)...`);
      for (const filePath of deletedPaths) {
        stats.removedSymbols += await this.purgeFilePath(filePath);
      }
    }

    // Single pass: read, hash, and extract symbols for each changed file in
    // one iteration so we hold at most one file's source in memory at a time.
    // (Previously every changed file's full content was accumulated in an
    // array, and worse, copied onto each of its symbols — and that copy was
    // never even read downstream. That O(symbols x fileSize) blowup exhausted
    // the heap on large projects.)
    onProgress?.(`Processing ${filesOnDisk.length} file(s)...`);
    const changedFiles: string[] = [];
    const allSymbols: ExtractedSymbol[] = [];
    let skippedFiles = 0;

    for (const filePath of filesOnDisk) {
      // Pre-read size guard: avoid loading giant files into memory at all.
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_FILE_BYTES) {
        const rel = relative(this.config.projectRoot, filePath);
        onProgress?.(
          `Skipping large file (${(fileStat.size / 1024).toFixed(0)} KB): ${rel}`,
        );
        skippedFiles++;
        if (this.hashCache[filePath])
          stats.removedSymbols += await this.purgeFilePath(filePath);
        continue;
      }

      const content = await readFile(filePath, 'utf-8');

      // Post-read checks: line count and minification heuristic.
      const lineCount = content.split('\n').length;
      const avgLineLen = lineCount > 0 ? content.length / lineCount : 0;
      if (lineCount > MAX_LINES || avgLineLen > MINIFIED_AVG_LINE) {
        const reason =
          lineCount > MAX_LINES ? `${lineCount} lines` : 'minified';
        const rel = relative(this.config.projectRoot, filePath);
        onProgress?.(`Skipping ${reason} file: ${rel}`);
        skippedFiles++;
        if (this.hashCache[filePath])
          stats.removedSymbols += await this.purgeFilePath(filePath);
        continue;
      }

      const hash = createHash('sha256').update(content).digest('hex');
      if (this.hashCache[filePath] === hash) continue;
      if (cachedPaths.has(filePath)) stats.changedFiles++;
      else stats.newFiles++;
      changedFiles.push(filePath);
      this.hashCache[filePath] = hash;

      allSymbols.push(...extractSymbols(filePath, content));
      // `content` falls out of scope here and is GC-eligible before the next
      // file is read.
    }

    if (skippedFiles > 0)
      onProgress?.(`Skipped ${skippedFiles} large/minified file(s).`);
    stats.totalSymbols = allSymbols.length;

    if (changedFiles.length === 0 && deletedPaths.length === 0) {
      onProgress?.('Index is up to date.');
      return stats;
    }

    onProgress?.(
      `Generating descriptions for ${allSymbols.length} symbol(s)...`,
    );
    const descriptions = await this.generateDescriptions(
      allSymbols,
      onProgress,
    );

    onProgress?.(`Embedding ${descriptions.length} description(s)...`);
    // Embed in bounded batches so we never materialize every vector at once.
    const EMBED_BATCH = 64;
    const vectors: number[][] = [];
    for (let i = 0; i < descriptions.length; i += EMBED_BATCH) {
      const slice = descriptions
        .slice(i, i + EMBED_BATCH)
        .map((d) => d.description);
      const resp = await this.config.embeddings.createEmbeddings(slice);
      vectors.push(...(resp.output ?? []));
    }

    onProgress?.('Updating index...');
    for (const filePath of changedFiles) {
      stats.removedSymbols += await this.purgeFilePath(filePath);
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

  private async walkDir(
    dir: string,
    root: string,
    ctx: IgnoreCtx,
  ): Promise<string[]> {
    const results: string[] = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    const relDir = relative(root, dir);
    const prefix = relDir ? relDir + '/' : '';

    const localPatterns =
      dir === root
        ? []
        : [
            ...(await readIgnoreFile(dir, '.gitignore')),
            ...(await readIgnoreFile(dir, '.aiignore')),
          ];
    const localIg = localPatterns.length
      ? ignore().add(localPatterns)
      : null;

    const childCtx: IgnoreCtx = {
      global: ctx.global,
      local: localIg ? [...ctx.local, localIg] : ctx.local,
    };

    for (const entry of entries) {
      // Skip dot-files/dirs (.git, .code-rag-index, etc.)
      if (entry.name.startsWith('.')) continue;

      const relPath = prefix + entry.name;
      // Global ignore patterns (root .gitignore + .aiignore)
      if (
        ctx.global.ignores(relPath) ||
        (entry.isDirectory() && ctx.global.ignores(relPath + '/'))
      )
        continue;

      // Parent + local ignore patterns
      const nameCheck = entry.isDirectory()
        ? entry.name + '/'
        : entry.name;
      let skip = false;
      for (const ig of ctx.local) {
        if (ig.ignores(entry.name) || ig.ignores(nameCheck)) {
          skip = true;
          break;
        }
      }
      if (!skip && localIg && (localIg.ignores(entry.name) || localIg.ignores(nameCheck)))
        skip = true;
      if (skip) continue;

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
        results.push(...(await this.walkDir(fullPath, root, childCtx)));
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
