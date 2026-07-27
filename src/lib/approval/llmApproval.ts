import type { Api } from '../Agent.js';
import type { ApprovalDecision } from './matcher.js';

export interface LlmApprovalConfig {
  /** OpenAI-compatible API client. */
  api: Api;
  /** Model name to classify with. */
  model: string;
  /** Optional override for the classifier system prompt. */
  prompt?: string;
}

/**
 * System prompt for the bash-command safety classifier.
 *
 * The policy is deliberately permissive about *approving* (so the user is
 * rarely bothered for harmless commands) while staying conservative about
 * *rejecting* (only obvious danger) — everything in between is escalated to
 * a human via "PROMPT".
 *
 * `.matos` configuration files are treated as untouchable: the agent must
 * never be allowed to rewrite its own safety rules unattendetestd, so any
 * command that touches them must not be auto-approved.  (This is also
 * enforced structurally by `mentionsProtectedPath()` as defense-in-depth.)
 *
 * Design notes:
 *  - A concrete APPROVE example list is essential; without it the model has
 *    no positive anchor and over-classifies harmless read-only commands
 *    (notably `git diff`, `git log`, `git status`) as PROMPT.
 *  - The decision rule is framed as a positive checklist ("answer NO to
 *    every mutation question → APPROVE") rather than the impossible bar
 *    "100% harmless," which suppresses approvals by maximising uncertainty.
 *  - "When in doubt → PROMPT" is scoped to commands that *mutate state*,
 *    not to every command the model has any uncertainty about.
 */
export const DEFAULT_LLM_APPROVAL_PROMPT = `You are a safety classifier for shell commands run by an autonomous coding agent. Decide whether each command may run WITHOUT asking the user.

## Decision checklist

Answer these questions about the command. If the answer to EVERY question is "no", classify APPROVE:

1. Does it create, write, edit, move, rename, or delete any file or directory?
2. Does it install, uninstall, or update packages or system software?
3. Does it run a build, test, migration, or script that mutates the repository?
4. Does it make a state-changing network request (deploy, upload, POST/PUT)?
5. Does it change git history (commit, push, reset, rebase, merge, tag, stash apply)?
6. Does it modify system state (permissions, processes, services, environment)?
7. Does it read, write, or mention anything under a .matos/ directory?

Read-only and informational commands that change nothing should be APPROVE.

## Categories

- APPROVE — Read-only or display-only commands. They report or show information but modify no files, no system state, no git history, and no packages.
  Common examples (non-exhaustive):
  git diff, git diff *, git show, git log, git status, git branch, git blame,
  git ls-files, git rev-parse, git remote -v, ls, pwd, echo, cat, head, tail,
  wc, grep, rg, find, which, file, stat, du, df, env, printenv, uname, date,
  node -v, npm -v, bun -v, python --version.

- REJECT — Obviously malicious or destructive. Includes: rm -rf, wiping home
  or root, disk/partition operations (mkfs, dd), system power control (shutdown,
  reboot, halt), piping remote content into a shell (curl ... | sh, wget ... | bash),
  data exfiltration, killing critical processes, and disabling safety tools.

- PROMPT — The command CHANGES something and you are not sure it is safe. This
  includes writing/editing files, installing or removing packages, running
  migrations, making state-changing network requests, and build/test steps that
  alter the repo. If a command mutates state and you cannot determine it is
  safe, choose PROMPT.

Respond with exactly one word: APPROVE, REJECT, or PROMPT. Do not explain.`;

/**
 * Extract an {@link ApprovalDecision} from a raw LLM response.
 *
 * Searches for the *first* occurrence of APPROVE, REJECT, or PROMPT
 * (case-insensitive) and returns it.  Defaults to "prompt" when none of the
 * keywords appear — the safe fallback is always to ask a human rather than
 * silently run an unclassified command.
 */
export function parseLlmDecision(text: string): ApprovalDecision {
  const upper = text.toUpperCase();
  const keywords: ApprovalDecision[] = ['approve', 'reject', 'prompt'];

  let best: ApprovalDecision = 'prompt';
  let bestIdx = Infinity;
  for (const kw of keywords) {
    const i = upper.indexOf(kw.toUpperCase());
    if (i !== -1 && i < bestIdx) {
      bestIdx = i;
      best = kw;
    }
  }
  return best;
}

/**
 * Ask the LLM to classify a bash command as APPROVE, REJECT, or PROMPT.
 *
 * On any error (network, malformed response, empty content) the function
 * resolves to "prompt" — it never rejects and never auto-approves, so a
 * broken classifier degrades safely to a human review.
 */
export async function llmDecideApproval(
  config: LlmApprovalConfig,
  command: string,
): Promise<ApprovalDecision> {
  try {
    const completion = (await config.api.chat.completions.create({
      model: config.model,
      temperature: 0,
      max_tokens: 10,
      messages: [
        {
          role: 'system',
          content: config.prompt ?? DEFAULT_LLM_APPROVAL_PROMPT,
        },
        { role: 'user', content: command },
      ],
    } as any)) as any;

    const text: string = completion?.choices?.[0]?.message?.content ?? '';
    return parseLlmDecision(text);
  } catch {
    return 'prompt';
  }
}
