export type Language = 'typescript' | 'tsx' | 'go' | 'python' | 'perl';

const EXT_TO_LANGUAGE: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'typescript',
  '.jsx': 'tsx',
  '.mjs': 'typescript',
  '.cjs': 'typescript',
  '.go': 'go',
  '.py': 'python',
  '.pyi': 'python',
  '.pl': 'perl',
  '.pm': 'perl',
  '.t': 'perl',
};

export const SUPPORTED_EXTENSIONS: Set<string> = new Set(Object.keys(EXT_TO_LANGUAGE));

export function languageForPath(filePath: string): Language | undefined {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return undefined;
  return EXT_TO_LANGUAGE[filePath.slice(dot).toLowerCase()];
}

export function isSupportedPath(filePath: string): boolean {
  return languageForPath(filePath) !== undefined;
}
