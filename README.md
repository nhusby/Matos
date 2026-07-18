WIP, usable, but consider it V0.0.1

## Bash command auto-approval

Bash commands normally require interactive approval. You can pre-approve or
pre-reject common commands with glob rules so they no longer prompt.

Create `.matos/approval.json` (project-local) and/or
`~/.matos/approval.json` (global) with two lists of
[minimatch](https://www.npmjs.com/package/minimatch) globs:

```json
{
  "approve": ["git status", "git diff *", "git log *", "npm test", "make *"],
  "reject": ["rm -rf *", "sudo *", "git push *"]
}
```

How it works:

- Each requested command is parsed with
  [bash-parser](https://www.npmjs.com/package/bash-parser) and split into its
  individual sub-commands (`a && b`, `a | b`, `a; b`, redirects, etc.).
- **Reject wins.** If *any* sub-command matches a `reject` rule the whole
  command is denied without prompting.
- A command is auto-approved only when *every* sub-command matches an
  `approve` rule.
- Anything else still prompts you interactively, exactly as before.

Glob `*` matches any run of characters (including path separators), so a rule
like `rm -rf *` reliably catches `rm -rf /some/important/path` and cannot be
bypassed by adding a slash. Editing the file takes effect immediately — no
restart needed.

**Redirects always prompt.** Commands containing shell redirect operators
(`>`, `>>`, `<`, `2>`, etc.) always require interactive approval, even when
they match an `approve` rule. This prevents a command like
`echo '{}' > important.txt` from silently overwriting files.

On first run, Matos writes a set of sensible defaults to
`~/.matos/approval.json` (if it doesn't exist yet). The defaults exclude git
commands so you can layer your own git rules without conflicts. You can edit
or remove this file at any time.

### Tamper protection

The approval config files (`.matos/approval.json` and
`~/.matos/approval.json`) are **protected** — the agent cannot silently
modify them. Any attempt to write, edit, delete, or rename these files
(whether via builtin file tools or a bash command like
`echo > .matos/approval.json`) will **always prompt for interactive
approval**, even if the command would otherwise be auto-approved. This
prevents the agent from rewriting its own approval rules.
