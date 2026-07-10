import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import type { Language } from '../parsers/languages.js';

export interface LspServerConfig {
  command: string;
  args: string[];
  initOptions?: Record<string, unknown>;
}

export type LspServerMap = Partial<Record<Language, LspServerConfig>>;

export interface LspConfig {
  languageServers: LspServerMap;
}

export const DEFAULT_SERVERS: LspServerMap = {
  go: { command: 'gopls', args: ['serve'] },
  python: { command: 'pyright-langserver', args: ['--stdio'] },
  perl: { command: 'perlnavigator', args: ['--stdio'] },
};

const DEFAULT_CONFIG_PATH = join(homedir(), '.matos', 'config.json');

export async function loadLspConfig(path: string = DEFAULT_CONFIG_PATH): Promise<LspConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return { languageServers: { ...DEFAULT_SERVERS } };
  }

  let parsed: Partial<LspConfig>;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`[lsp] Failed to parse ${path}: ${(e as Error).message}. Using defaults.`);
    return { languageServers: { ...DEFAULT_SERVERS } };
  }

  const userServers = parsed.languageServers ?? {};
  return {
    languageServers: { ...DEFAULT_SERVERS, ...userServers },
  };
}

export function serverForLanguage(config: LspConfig, lang: Language): LspServerConfig | undefined {
  return config.languageServers[lang];
}
