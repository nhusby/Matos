# Matos

> WIP, usable, but consider it V0.0.1

Matos is an autonomous coding agent that runs in your terminal. It can read,
write, and edit files, run shell commands, search your codebase (text +
semantic), and connect to external tools via MCP. It talks to any
OpenAI-compatible API endpoint and supports reasoning models.

## Getting Started

Matos runs from source — there's no separate build step required. Clone the
repo and run it with either [Bun](https://bun.sh) or
[tsx](https://www.npmjs.com/package/tsx) (via npm).

### Prerequisites

- [Node.js](https://nodejs.org) 20+ (for tsx) **or** [Bun](https://bun.sh)
- An OpenAI-compatible API endpoint. Matos needs at minimum:
  - `OPENAI_API_KEY` — your API key
  - `OPENAI_BASE_URL` — the base URL of the endpoint

  Put these in a `.env` file in the project root (or export them in your
  shell). See [Configuration](#configuration) below.

### Option A — Run with Bun

```bash
git clone https://github.com/nhusby/Matos.git
cd Matos
bun install
bun src/cli.ts
```

### Option B — Run with tsx (npm)

```bash
git clone https://github.com/nhusby/Matos.git
cd Matos
npm install
npm run cli          # runs `tsx src/cli.ts`
```

### Install the `matos` command globally

The `bin/matos.js` shim boots the CLI under tsx. After `npm install`, link it
globally so `matos` works from any directory:

```bash
npm install -g .     # or: npm link
matos
```

### Building from source

To compile to plain JavaScript with `tsc`:

```bash
npm run build        # outputs to dist/
```

## Configuration

Matos looks for configuration in two places:

- **Global:** `~/.matos/` — applies to every project.
- **Local:** `./.matos/` (relative to your project root) — overrides/extends
  the global config for that project.

### Environment variables

Matos loads a `.env` file automatically (via
[dotenv](https://www.npmjs.com/package/dotenv)). Create one in your project
root:

```sh
# Required: connect to an OpenAI-compatible endpoint
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=http://localhost:8080/v1
```

At least one of `OPENAI_API_KEY` or `OPENAI_BASE_URL` must be set or Matos
will refuse to start. The model is auto-selected: Matos queries the endpoint
for the list of available models and picks the first match from its built-in
candidate list.

### REPL commands

Inside the Matos prompt:

| Command  | Action                                                        |
| -------- | ------------------------------------------------------------ |
| `/quit`  | Exit Matos.                                                  |
| `/think` | Toggle reasoning (chain-of-thought) display on/off.         |
| `/index` | Rebuild the semantic code index for the current project.    |
| `/resume`| Reload the saved conversation history.                      |
| `/clear` | Clear messages and the read-file cache — start fresh.       |

Press **ESC** to abort the current turn.

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

## MCP servers

Matos supports external tools via the
[Model Context Protocol](https://modelcontextprotocol.io/). Configure servers
in `~/.matos/mcp.json` (global) and/or `.matos/mcp.json` (project-local).
Local servers **override** global servers with the same name; otherwise the
two are merged.

```jsonc
{
  "mcpServers": {
    // stdio: spawn a local process
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"],
      "enabled": true
    },

    // HTTP / SSE: connect to a remote server
    "remote": {
      "url": "https://example.com/mcp",
      "enabled": ["specific_tool"]
    }
  }
}
```

Each server entry supports:

| Field               | Description                                                              |
| ------------------- | ----------------------------------------------------------------------- |
| `command`, `args`   | **stdio transport:** the executable and arguments to spawn.              |
| `env`               | **stdio:** environment variables for the spawned process.               |
| `url`, `headers`    | **HTTP/SSE transport:** server URL and optional request headers.        |
| `type`              | Transport type: `"stdio"`, `"sse"`, or `"http"`. Inferred if omitted.    |
| `enabled`           | `true` to auto-enable all tools, or a `string[]` of tool names to enable. |
| `approvalRequired`  | `true` to require approval for all tools, or a `string[]` of tool names.  |

Discovered tools that aren't auto-enabled are available on demand — the agent
enables them via the `EnableTool` tool and they remain active for 3 turns of
inactivity.

## Language servers (LSP)

Rename-symbol support for TS/JS uses the TypeScript Language Service. For
**Go, Python, and Perl**, Matos can use external LSP servers for
project-wide renames. Configure them in `~/.matos/config.json`:

```jsonc
{
  "languageServers": {
    "go":     { "command": "gopls",              "args": ["serve"] },
    "python": { "command": "pyright-langserver", "args": ["--stdio"] },
    "perl":   { "command": "perlnavigator",      "args": ["--stdio"] }
  }
}
```

Sensible defaults for `gopls`, `pyright-langserver`, and `perlnavigator` are
built in, so you only need to create this file to **override** a default or
add `initOptions`. Matos launches the right server automatically based on the
language of the file being edited. (You must have the server binary installed
and on your `PATH`.)

## Project files

Matos creates a few files and directories as you use it. None of them need
manual editing:

| Path                        | Scope     | Purpose                                              |
| --------------------------- | --------- | --------------------------------------------------- |
| `.matos/approval.json`      | Project   | Bash auto-approval rules (see above).               |
| `.matos/mcp.json`           | Project   | MCP server config (see above).                      |
| `.matos/history.json`       | Project   | Saved conversation — restored with `/resume`.       |
| `.code-rag-index/`          | Project   | Semantic code search vector index (built with `/index`). |
| `~/.matos/approval.json`    | Global    | Default approval rules (auto-created on first run). |
| `~/.matos/config.json`      | Global    | LSP language server config (see above).             |
| `~/.matos/mcp.json`         | Global    | MCP server config (see above).                      |
| `~/.matos/logs/<uuid>.jsonl`| Global    | Conversation logs (best-effort, one per session).   |

`.matos/` and `.code-rag-index/` are already in `.gitignore`, so they won't
clutter your repository.

## Development

```bash
npm run build    # compile TS → dist/
npm run format   # format with Prettier
npm test         # run the test suite (Bun)
```

The semantic index can be built as a standalone utility (uses the
`LLM_MODEL` env var for description generation):

```bash
npm run index    # runs `tsx src/index-code-rag.ts`
```
