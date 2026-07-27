import { readFile } from 'fs/promises';
import { access, mkdir, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';

/**
 * Glob patterns governing automatic bash-tool approval.
 *
 * Rules are stored on disk as JSON:
 *
 * ```json
 * {
 *   "approve": ["git status", "git diff *", "npm test", "make *"],
 *   "reject": ["rm -rf *", "sudo *", "git push *"]
 * }
 * ```
 *
 * Patterns are matched against each command produced by splitting the
 * requested command (see `matcher.ts`).  Reject is authoritative.
 */
export interface ApprovalConfig {
  /** Glob patterns for commands to auto-approve. */
  approve: string[];
  /** Glob patterns for commands to auto-reject. */
  reject: string[];
}

export const DEFAULT_APPROVAL_CONFIG: ApprovalConfig = {
  approve: [],
  reject: [],
};

/**
 * Sensible default rules written to the global config on first run.
 *
 * `cd *` is included so compound commands like `cd subdir && bun test` in
 * monorepos are approved instantly — `cd` in a spawned shell only affects
 * that ephemeral process and is harmless.  Read-only git subcommands (diff,
 * log, show, status) are likewise included for fast rule-based approval.
 * State-changing git commands (commit, push, reset, etc.) are intentionally
 * left out — users can layer their own rules per-project or globally.
 */
export const DEFAULT_APPROVAL_RULES: ApprovalConfig = {
  approve: [
    'cd *',
    'git diff',
    'git diff *',
    'git log',
    'git log *',
    'git show',
    'git show *',
    'git status',
    'git status *',
    'bun test',
    'bun test *',
    'bun run build',
    'npm test',
    'npm test *',
    'npm run build',
    'tsc',
    'tsc *',
    'npx tsc',
    'npx tsc *',
    'npm run *',
    'bun run *',
    'make *',
    'ls',
    'ls *',
    'echo *',
    'cat *',
    'head *',
    'tail *',
    'wc *',
    'pwd',
    'grep *',
    'rg *',
  ],
  reject: [
    'rm -rf *',
    'rm -f *',
    'sudo *',
    'curl * | sh',
    'curl * | bash',
    'wget * | sh',
    'wget * | bash',
    'dd *',
    'mkfs *',
    'shutdown *',
    'reboot *',
    'halt *',
    'chmod 777 *',
  ],
};

/**
 * Commands that read file contents.  When auto-approved, these are gated to
 * `cwd` — any argument resolving outside the project triggers a prompt.
 * Prevents exfiltration of sensitive files (`~/.ssh/id_rsa`, `/etc/shadow`,
 * `.env`, etc.) without abandoning the convenience of auto-approval.
 */
export const FILE_READING_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
]);

export interface ApprovalConfigPaths {
  /** Override the global config path (default: `~/.matos/approval.json`). */
  globalPath?: string;
  /** Override the local config path (default: `./.matos/approval.json`). */
  localPath?: string;
}

async function loadConfigFile(path: string): Promise<ApprovalConfig | null> {
  try {
    await access(path);
  } catch {
    return null;
  }

  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ApprovalConfig>;
    return {
      approve: Array.isArray(parsed.approve)
        ? parsed.approve.filter((p) => typeof p === 'string')
        : [],
      reject: Array.isArray(parsed.reject)
        ? parsed.reject.filter((p) => typeof p === 'string')
        : [],
    };
  } catch (e) {
    console.warn(
      `[approval] Failed to parse ${path}: ${(e as Error).message}. Skipping.`,
    );
    return null;
  }
}

/**
 * Load approval configuration by merging the global config from
 * `~/.matos/approval.json` with the local config at `./.matos/approval.json`.
 * Lists are concatenated (global first, then local) so local additions
 * extend rather than replace the global rules.  Returns empty lists when no
 * config files are found or parseable.
 */
export async function loadApprovalConfig(
  paths: ApprovalConfigPaths = {},
): Promise<ApprovalConfig> {
  const globalPath =
    paths.globalPath ?? join(homedir(), '.matos', 'approval.json');
  const localPath =
    paths.localPath ?? join(process.cwd(), '.matos', 'approval.json');

  const [globalConfig, localConfig] = await Promise.all([
    loadConfigFile(globalPath),
    loadConfigFile(localPath),
  ]);

  return {
    approve: [
      ...(globalConfig?.approve ?? []),
      ...(localConfig?.approve ?? []),
    ],
    reject: [...(globalConfig?.reject ?? []), ...(localConfig?.reject ?? [])],
  };
}

/**
 * Write the default rules to the global config path if no file exists yet.
 * Never overwrites an existing file, never touches the local project config.
 * Returns `true` when a new file was created.
 */
export async function ensureApprovalConfig(
  globalPath: string = join(homedir(), '.matos', 'approval.json'),
): Promise<boolean> {
  try {
    await access(globalPath);
    return false; // already exists — leave it alone
  } catch {
    // doesn't exist — fall through and create it
  }

  try {
    await mkdir(dirname(globalPath), { recursive: true });
    await writeFile(
      globalPath,
      JSON.stringify(DEFAULT_APPROVAL_RULES, null, 2) + '\n',
      'utf-8',
    );
    return true;
  } catch (e) {
    console.warn(
      `[approval] Could not create default config at ${globalPath}: ${(e as Error).message}`,
    );
    return false;
  }
}

// ---------------------------------------------------------- protected paths

/**
 * Tools that can modify or remove files on disk.  These are intercepted by
 * the approval gate when they target a protected path.
 */
export const WRITE_TOOLS = new Set([
  'WriteFile',
  'EditFile',
  'DeleteFile',
  'RenameFile',
]);

/**
 * Resolved filesystem paths of the approval config files that must never be
 * silently modified.  Guarding these prevents the agent from rewriting its
 * own approval rules (or deleting them) via builtin file tools or bash.
 */
function getProtectedPaths(): string[] {
  return [
    resolve(process.cwd(), '.matos', 'approval.json'),
    resolve(homedir(), '.matos', 'approval.json'),
  ];
}

/**
 * Returns `true` when `inputPath` resolves to a protected approval-config
 * file (local or global).  Used to force interactive approval on file-tool
 * calls that target these files.
 */
export function isProtectedPath(inputPath: string): boolean {
  const resolved = resolve(inputPath);
  return getProtectedPaths().includes(resolved);
}

/**
 * Heuristic check for whether a bash command references a protected
 * approval-config file.  Used to downgrade an auto-approved command to an
 * interactive prompt when it touches the config.
 */
export function mentionsProtectedPath(command: string): boolean {
  return command.includes('.matos/approval.json');
}
