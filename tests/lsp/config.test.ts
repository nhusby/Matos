import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadLspConfig, serverForLanguage, DEFAULT_SERVERS } from '../../src/lib/lsp/config.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'matos-cfg-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test('loadLspConfig: missing file returns defaults', async () => {
  const cfg = await loadLspConfig(join(tmpDir, 'missing.json'));
  expect(cfg.languageServers.go).toBeDefined();
  expect(cfg.languageServers.go?.command).toBe('gopls');
  expect(cfg.languageServers.python?.command).toBe('pyright-langserver');
  expect(cfg.languageServers.perl?.command).toBe('perlnavigator');
});

test('loadLspConfig: user config overrides defaults', async () => {
  const path = join(tmpDir, 'config.json');
  await writeFile(
    path,
    JSON.stringify({
      languageServers: {
        go: { command: 'custom-gopls', args: ['serve', '--debug'] },
      },
    }),
  );
  const cfg = await loadLspConfig(path);
  expect(cfg.languageServers.go?.command).toBe('custom-gopls');
  expect(cfg.languageServers.go?.args).toEqual(['serve', '--debug']);
});

test('loadLspConfig: user config merges with defaults', async () => {
  const path = join(tmpDir, 'config.json');
  await writeFile(
    path,
    JSON.stringify({
      languageServers: {
        go: { command: 'my-gopls', args: [] },
      },
    }),
  );
  const cfg = await loadLspConfig(path);
  expect(cfg.languageServers.go?.command).toBe('my-gopls');
  expect(cfg.languageServers.python?.command).toBe('pyright-langserver');
  expect(cfg.languageServers.perl?.command).toBe('perlnavigator');
});

test('loadLspConfig: malformed JSON falls back to defaults', async () => {
  const path = join(tmpDir, 'config.json');
  await writeFile(path, '{ this is not valid json');
  const cfg = await loadLspConfig(path);
  expect(cfg.languageServers.go?.command).toBe('gopls');
});

test('loadLspConfig: empty file falls back to defaults', async () => {
  const path = join(tmpDir, 'config.json');
  await writeFile(path, '');
  const cfg = await loadLspConfig(path);
  expect(cfg.languageServers.python?.command).toBe('pyright-langserver');
});

test('loadLspConfig: config without languageServers key returns defaults', async () => {
  const path = join(tmpDir, 'config.json');
  await writeFile(path, JSON.stringify({}));
  const cfg = await loadLspConfig(path);
  expect(cfg.languageServers.go).toBeDefined();
});

test('loadLspConfig: setting a default to null leaves it null (no implicit disable)', async () => {
  const path = join(tmpDir, 'config.json');
  await writeFile(
    path,
    JSON.stringify({
      languageServers: {
        perl: null,
      },
    }),
  );
  const cfg = await loadLspConfig(path);
  expect(cfg.languageServers.perl).toBeNull();
  expect(cfg.languageServers.go).toBeDefined();
});

test('loadLspConfig: user can add a new language server', async () => {
  const path = join(tmpDir, 'config.json');
  await writeFile(
    path,
    JSON.stringify({
      languageServers: {
        rust: { command: 'rust-analyzer', args: [] },
      },
    }),
  );
  const cfg = await loadLspConfig(path);
  expect((cfg.languageServers as any).rust?.command).toBe('rust-analyzer');
});

test('serverForLanguage: returns configured server', async () => {
  const cfg = await loadLspConfig(join(tmpDir, 'missing.json'));
  expect(serverForLanguage(cfg, 'go')?.command).toBe('gopls');
  expect(serverForLanguage(cfg, 'python')?.command).toBe('pyright-langserver');
});

test('serverForLanguage: returns undefined for unconfigured language', async () => {
  const cfg = await loadLspConfig(join(tmpDir, 'missing.json'));
  expect(serverForLanguage(cfg, 'typescript')).toBeUndefined();
});

test('DEFAULT_SERVERS exposes default map', () => {
  expect(DEFAULT_SERVERS.go?.command).toBe('gopls');
  expect(DEFAULT_SERVERS.python?.command).toBe('pyright-langserver');
  expect(DEFAULT_SERVERS.perl?.command).toBe('perlnavigator');
});
