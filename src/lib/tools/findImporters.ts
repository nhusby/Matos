import { readdir, readFile, stat } from 'fs/promises';
import { resolve, join, relative, basename } from 'path';

const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export async function findImporters(filePath: string): Promise<string[]> {
  const resolved = resolve(filePath);
  const fileStat = await stat(resolved).catch(() => null);
  if (!fileStat?.isFile()) return [];

  const fileName = basename(resolved);
  const ext = fileName.includes('.') ? '.' + fileName.split('.').pop()!.toLowerCase() : '';
  if (!TS_JS_EXTENSIONS.has(ext)) return [];

  const stem = ext ? fileName.slice(0, -ext.length) : fileName;
  const escapedStem = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const importPattern = escapedStem + '(?:\\.(?:ts|tsx|js|jsx|mjs|cjs))?';

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
        if (['node_modules', '.git', 'dist', 'build'].includes(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        await walk(fullPath);
      } else if (entry.isFile()) {
        const fext = entry.name.includes('.') ? '.' + entry.name.split('.').pop()!.toLowerCase() : '';
        if (!TS_JS_EXTENSIONS.has(fext)) continue;

        try {
          const content = await readFile(fullPath, 'utf-8');
          const regexStr = "(?:import|export)\\s+(?:[\\s\\S]*?\\s+from\\s+|[\\'\\\"\\{])\\s*[\\'\"]([^\\'\"]*?/(?:\\\\.\\\\.\\/)*[^\\/]*?" + importPattern + ")[\\'\"]|require\\s*\\(\\s*[\\'\"]([^\\'\"]*?" + importPattern + ")[\\'\"\\s]*\\)";
          const pattern = new RegExp(regexStr, 'g');
          let match;
          while ((match = pattern.exec(content)) !== null) {
            importers.push(`${relative(process.cwd(), fullPath)}: ${match[0].trim().slice(0, 100)}`);
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  await walk(process.cwd());
  return importers;
}
