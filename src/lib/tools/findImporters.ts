import { readdir, readFile, stat } from 'fs/promises';
import { resolve, join, relative, basename, extname } from 'path';
import { languageForPath } from '../parsers/languages.js';
import { scanImports } from '../parsers/extractors.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

function fileStem(fileName: string): string {
  const ext = extname(fileName);
  return ext ? fileName.slice(0, -ext.length) : fileName;
}

function matchesTarget(source: string, targetStem: string): boolean {
  if (!source) return false;
  const tail = source.split('/').pop() ?? source;
  const cleanTail = tail.replace(
    /\.(ts|tsx|js|jsx|mjs|cjs|go|py|pl|pm|t)$/i,
    '',
  );
  return cleanTail === targetStem || tail === targetStem;
}

export async function findImporters(
  filePath: string,
  root: string = process.cwd(),
): Promise<string[]> {
  const resolved = resolve(filePath);
  const fileStat = await stat(resolved).catch(() => null);
  if (!fileStat?.isFile()) return [];

  const fileName = basename(resolved);
  const lang = languageForPath(fileName);
  if (!lang) return [];

  const targetStem = fileStem(fileName);
  const importers: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(fullPath);
      } else if (entry.isFile()) {
        const entryLang = languageForPath(entry.name);
        if (!entryLang) continue;

        try {
          const content = await readFile(fullPath, 'utf-8');
          const imports = scanImports(fullPath, content);
          const hits = imports.filter((imp) =>
            matchesTarget(imp.source, targetStem),
          );
          if (hits.length) {
            const rel = relative(root, fullPath);
            const preview = hits[0]!.source.slice(0, 80);
            importers.push(`${rel}: ${preview}`);
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  await walk(root);
  return importers;
}
