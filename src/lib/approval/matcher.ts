import parse from 'bash-parser';
import { minimatch } from 'minimatch';
import { resolve, sep } from 'path';
import { homedir } from 'os';
import { FILE_READING_COMMANDS } from './config.js';
import type { ApprovalConfig } from './config.js';

export type ApprovalDecision = 'approve' | 'reject' | 'prompt';

export interface ApprovalResult {
  decision: ApprovalDecision;
  /** Every leaf command the input was split into. */
  commands: string[];
  /** The sub-command that triggered a reject (for messaging). */
  matched?: string;
  /** The rule that matched (for messaging). */
  rule?: string;
}

/*
 * bash-parser AST nodes are duck-typed; treat them loosely so the walker
 * keeps working even if the grammar adds new composite node types.
 */
type AstNode = any;

/**
 * Rebuild a leaf `Command` node into a flat, matchable string, e.g.
 * `git commit -m "x"` -> `git commit -m x`.  Environment assignments
 * (`FOO=bar cmd`) and redirections (`echo hi > out`) are preserved.
 */
function commandToString(cmd: AstNode): string {
  if (!cmd || typeof cmd !== 'object') return '';
  const parts: string[] = [];

  if (Array.isArray(cmd.prefix)) {
    for (const p of cmd.prefix) {
      if (p && typeof p.text === 'string') parts.push(p.text);
    }
  }

  if (cmd.name && typeof cmd.name.text === 'string') {
    parts.push(cmd.name.text);
  }

  if (Array.isArray(cmd.suffix)) {
    for (const s of cmd.suffix) {
      if (!s || typeof s !== 'object') continue;
      if (s.type === 'Redirect') {
        const op = s.op?.text ?? '';
        const file = s.file?.text ?? '';
        const frag = `${op} ${file}`.trim();
        if (frag) parts.push(frag);
      } else if (typeof s.text === 'string') {
        parts.push(s.text);
      }
    }
  }

  return parts.join(' ');
}

/**
 * Recursively collect leaf `Command` nodes from a bash-parser AST.
 * Handles pipelines (`a | b`), logical operators (`a && b`, `a || b`),
 * sequences (`a; b`), subshells, command substitution, and anything else
 * the grammar wraps commands in.  Unknown composite nodes are recursed
 * into defensively so embedded commands are never silently skipped.
 */
function collectCommands(node: AstNode, out: AstNode[]): void {
  if (!node || typeof node !== 'object') return;

  switch (node.type) {
    case 'Command':
      out.push(node);
      return;
    case 'Pipeline':
    case 'Script':
      if (Array.isArray(node.commands)) {
        for (const c of node.commands) collectCommands(c, out);
      }
      return;
    case 'LogicalExpression':
      collectCommands(node.left, out);
      collectCommands(node.right, out);
      return;
    default: {
      // Recurse into any object/array-valued children.  Word nodes only hold
      // scalar fields, so they terminate cleanly here.
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item && typeof item === 'object') collectCommands(item, out);
          }
        } else if (value && typeof value === 'object') {
          collectCommands(value, out);
        }
      }
      return;
    }
  }
}

/**
 * Break a (possibly compound) bash command into its individual leaf
 * commands, each rendered back to a flat string.  If the input cannot be
 * parsed, the original command is returned unchanged so callers can fall
 * back to manual approval (safe default — never auto-approve garbage).
 */
export function splitCommands(command: string): string[] {
  let ast: AstNode;
  try {
    ast = parse(command);
  } catch {
    return [command];
  }

  const cmds: AstNode[] = [];
  collectCommands(ast, cmds);

  const rendered = cmds.map(commandToString).filter((s) => s.trim().length > 0);

  return rendered.length > 0 ? rendered : [command];
}

/**
 * A redirect is a pure file-descriptor duplication (e.g. `2>&1`) when it uses
 * the `>&` (greatand) operator and targets a numeric fd.  Such redirects only
 * rewire streams within the process — they never touch the filesystem — so they
 * are safe to auto-approve and must NOT be treated as disk-writing redirects.
 */
function isFdDuplication(node: AstNode): boolean {
  if (!node || node.type !== 'Redirect') return false;
  const op = node.op?.text ?? '';
  const target = node.file?.text ?? '';
  return op === '>&' && /^\d+$/.test(target);
}

/**
 * Recursively search a bash-parser AST for any disk-writing `Redirect` node.
 * This catches `>`, `>>`, `<`, `<<`, `2>`, `&>` and friends — every shell
 * redirect form.  Pure fd duplications like `2>&1` are deliberately excluded
 * since they cannot create or modify files.
 */
function findRedirectNodes(node: AstNode): boolean {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'Redirect') return !isFdDuplication(node);

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && findRedirectNodes(item)) {
          return true;
        }
      }
    } else if (value && typeof value === 'object') {
      if (findRedirectNodes(value)) return true;
    }
  }
  return false;
}

/**
 * Returns `true` when `command` contains any disk-writing shell redirect
 * operators (`>`, `>>`, `<`, `<<`, `2>`, etc.).  Pure file-descriptor
 * duplications such as `2>&1` are ignored — they only combine streams and
 * cannot create or modify files.  Uses the parsed AST so that a literal `>`
 * inside an argument (e.g. `grep '>' file`) is NOT a false-positive.  Falls
 * back to a conservative regex if parsing fails.
 */
export function hasRedirect(command: string): boolean {
  let ast: AstNode;
  try {
    ast = parse(command);
  } catch {
    // Unparseable — be conservative and force approval on any < or >.
    return /[<>]/.test(command);
  }
  return findRedirectNodes(ast);
}

/**
 * Internal placeholder substituted for `/` so that minimatch's `*` (which
 * never crosses a path separator) can span path arguments.  Command lines
 * are flat strings, not paths, and a reject rule like `rm -rf *` must still
 * catch `rm -rf /some/important/path`.
 */
const SLASH_PLACEHOLDER = '\x01';

/** True if `text` matches a single glob `pattern`. */
function matchesOne(text: string, pattern: string): boolean {
  // Literal match honours explicit `/` boundaries in hand-written patterns.
  if (minimatch(text, pattern)) return true;
  // Flat match lets `*` span path separators (commands are not paths).
  return minimatch(text.replace(/\//g, SLASH_PLACEHOLDER), pattern);
}

/** True if `text` matches any of the glob `patterns`. */
function matchesAny(text: string, patterns: string[]): boolean {
  return patterns.some((p) => typeof p === 'string' && matchesOne(text, p));
}

/** The specific pattern that matched, if any (for diagnostics). */
function firstMatch(text: string, patterns: string[]): string | undefined {
  return patterns.find((p) => typeof p === 'string' && matchesOne(text, p));
}

// ---------------------------------------------------------- cwd confinement

/**
 * True when `filePath` resolves to `cwd` or somewhere beneath it.
 */
function isWithinCwd(filePath: string, cwd: string): boolean {
  const r = resolve(filePath);
  return r === cwd || r.startsWith(cwd + sep);
}

/**
 * Check whether any file-reading sub-command targets a path outside `cwd`.
 * Expands `~` so home-directory references are caught.  Returns `true`
 * (conservative escape) when the command cannot be parsed so that the caller
 * forces interactive approval rather than auto-approving garbage.
 */
function escapesCwd(command: string, cwd: string): boolean {
  let ast: AstNode;
  try {
    ast = parse(command);
  } catch {
    return true;
  }

  const cmds: AstNode[] = [];
  collectCommands(ast, cmds);

  const home = homedir();

  for (const cmd of cmds) {
    const name = cmd.name?.text ?? '';
    if (!FILE_READING_COMMANDS.has(name)) continue;

    if (!Array.isArray(cmd.suffix)) continue;
    for (const arg of cmd.suffix) {
      if (!arg || typeof arg !== 'object') continue;
      if (arg.type === 'Redirect') continue;

      const text = arg.text;
      if (typeof text !== 'string') continue;
      if (text.startsWith('-')) continue; // flags

      // Expand ~ so home paths resolve outside cwd.
      const expanded = text.startsWith('~') ? home + text.slice(1) : text;

      if (!isWithinCwd(expanded, cwd)) return true;
    }
  }

  return false;
}

/**
 * Decide whether a bash command should be auto-approved, auto-rejected, or
 * presented to the user for manual approval.
 *
 * Policy (reject is authoritative for safety):
 *  - If ANY sub-command matches a reject rule -> `reject`
 *  - Else if ALL sub-commands match an approve rule -> `approve`
 *  - Otherwise -> `prompt`
 */
export function decideApproval(
  command: string,
  config: ApprovalConfig,
  cwd: string = process.cwd(),
): ApprovalResult {
  const commands = splitCommands(command);

  // Reject first: a single dangerous sub-command denies the whole thing.
  for (const cmd of commands) {
    const rule = firstMatch(cmd, config.reject);
    if (rule !== undefined) {
      return { decision: 'reject', commands, matched: cmd, rule };
    }
  }

  // Disk-writing redirects can create, overwrite, or truncate arbitrary files
  // on disk.  Never auto-approve them — force interactive approval every time.
  // (Pure fd duplications like `2>&1` are ignored as they cannot touch files.)
  if (hasRedirect(command)) {
    return { decision: 'prompt', commands };
  }

  // Approve only when every sub-command is explicitly allow-listed.
  if (
    config.approve.length > 0 &&
    commands.every((c) => matchesAny(c, config.approve))
  ) {
    // File-reading commands (cat, head, grep, etc.) are confined to cwd.
    // Any argument escaping the project downgrades to interactive approval.
    if (escapesCwd(command, cwd)) {
      return { decision: 'prompt', commands };
    }
    return { decision: 'approve', commands };
  }

  return { decision: 'prompt', commands };
}
