import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadApprovalConfig,
  ensureApprovalConfig,
  DEFAULT_APPROVAL_CONFIG,
  DEFAULT_APPROVAL_RULES,
  FILE_READING_COMMANDS,
  isProtectedPath,
  mentionsProtectedPath,
  WRITE_TOOLS,
} from '../../lib/approval/config.js';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { homedir } from 'os';

let tmpDir: string;
let missing: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'matos-approval-'));
  missing = join(tmpDir, 'does-not-exist.json');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test('loadApprovalConfig: missing files return empty config', async () => {
  const cfg = await loadApprovalConfig({
    globalPath: missing,
    localPath: missing,
  });
  expect(cfg).toEqual(DEFAULT_APPROVAL_CONFIG);
});

test('loadApprovalConfig: reads local config', async () => {
  const localPath = join(tmpDir, 'approval.json');
  await writeFile(
    localPath,
    JSON.stringify({ approve: ['git status'], reject: ['rm -rf *'] }),
  );
  const cfg = await loadApprovalConfig({ globalPath: missing, localPath });
  expect(cfg.approve).toEqual(['git status']);
  expect(cfg.reject).toEqual(['rm -rf *']);
});

test('loadApprovalConfig: merges global and local lists', async () => {
  const globalPath = join(tmpDir, 'global.json');
  const localPath = join(tmpDir, 'local.json');
  await writeFile(globalPath, JSON.stringify({ approve: ['git *'] }));
  await writeFile(
    localPath,
    JSON.stringify({ approve: ['npm test'], reject: ['sudo *'] }),
  );
  const cfg = await loadApprovalConfig({ globalPath, localPath });
  expect(cfg.approve).toEqual(['git *', 'npm test']);
  expect(cfg.reject).toEqual(['sudo *']);
});

test('loadApprovalConfig: malformed JSON is skipped', async () => {
  const localPath = join(tmpDir, 'approval.json');
  await writeFile(localPath, '{ not valid json');
  const cfg = await loadApprovalConfig({ globalPath: missing, localPath });
  expect(cfg).toEqual(DEFAULT_APPROVAL_CONFIG);
});

test('loadApprovalConfig: non-array fields are ignored', async () => {
  const localPath = join(tmpDir, 'approval.json');
  await writeFile(localPath, JSON.stringify({ approve: 'nope', reject: 42 }));
  const cfg = await loadApprovalConfig({ globalPath: missing, localPath });
  expect(cfg.approve).toEqual([]);
  expect(cfg.reject).toEqual([]);
});

test('loadApprovalConfig: non-string entries are filtered out', async () => {
  const localPath = join(tmpDir, 'approval.json');
  await writeFile(
    localPath,
    JSON.stringify({ approve: ['git status', 7, null, 'npm test'] }),
  );
  const cfg = await loadApprovalConfig({ globalPath: missing, localPath });
  expect(cfg.approve).toEqual(['git status', 'npm test']);
});

test('loadApprovalConfig: empty file returns empty config', async () => {
  const localPath = join(tmpDir, 'approval.json');
  await writeFile(localPath, '');
  const cfg = await loadApprovalConfig({ globalPath: missing, localPath });
  expect(cfg).toEqual(DEFAULT_APPROVAL_CONFIG);
});

// ------------------------------------------------------------- ensureApprovalConfig

test('ensureApprovalConfig: creates file with default rules when missing', async () => {
  const path = join(tmpDir, 'sub', 'approval.json');
  const created = await ensureApprovalConfig(path);
  expect(created).toBe(true);

  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw);
  expect(parsed.approve).toContain('bun test');
  expect(parsed.approve).toContain('npm test');
  expect(parsed.approve).toContain('npx tsc *');
  expect(parsed.reject).toContain('rm -rf *');
  expect(parsed.reject).toContain('sudo *');
});

test('ensureApprovalConfig: does not overwrite existing file', async () => {
  const path = join(tmpDir, 'approval.json');
  const custom = JSON.stringify({ approve: ['echo hi'], reject: [] });
  await writeFile(path, custom);

  const created = await ensureApprovalConfig(path);
  expect(created).toBe(false);

  const raw = await readFile(path, 'utf-8');
  expect(raw).toBe(custom);
});

test('ensureApprovalConfig: creates parent directories', async () => {
  const path = join(tmpDir, 'deeply', 'nested', 'dir', 'approval.json');
  const created = await ensureApprovalConfig(path);
  expect(created).toBe(true);

  const raw = await readFile(path, 'utf-8');
  expect(JSON.parse(raw)).toEqual(DEFAULT_APPROVAL_RULES);
});

test('ensureApprovalConfig: default rules have sane reject coverage', async () => {
  // Spot-check that dangerous ops are in the reject list.
  expect(DEFAULT_APPROVAL_RULES.reject).toEqual(
    expect.arrayContaining([
      'rm -rf *',
      'rm -f *',
      'sudo *',
      'curl * | sh',
      'dd *',
      'chmod 777 *',
    ]),
  );
});

test('DEFAULT_APPROVAL_RULES: read-only git commands are approved', () => {
  expect(DEFAULT_APPROVAL_RULES.approve).toContain('git diff');
  expect(DEFAULT_APPROVAL_RULES.approve).toContain('git diff *');
  expect(DEFAULT_APPROVAL_RULES.approve).toContain('git log');
  expect(DEFAULT_APPROVAL_RULES.approve).toContain('git log *');
  expect(DEFAULT_APPROVAL_RULES.approve).toContain('git show');
  expect(DEFAULT_APPROVAL_RULES.approve).toContain('git show *');
  expect(DEFAULT_APPROVAL_RULES.approve).toContain('git status');
  expect(DEFAULT_APPROVAL_RULES.approve).toContain('git status *');
});

test('DEFAULT_APPROVAL_RULES: cd is approved for monorepo workflows', () => {
  expect(DEFAULT_APPROVAL_RULES.approve).toContain('cd *');
});

test('DEFAULT_APPROVAL_RULES: state-changing git commands are NOT approved', () => {
  for (const rule of DEFAULT_APPROVAL_RULES.approve) {
    // Only read-only git subcommands should appear; nothing that commits,
    // pushes, resets, reverts, etc.
    if (rule.startsWith('git ')) {
      const sub = rule.split(' ')[1];
      expect(['diff', 'log', 'show', 'status']).toContain(sub);
    }
  }
  for (const rule of DEFAULT_APPROVAL_RULES.reject) {
    expect(rule.startsWith('git')).toBe(false);
  }
});

test('DEFAULT_APPROVAL_RULES: file-reading commands are in approve list', () => {
  expect(DEFAULT_APPROVAL_RULES.approve).toContain('cat *');
  expect(DEFAULT_APPROVAL_RULES.approve).toContain('head *');
  expect(DEFAULT_APPROVAL_RULES.approve).toContain('tail *');
  expect(DEFAULT_APPROVAL_RULES.approve).toContain('wc *');
  expect(DEFAULT_APPROVAL_RULES.approve).toContain('grep *');
  expect(DEFAULT_APPROVAL_RULES.approve).toContain('rg *');
});

// ------------------------------------------------------- FILE_READING_COMMANDS

test('FILE_READING_COMMANDS: contains expected read commands', () => {
  expect(FILE_READING_COMMANDS.has('cat')).toBe(true);
  expect(FILE_READING_COMMANDS.has('head')).toBe(true);
  expect(FILE_READING_COMMANDS.has('tail')).toBe(true);
  expect(FILE_READING_COMMANDS.has('wc')).toBe(true);
  expect(FILE_READING_COMMANDS.has('grep')).toBe(true);
  expect(FILE_READING_COMMANDS.has('rg')).toBe(true);
});

test('FILE_READING_COMMANDS: does not include non-reading commands', () => {
  expect(FILE_READING_COMMANDS.has('echo')).toBe(false);
  expect(FILE_READING_COMMANDS.has('ls')).toBe(false);
  expect(FILE_READING_COMMANDS.has('pwd')).toBe(false);
  expect(FILE_READING_COMMANDS.has('npm')).toBe(false);
});

// ------------------------------------------------------------- isProtectedPath

test('isProtectedPath: matches local .matos/approval.json', () => {
  expect(isProtectedPath('.matos/approval.json')).toBe(true);
  expect(isProtectedPath('./.matos/approval.json')).toBe(true);
  expect(
    isProtectedPath(resolve(process.cwd(), '.matos', 'approval.json')),
  ).toBe(true);
});

test('isProtectedPath: matches global ~/.matos/approval.json', () => {
  const globalPath = resolve(homedir(), '.matos', 'approval.json');
  expect(isProtectedPath(globalPath)).toBe(true);
  expect(isProtectedPath('~/.matos/approval.json')).toBe(
    // On most systems ~ is NOT expanded by resolve(), so this won't match.
    // Documenting that resolve does NOT expand ~:
    false,
  );
});

test('isProtectedPath: normalises traversal in path', () => {
  expect(isProtectedPath('.matos/../.matos/approval.json')).toBe(true);
  expect(isProtectedPath('.matos/sub/../approval.json')).toBe(true);
});

test('isProtectedPath: does NOT match unrelated files', () => {
  expect(isProtectedPath('src/index.ts')).toBe(false);
  expect(isProtectedPath('.matos/mcp.json')).toBe(false);
  expect(isProtectedPath('approval.json')).toBe(false); // wrong directory
  expect(isProtectedPath('.matos/other.json')).toBe(false);
});

// ------------------------------------------------------- mentionsProtectedPath

test('mentionsProtectedPath: catches relative path reference', () => {
  expect(mentionsProtectedPath('echo {} > .matos/approval.json')).toBe(true);
  expect(mentionsProtectedPath('cat .matos/approval.json')).toBe(true);
  expect(mentionsProtectedPath('rm .matos/approval.json')).toBe(true);
});

test('mentionsProtectedPath: catches home/global path reference', () => {
  expect(mentionsProtectedPath('cat ~/.matos/approval.json')).toBe(true);
  expect(mentionsProtectedPath('cp x /home/user/.matos/approval.json')).toBe(
    true,
  );
});

test('mentionsProtectedPath: catches piped/heredoc references', () => {
  expect(mentionsProtectedPath("sed -i 's/x/y/' .matos/approval.json")).toBe(
    true,
  );
  expect(
    mentionsProtectedPath('tee .matos/approval.json <<< \'{"approve":[]}\''),
  ).toBe(true);
});

test('mentionsProtectedPath: does NOT flag unrelated commands', () => {
  expect(mentionsProtectedPath('echo hello')).toBe(false);
  expect(mentionsProtectedPath('cat .matos/mcp.json')).toBe(false);
  expect(mentionsProtectedPath('npm test')).toBe(false);
  expect(mentionsProtectedPath('git status')).toBe(false);
});

// --------------------------------------------------------------- WRITE_TOOLS

test('WRITE_TOOLS: contains all file-modification tools', () => {
  expect(WRITE_TOOLS.has('WriteFile')).toBe(true);
  expect(WRITE_TOOLS.has('EditFile')).toBe(true);
  expect(WRITE_TOOLS.has('DeleteFile')).toBe(true);
  expect(WRITE_TOOLS.has('RenameFile')).toBe(true);
});

test('WRITE_TOOLS: does not include read-only tools', () => {
  expect(WRITE_TOOLS.has('ReadFile')).toBe(false);
  expect(WRITE_TOOLS.has('ListFiles')).toBe(false);
  expect(WRITE_TOOLS.has('RunBashCommand')).toBe(false);
});
