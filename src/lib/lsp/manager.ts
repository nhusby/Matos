import { readdir, access } from 'fs/promises';
import { join, extname } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { languageForPath, type Language } from '../parsers/languages.js';
import { loadLspConfig, type LspServerConfig } from './config.js';
import { LspClient } from './client.js';

const execAsync = promisify(exec);

const SUPPORTED_EXTS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.go',
  '.py',
  '.pyi',
  '.pl',
  '.pm',
  '.t',
];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.code-rag-index',
  '.idea',
]);

class LspManager {
  private clients = new Map<Language, LspClient>();
  private startedByUs = new Set<Language>();
  private serverConfigs: Partial<Record<Language, LspServerConfig>> = {};
  private loaded = false;

  async loadConfig(): Promise<void> {
    if (this.loaded) return;
    const cfg = await loadLspConfig();
    this.serverConfigs = cfg.languageServers;
    this.loaded = true;
  }

  async detectLanguages(root: string): Promise<Set<Language>> {
    const found = new Set<Language>();
    await this.walk(root, found, 0);
    return found;
  }

  private async walk(
    dir: string,
    found: Set<Language>,
    depth: number,
  ): Promise<void> {
    if (depth > 6) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await this.walk(full, found, depth + 1);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (!SUPPORTED_EXTS.includes(ext)) continue;
        const lang = languageForPath(entry.name);
        if (lang && lang !== 'typescript' && lang !== 'tsx') {
          found.add(lang);
        }
      }
    }
  }

  async commandOnPath(command: string): Promise<boolean> {
    try {
      const result = await execAsync(`which ${command}`);
      return (result.stdout?.trim()?.length ?? 0) > 0;
    } catch {
      return false;
    }
  }

  async startDetected(root: string): Promise<void> {
    await this.loadConfig();
    const languages = await this.detectLanguages(root);
    if (languages.size === 0) return;

    console.log(`[lsp] detected languages: ${[...languages].join(', ')}`);

    await Promise.all(
      [...languages].map((lang) => this.startForLanguage(lang, root)),
    );
  }

  private async startForLanguage(lang: Language, root: string): Promise<void> {
    if (this.clients.has(lang)) return;
    const config = this.serverConfigs[lang];
    if (!config) {
      console.warn(
        `[lsp:${lang}] no server configured in ~/.matos/config.json`,
      );
      return;
    }
    const exists = await this.commandOnPath(config.command);
    if (!exists) {
      console.warn(
        `[lsp:${lang}] "${config.command}" not found on PATH — semantic tools disabled for ${lang}`,
      );
      return;
    }
    const client = new LspClient(lang, config, root);
    try {
      await client.start();
      this.clients.set(lang, client);
      this.startedByUs.add(lang);
      console.log(`[lsp:${lang}] started ${config.command}`);
    } catch (e) {
      console.warn(`[lsp:${lang}] failed to start: ${(e as Error).message}`);
    }
  }

  getClient(lang: Language): LspClient | undefined {
    return this.clients.get(lang);
  }

  hasClient(lang: Language): boolean {
    const client = this.clients.get(lang);
    return client !== undefined && client.isReady;
  }

  async notifyWrote(filePath: string, newText: string): Promise<void> {
    const lang = languageForPath(filePath);
    if (!lang) return;
    const client = this.clients.get(lang);
    if (!client || !client.isReady) return;
    try {
      await client.notifyDidChange(filePath, newText);
    } catch {
      // best-effort sync
    }
  }

  async shutdownAll(): Promise<void> {
    const stoppers = [...this.startedByUs].map(async (lang) => {
      const client = this.clients.get(lang);
      if (!client) return;
      try {
        await client.shutdown();
        console.log(`[lsp:${lang}] stopped`);
      } catch (e) {
        console.warn(`[lsp:${lang}] shutdown error:`, (e as Error).message);
      }
    });
    await Promise.all(stoppers);
    this.clients.clear();
    this.startedByUs.clear();
  }
}

export const lspManager = new LspManager();
