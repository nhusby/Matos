import { test, expect } from 'bun:test';
import {
  splitCommands,
  decideApproval,
  hasRedirect,
} from '../../lib/approval/matcher.js';
import type { ApprovalConfig } from '../../lib/approval/config.js';

const cfg = (
  approve: string[] = [],
  reject: string[] = [],
): ApprovalConfig => ({
  approve,
  reject,
});

// ---------------------------------------------------------------- splitCommands

test('splitCommands: simple command is unchanged', () => {
  expect(splitCommands('git status')).toEqual(['git status']);
});

test('splitCommands: strips surrounding quotes from args', () => {
  expect(splitCommands("git commit -m 'fix: thing'")).toEqual([
    'git commit -m fix: thing',
  ]);
});

test('splitCommands: logical && splits into parts', () => {
  expect(splitCommands('cd src && npm test')).toEqual(['cd src', 'npm test']);
});

test('splitCommands: mixed && and || splits all parts', () => {
  expect(splitCommands('npm run build && npm run test || true')).toEqual([
    'npm run build',
    'npm run test',
    'true',
  ]);
});

test('splitCommands: pipelines split into each stage', () => {
  expect(splitCommands('cat foo | grep bar')).toEqual(['cat foo', 'grep bar']);
});

test('splitCommands: redirects are preserved in the command string', () => {
  expect(splitCommands('echo hi > out.txt')).toEqual(['echo hi > out.txt']);
});

test('splitCommands: env-var prefix is preserved', () => {
  expect(splitCommands('FOO=bar ./script.sh')).toEqual(['FOO=bar ./script.sh']);
});

test('splitCommands: unparseable input falls back to the raw string', () => {
  const garbage = 'echo "unterminated';
  const out = splitCommands(garbage);
  expect(out).toEqual([garbage]);
});

// --------------------------------------------------------------- decideApproval

test('decideApproval: exact approve rule matches', () => {
  expect(decideApproval('git status', cfg(['git status'])).decision).toBe(
    'approve',
  );
});

test('decideApproval: glob approve rule matches', () => {
  expect(decideApproval('git add .', cfg(['git *'])).decision).toBe('approve');
  expect(decideApproval('git diff --stat', cfg(['git *'])).decision).toBe(
    'approve',
  );
});

test('decideApproval: no approve rules -> prompt', () => {
  expect(decideApproval('git status', cfg()).decision).toBe('prompt');
});

test('decideApproval: unmatched command -> prompt', () => {
  expect(
    decideApproval('git push', cfg(['git status', 'git diff *'])).decision,
  ).toBe('prompt');
});

test('decideApproval: glob does not over-match a bare name', () => {
  // `git` should NOT approve `git status`; users must be explicit.
  expect(decideApproval('git status', cfg(['git'])).decision).toBe('prompt');
});

test('decideApproval: reject takes precedence over approve', () => {
  const r = decideApproval('rm -rf x', cfg(['rm *'], ['rm -rf *']));
  expect(r.decision).toBe('reject');
  expect(r.rule).toBe('rm -rf *');
});

test('decideApproval: reject fires on any dangerous sub-command', () => {
  const r = decideApproval(
    'git status && rm -rf node_modules',
    cfg(['git *'], ['rm -rf *']),
  );
  expect(r.decision).toBe('reject');
  expect(r.matched).toBe('rm -rf node_modules');
});

test('decideApproval: reject rule cannot be bypassed by a path argument', () => {
  // Security check: `*` must span `/` so reject rules stay airtight.
  expect(
    decideApproval('rm -rf /important/dir', cfg([], ['rm -rf *'])).decision,
  ).toBe('reject');
});

test('decideApproval: approve requires every sub-command allow-listed', () => {
  expect(
    decideApproval('cd src && npm test', cfg(['cd *', 'npm *'])).decision,
  ).toBe('approve');
  // `rm` is not approved, not rejected -> prompt.
  expect(
    decideApproval('cd src && npm test && rm x', cfg(['cd *', 'npm *']))
      .decision,
  ).toBe('prompt');
});

test('decideApproval: approve glob spans path arguments', () => {
  expect(
    decideApproval('git add src/foo.ts', cfg(['git add *'])).decision,
  ).toBe('approve');
});

test('decideApproval: returns the split commands for diagnostics', () => {
  const r = decideApproval('a && b', cfg(['a', 'b']));
  expect(r.commands).toEqual(['a', 'b']);
  expect(r.decision).toBe('approve');
});

test('decideApproval: empty command prompts', () => {
  expect(decideApproval('', cfg(['*'])).decision).toBe('prompt');
});

// ----------------------------------------------------------------- hasRedirect

test('hasRedirect: detects output redirect', () => {
  expect(hasRedirect('echo hello > out.txt')).toBe(true);
});

test('hasRedirect: detects append redirect', () => {
  expect(hasRedirect('echo hello >> out.txt')).toBe(true);
});

test('hasRedirect: detects input redirect', () => {
  expect(hasRedirect('sort < input.txt')).toBe(true);
});

test('hasRedirect: detects redirect in compound command', () => {
  expect(hasRedirect('echo hi && cat foo > bar')).toBe(true);
});

test('hasRedirect: detects stderr redirect', () => {
  expect(hasRedirect('cmd 2> errors.txt')).toBe(true);
});

test('hasRedirect: does NOT flag stderr-to-stdout fd duplication', () => {
  expect(hasRedirect('cmd 2>&1')).toBe(false);
});

test('hasRedirect: does NOT flag fd duplication in compound command', () => {
  expect(hasRedirect('cmd 2>&1 | grep foo')).toBe(false);
});

test('hasRedirect: still flags fd redirect to a file', () => {
  // `>&file` redirects stdout+stderr to a real file — that writes to disk.
  expect(hasRedirect('cmd >& out.txt')).toBe(true);
});

test('hasRedirect: does NOT flag literal > inside quotes', () => {
  expect(hasRedirect("grep '>' file")).toBe(false);
  expect(hasRedirect("echo '5 > 3'")).toBe(false);
});

test('hasRedirect: does NOT flag plain commands', () => {
  expect(hasRedirect('echo hello')).toBe(false);
  expect(hasRedirect('git status')).toBe(false);
  expect(hasRedirect('npm test')).toBe(false);
});

// ------------------------------------------------------- decideApproval + redirects

test('decideApproval: redirect forces prompt even with approve rule', () => {
  // `echo *` is approved, but the redirect should override to prompt.
  expect(decideApproval('echo hi > out.txt', cfg(['echo *'])).decision).toBe(
    'prompt',
  );
});

test('decideApproval: redirect + append also prompts', () => {
  expect(decideApproval('echo hi >> out.txt', cfg(['echo *'])).decision).toBe(
    'prompt',
  );
});

test('decideApproval: stderr-to-stdout fd duplication does NOT force prompt', () => {
  // `2>&1` only combines streams — it cannot write to disk, so an approved
  // command should still be auto-approved.
  expect(decideApproval('cmd 2>&1', cfg(['cmd *'])).decision).toBe('approve');
});

test('decideApproval: reject still wins over redirect', () => {
  // Even with a redirect, a reject rule should deny outright.
  const r = decideApproval('rm -rf / > /dev/null', cfg([], ['rm -rf *']));
  expect(r.decision).toBe('reject');
});

// ------------------------------------------------------- decideApproval + cwd gating

test('decideApproval: cat within cwd is approved', () => {
  expect(
    decideApproval('cat src/index.ts', cfg(['cat *']), process.cwd()).decision,
  ).toBe('approve');
});

test('decideApproval: cat in cwd subdirectory is approved', () => {
  expect(
    decideApproval('cat src/lib/approval/config.ts', cfg(['cat *']), process.cwd())
      .decision,
  ).toBe('approve');
});

test('decideApproval: cat bare filename within cwd is approved', () => {
  expect(decideApproval('cat README.md', cfg(['cat *']), process.cwd()).decision).toBe(
    'approve',
  );
});

test('decideApproval: cat with home path (~) prompts', () => {
  expect(
    decideApproval('cat ~/.ssh/id_rsa', cfg(['cat *']), process.cwd()).decision,
  ).toBe('prompt');
});

test('decideApproval: cat with absolute path outside cwd prompts', () => {
  expect(
    decideApproval('cat /etc/passwd', cfg(['cat *']), process.cwd()).decision,
  ).toBe('prompt');
});

test('decideApproval: cat with traversal outside cwd prompts', () => {
  expect(
    decideApproval('cat ../../etc/passwd', cfg(['cat *']), process.cwd()).decision,
  ).toBe('prompt');
});

test('decideApproval: grep pattern file within cwd is approved', () => {
  expect(
    decideApproval('grep foo src/index.ts', cfg(['grep *']), process.cwd())
      .decision,
  ).toBe('approve');
});

test('decideApproval: grep with flags and file within cwd is approved', () => {
  expect(
    decideApproval('grep -rn foo src/', cfg(['grep *']), process.cwd()).decision,
  ).toBe('approve');
});

test('decideApproval: grep pattern file outside cwd prompts', () => {
  expect(
    decideApproval('grep foo /etc/passwd', cfg(['grep *']), process.cwd())
      .decision,
  ).toBe('prompt');
});

test('decideApproval: head outside cwd prompts', () => {
  expect(
    decideApproval('head ~/.ssh/id_rsa', cfg(['head *']), process.cwd()).decision,
  ).toBe('prompt');
});

test('decideApproval: wc outside cwd prompts', () => {
  expect(
    decideApproval('wc /etc/passwd', cfg(['wc *']), process.cwd()).decision,
  ).toBe('prompt');
});

test('decideApproval: non-file-reading command not affected by cwd gate', () => {
  expect(
    decideApproval('echo ~/.ssh/id_rsa', cfg(['echo *']), process.cwd()).decision,
  ).toBe('approve');
});

test('decideApproval: cat stdin (-) does not trigger cwd gate', () => {
  expect(decideApproval('cat -', cfg(['cat *']), process.cwd()).decision).toBe(
    'approve',
  );
});

test('decideApproval: cwd gate only applies when command would be approved', () => {
  // grep is cwd-gated but NOT in approve list — already prompts, gate is moot.
  expect(
    decideApproval('grep foo /etc/passwd', cfg(['npm test']), process.cwd())
      .decision,
  ).toBe('prompt');
});

test('decideApproval: compound command with escaping cat sub-command prompts', () => {
  // `head src/index.ts` is fine, but `cat /etc/passwd` escapes cwd.
  const r = decideApproval(
    'head src/index.ts && cat /etc/passwd',
    cfg(['head *', 'cat *']),
    process.cwd(),
  );
  expect(r.decision).toBe('prompt');
});
