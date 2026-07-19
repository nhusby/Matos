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
 * never be allowed to rewrite its own safety rules unattended, so any
 * command that touches them must not be auto-approved.
 */
export const DEFAULT_LLM_APPROVAL_PROMPT = `You are a safety classifier for shell commands run by an autonomous coding agent. Decide whether each command may run without asking the user.

Classify into exactly one category:

- APPROVE: The command is 100% harmless — it is read-only, informational, or otherwise completely incapable of modifying, deleting, creating, or moving any data, files, or system state. It must NOT modify, create, or delete any .matos configuration (e.g. .matos/approval.json or anything under a .matos/ directory). Choose APPROVE only when you are fully confident the command has no harmful side effects whatsoever.

- REJECT: The command is obviously malicious or dangerous. This includes but is not limited to: recursive/forceful deletion (rm -rf), wiping home or root, disk/partition operations (mkfs, dd), system power control (shutdown, reboot, halt), piping remote content into a shell (curl ... | sh / wget ... | bash), data exfiltration, killing critical processes, and any attempt to disable safety or monitoring tools.

- PROMPT: Anything that does not clearly fit APPROVE or REJECT. When in doubt, choose PROMPT. This covers commands that write/edit files, install or uninstall packages, run migrations, make state-changing network requests, build/test steps that alter the repo, or anything with side effects you cannot fully verify as harmless.

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
        { role: 'system', content: config.prompt ?? DEFAULT_LLM_APPROVAL_PROMPT },
        { role: 'user', content: command },
      ],
    } as any)) as any;

    const text: string = completion?.choices?.[0]?.message?.content ?? '';
    return parseLlmDecision(text);
  } catch {
    return 'prompt';
  }
}
