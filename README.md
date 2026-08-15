# Local Coding Agent CLI

A terminal-first coding agent powered by a model running in LM Studio. It works directly inside a project folder and can inspect code, create or edit files, delete files, and run commands and tests. No browser or local web server is required.

## Start the agent

Prerequisites:

- Node.js 20 or newer
- pnpm (`corepack enable` usually installs it)
- LM Studio with a model loaded and its OpenAI-compatible local server enabled
- LM Link forwarding that server to `http://localhost:1234`, if LM Studio runs on another machine

The CLI has no third-party runtime dependencies. On this Mac, use the included launcher; it automatically finds the bundled Node runtime:

```bash
./agent /absolute/path/to/your/project
```

If Node and pnpm are installed normally, you can also use the package script:

```bash
pnpm agent -- /absolute/path/to/your/project
```

Relative paths also work:

```bash
pnpm agent -- ../my-project
```

If no path is supplied, the agent opens the terminal's current directory:

```bash
cd /path/to/your/project
/path/to/local-coding-agent/cli/index.js
```

You can also make `coding-agent` available as a command with `pnpm link --global`, then run it from any project:

```bash
cd /path/to/your/project
coding-agent
```

## Use it

Type a coding task at the `you ❯` prompt. Responses stream into the terminal. Read-only tools run automatically; the agent asks permission before writing, appending, deleting, or running a shell command.

Example:

```text
you ❯ Find the failing authentication test, fix the bug, and run the focused test
```

Approval choices are:

- `y` — allow this tool call
- `n` or Enter — deny it
- `a` — allow all changes and commands for the rest of the session

Terminal commands:

| Command | Action |
| --- | --- |
| `/help` | Show command help |
| `/project <path>` (alias `/cd`) | Switch projects and clear old project context |
| `/add-dir <path>` | Grant the file tools access to another folder for this session |
| `/server <url>` | Change the LM Studio server URL at runtime |
| `/models` | List models currently loaded in LM Studio |
| `/model <id\|auto>` | Select a model |
| `/config [key=value ...]` | View or change `temperature`, `maxTokens`, `systemPrompt`, `verboseTools` |
| `/status` | Show the project, model, server, and approval mode |
| `/compact` | Summarize the conversation to free up context |
| `/export [file]` | Save the conversation transcript to a file |
| `/diff [path]` | Show `git diff` for the project (or a path within it) |
| `/doctor` | Run local health checks (Node, server, project, git) |
| `/usage` | Show an approximate context-size estimate |
| `/clear` (alias `/new`) | Wipe the screen (and scrollback) and start a fresh conversation |
| `/exit` (alias `/quit`) | Quit |

Press `Ctrl+C` while the model is responding to cancel the request. Press it at the input prompt to exit. Press `Ctrl+L` to redraw a clean screen without touching the conversation.

## One-shot tasks

Run one prompt and exit:

```bash
pnpm agent -- ./my-project --prompt "Add tests for the parser"
```

For scripts or other non-interactive use, `--yes` explicitly approves file changes and commands:

```bash
pnpm agent -- ./my-project --prompt "Fix the tests" --yes
```

Use `--yes` only in a project you trust.

## Options

```text
-p, --prompt <text>       Run one task, then exit
-m, --model <id>          Select an LM Studio model
-t, --temperature <0-1>  Set sampling temperature
    --max-tokens <number> Set maximum response tokens
    --url <url>           Set the LM Studio API base URL
-y, --yes                 Approve changes and commands for this session
    --verbose-tools       Print complete tool results
```

Run `pnpm agent -- --help` for the full built-in help.

## Configuration

The CLI uses `http://localhost:1234/v1` by default. Override it with `--url` or `LM_STUDIO_URL`:

```bash
LM_STUDIO_URL=http://localhost:1234/v1 pnpm agent -- ./my-project
```

You can place variables in `.env` at the coding-agent root. See [.env.example](.env.example).

## Tools and safety

The model receives six tools:

- `read_file`
- `list_files`
- `write_file`
- `append_file`
- `delete_file`
- `run_command`

All model-supplied paths are restricted to the active project. Existing paths and parent directories are resolved to prevent `..` traversal and symbolic-link escapes. Reads and writes are capped at 2 MB. Commands have a default 30-second timeout, capped output, a filtered environment, and guards against several destructive system commands.

Shell access is inherently powerful, which is why mutating tools require terminal approval by default.

## Test

```bash
pnpm test
```

The test suite covers argument validation, terminal approvals, repeated model tool calls, file operations, path and symlink boundaries, command safeguards, and project switching.
