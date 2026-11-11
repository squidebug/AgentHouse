# AgentHouse

A local web console for running and observing AI coding-agent CLIs — Claude Code and Codex — side by side in real browser terminals, with live status, token usage, effort level and sub-agent trees.

> **Status: pre-alpha (M3).** Real CLI terminals in the browser, several sessions at once, drag-and-drop layout, a Korean-safe composer, light/dark themes and an environment check work today, and sessions keep running while the server restarts. Status, usage, sub-agents, the conversation view, grouping and delegation are next. The UI is in Korean for now; English is planned.

- Runs only on your machine (`127.0.0.1`), with a per-launch token, a Host allowlist and an Origin check.
- Drives the CLIs exactly as installed, signed in with your own account. No reinstall, no PATH changes: Node 18 or newer and whatever Claude Code / Codex you already use.
- AgentHouse never reads credential files or proxies model traffic.
- Windows 11 first; macOS and Linux are kept working.

AgentHouse is an independent project. It is not affiliated with or endorsed by Anthropic or OpenAI. "Claude Code" and "Codex" are used only to describe compatibility.

## Run

```sh
pnpm install
pnpm build
pnpm start        # prints http://127.0.0.1:7357/auth?token=… and opens it
```

Development (server with reload on 7357, Vite on 5173):

```sh
pnpm dev          # open the printed http://localhost:5173/auth?token=… address
```

Sessions run in a separate session host, so they keep running when the server stops or restarts, and an open page reconnects by itself. `pnpm stop` ends every session and the host. The host keeps its address and a log in `~/.agenthouse`. After changing the host's code (`apps/server/src/host`, `apps/server/src/sessions/session.ts`), run `pnpm stop` so the next start uses it.

## Use

- **New session**: the `+` next to "세션", or the empty area. Pick the CLI, folder, and optionally model, effort and permission mode; anything left as 기본값 keeps your CLI's own setting.
- **Open**: click a session in the tree, or drag it onto a pane. Drag it onto the `+` strip for a new pane (up to 4).
- **Rearrange**: drag a pane by its header onto another pane to swap them.
- **Send to several sessions**: drag sessions onto the message box, type, `Ctrl+Enter`. With none added, the message goes to the focused pane.
- **Details**: the chevron on a row or pane shows CLI version, model, effort, folder and PID.

## Checks

```sh
pnpm typecheck
pnpm test             # protocol, web reducer, server (uses a fake agent, no login needed)
pnpm licenses:check   # dependency license allowlist
```

## License

[MIT](LICENSE).

한국어 안내: [README.ko.md](README.ko.md)
