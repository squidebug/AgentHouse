# AgentHouse

A local web console for running AI coding-agent CLIs — Claude Code and Codex — side by side in real browser terminals, and for seeing what each agent is doing.

> **Status: pre-alpha.** Working today: real CLI terminals in the browser, several sessions at once, drag-and-drop layout, a Korean-safe composer, light/dark themes and an environment check. Sessions keep running while the server restarts, and Claude Code sessions show live status (working, waiting for approval, idle) and plan usage. Next: a conversation view with token counts, sub-agent trees, grouping and delegation. Codex runs in the terminal; its status view comes later and has not been tried with a real Codex install yet. The UI is in Korean for now; English is planned.

- Runs only on your machine (`127.0.0.1`), behind a login token, a Host allowlist and an Origin check.
- Drives the CLIs exactly as installed, signed in with your own account. No reinstall, no PATH changes: Node 18 or newer and whatever Claude Code / Codex you already use.
- AgentHouse never reads credential files or proxies model traffic.
- Claude Code sessions are observed through hooks and a status line passed to that session with `--settings`. Your settings files are not changed, and your own status line keeps showing.
- Windows 11 first; macOS and Linux are kept working.

AgentHouse is an independent project. It is not affiliated with or endorsed by Anthropic or OpenAI. "Claude Code" and "Codex" are used only to describe compatibility.

## Run

```sh
pnpm install
pnpm build
pnpm start        # prints http://127.0.0.1:7357/auth?token=… and opens it
pnpm stop         # ends every session and the session host
```

Sessions run in a separate session host, so they keep running when the server stops or restarts, and an open page reconnects by itself. State lives in `~/.agenthouse`: the host's address, a log, per-session files, the session list and the last plan usage. Sessions from before a host restart (or a reboot) stay listed as ended until you remove them.

Development:

```sh
pnpm dev          # open the printed http://localhost:5173/auth?token=… address
pnpm dev:stop     # ends the dev sessions and the dev session host
```

`pnpm dev` has its own state folder (`~/.agenthouse-dev`) and port (7358), so it never touches sessions started with `pnpm start`. The server restarts on code changes, but code that runs in the session host (`apps/server/src/host` and what it loads: `src/shared`, `src/claude/status.ts` and `settings.ts`, `packages/protocol/src`) takes effect only after `pnpm dev:stop`, which ends the dev sessions.

## Use

- **New session**: the `+` next to "세션", or the empty area. Pick the CLI, folder, and optionally model, effort and permission mode; anything left as 기본값 keeps your CLI's own setting.
- **Open**: click a session in the tree, or drag it onto a pane. Drag it onto the `+` strip for a new pane (up to 4).
- **Rearrange**: drag a pane by its header onto another pane to swap them.
- **Send to several sessions**: drag sessions onto the message box, type, `Ctrl+Enter`. With none added, the message goes to the focused pane. Sessions waiting for an approval or an answer are skipped, so a message never answers a dialog.
- **Status**: working, waiting for approval (amber) and idle show on each session. The tab title counts sessions waiting for you, and a browser notification appears while the tab is in the background. The chip at the top shows Claude plan usage; open it for the 5-hour and weekly windows and their reset times.
- **Details**: the chevron on a row or pane shows CLI version, model, effort, context use, folder and PID.

## Checks

```sh
pnpm typecheck
pnpm test             # protocol, web, server (a fake agent stands in for the CLIs; no login needed)
pnpm licenses:check   # dependency license allowlist
pnpm canary:claude    # the built app against your installed Claude Code; sends no prompt (add -- --turn for one short haiku prompt)
```

Working on the code with an AI agent: see [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE).

한국어 안내: [README.ko.md](README.ko.md)
