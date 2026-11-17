# AgentHouse

A local web console for running AI coding-agent CLIs — Claude Code and Codex — side by side in real browser terminals, and for seeing what each agent is doing.

> **Status: pre-alpha.** Working today: real CLI terminals in the browser, several sessions at once, drag-and-drop layout, a Korean-safe composer, light/dark themes and an environment check. Sessions keep running while the server restarts, and Claude Code sessions show live status (working, waiting for approval, idle), plan usage, their sub-agents as they work, a flow view of who worked when, and a read-only conversation view with tokens per turn. Sessions can be grouped under one another in the tree, or delegated to: one session hands work to another and gets the answer back. A dashboard shows every session at once, by what it is doing. Next: Codex status, then the first public release. Codex runs in the terminal; its status view comes later and has not been tried with a real Codex install yet. The UI is in Korean for now; English is planned.

- Runs only on your machine (`127.0.0.1`), behind a login, a Host allowlist and an Origin check. The address it opens carries a one-time code; the page trades it for a token of its own, which no other port of `127.0.0.1` can read.
- Drives the CLIs exactly as installed, signed in with your own account. No reinstall, no PATH changes: Node 18 or newer and whatever Claude Code / Codex you already use.
- AgentHouse never reads credential files or proxies model traffic.
- Claude Code sessions are observed through hooks and a status line passed to that session with `--settings`. Your settings files are not changed, and your own status line keeps showing. The same `--settings` keep that session's file tools out of AgentHouse's state folder, next to your own permission rules.
- Windows 11 first; macOS and Linux are kept working.

AgentHouse is an independent project. It is not affiliated with or endorsed by Anthropic or OpenAI. "Claude Code" and "Codex" are used only to describe compatibility.

## Run

```sh
pnpm install
pnpm build
pnpm start        # prints a login address (http://127.0.0.1:7357/?code=…, good once, for 5 minutes) and opens it; if it already runs, opens a new one for that
pnpm stop         # ends the server, every session and the session host
pnpm run doctor   # checks Node, node-pty, the CLIs it would run and their login, hooks, the state folder and the port, without starting anything (`pnpm doctor` is pnpm's own)
```

Sessions run in a separate session host, so they keep running when the server stops or restarts, and an open page reconnects by itself. State lives in `~/.agenthouse`: the host's address, a log, per-session files, the session list and the last plan usage. Sessions from before a host restart (or a reboot), and sessions you end, stay listed as ended with their conversation until you remove them (the 50 newest ended ones are kept).

Development:

```sh
pnpm dev          # open the printed http://localhost:5173/?code=… address
pnpm dev:stop     # ends the dev sessions and the dev session host
```

`pnpm dev` has its own state folder (`~/.agenthouse-dev`) and port (7358), so it never touches sessions started with `pnpm start`. The server restarts on code changes, but code that runs in the session host (`apps/server/src/host` and what it loads: `src/shared`, `src/claude/status.ts`, `agents.ts`, `background.ts` and `settings.ts`, `packages/protocol/src`) takes effect only after `pnpm dev:stop`, which ends the dev sessions.

## Use

- **Start**: the page opens on a loading bar while it checks the environment, then shows the workspace. When something is wrong (no CLI, a CLI not logged in, hooks blocked) it stays and says what, with the fix. A warning you went on past with 계속 does not stop it again, and a reload in the same tab goes straight to the workspace; the pulse icon at the top still marks what is wrong.
- **Which CLI runs**: the environment check (the pulse icon at the top) shows the Claude Code and Codex it runs: by default the first on your PATH, the one your shell runs. 변경 picks another install or a file of your own (an alias, a folder not on PATH); AgentHouse runs it once to check it is that CLI, and uses it for new sessions.
- **New session**: the `+` next to "세션", or the empty area. Pick the CLI, folder, and optionally model, effort and permission mode; anything left as 기본값 keeps your CLI's own setting.
- **Open**: click a session in the tree, or drag it onto a pane. Drag it onto the `+` strip for a new pane (up to 4).
- **Rearrange**: drag a pane by its header onto another pane to swap them.
- **Group**: drag a session onto another one at the top of the tree and choose 묶기: it shows under that session from then on, in every browser and after restarts. Drag it onto 최상위로 below the tree, or use 최상위로 in its details, to bring it back; 아래로 넣기 in the details does it without dragging: pick the session to go under, then 묶기 or 위임. One level: a session with sessions under it stays at the top.
- **Delegate**: choose 위임 instead of 묶기, and the session works for the one above it, which shows it as a chip in its pane header. A reply in the upper session's conversation shows a 위임 button when you point at it: drag the button onto that chip or the delegate's pane, or click it and pick the delegate. The reply's text goes to the delegate, and a card follows the work. When the delegate is done, the card shows the first line of its answer; 전달 hands the answer to the upper session as a message, right away or, if that session is busy or waiting for you, as soon as it is idle. To hand over your own words, make the delegate a recipient of the message box (drag it there, or select its pane): a 위임 button appears next to send, and it or `Ctrl+Shift+Enter` sends the text as work from the upper session, with the same card and 전달. A delegate in the middle of a turn, or waiting for you, is not sent the work; the text stays in the box.
- **Send to several sessions**: drag sessions onto the message box, type, `Ctrl+Enter`. With none added, the message goes to the focused pane. Sessions waiting for an approval or an answer, or still starting (Claude may be asking whether to trust the folder), are skipped, so a message never answers a dialog. While the active pane shows a terminal, where you type directly, the message box folds to one line; it opens for the conversation and the flow, for sessions dragged onto it, and when you click it. The panes above it never move or resize.
- **Status**: working, waiting for approval (amber) and idle show on each session. A session nothing reports about (Codex for now, or Claude Code with its hooks blocked) shows a dashed ring and 관측 없음: it may well be working. The tab title and the bell at the top count sessions waiting for you, and a browser notification appears while the tab is in the background. The bell opens the list of them; click one to show it. Its 완료 알림 switch also announces a session whose work has ended (working, then idle) while the tab is in the background; a session whose sub-agents still work is not done yet. The chip at the top shows Claude plan usage; open it for the 5-hour and weekly windows and their reset times.
- **Dashboard**: the switch next to the name (워크스페이스 | 대시보드) shows every session at once instead of the workspace, a card each, by what it is doing: waiting for you first, then working, then those with a scheduled prompt (a loop keeps its place there instead of going back and forth at every run), then idle, with the ended ones folded away. A card says how long the session has been so, what it was last asked and, once the turn is over, how its answer starts, and its folder, model, effort and context. What runs in a session shows in an area of its own in its card: scheduled prompts, sub-agents that work or wait for you with the tool they use, background commands. Click a card to show that session in the workspace, which stays as it was underneath.
- **Conversation**: the switch in a pane header shows a Claude Code session's conversation instead of its terminal: prompts, replies, tool calls folded into one row (open one for its input and output), sub-agents, and model, effort and tokens per turn. Read-only. Going to the terminal and back keeps what you had opened and where you were reading. A session from before a host restart has only this left. ``Ctrl+` `` switches the active pane between its terminal and its conversation from anywhere on the page, the terminal included (the CLI never gets the key).
- **Flow**: the last view in the switch shows when everything under a session worked, as a graph: a lane for the session, each of its sub-agents and the sessions grouped or delegated under it, in the tree's order, its name on its bars (filled: working, striped: waiting for you, outlined: done), up to an hour back. Who is under whom stays in the tree. 실행 중 keeps only what runs now and the lanes above it. Click a lane to open it in the same pane, a sub-agent's conversation or a session's terminal; ← in the pane header goes back, with the lane you came from marked.
- **Sub-agents**: the agents a Claude Code session starts show under it in the tree, each under the agent that started it, with its kind and model; open one for its tokens and run time. Click one for its session's flow, with that agent marked; an agent in a conversation opens in the same pane, a chip in the pane header in a pane beside it; or drag it to a pane or the `+` strip. Many finished ones fold behind "완료 N". Claude runs them in the background, so a session can be idle while its agents work.
- **Background work and schedules**: the shell commands and Monitors a Claude Code session runs in the background, and the prompts it has scheduled (`/loop`, CronCreate, a wakeup), show under it in the tree. A task shows running, done or failed (with its exit code) and the latest line a Monitor read; a schedule shows in words ("1분마다") with how often it has run; open a row for the command, the prompt and the next run. Many ended tasks fold behind "완료 N". A scheduled prompt that runs is marked 예약 실행 in the conversation.
- **Skills and memory**: they are yours and a folder's, shared by every session and sub-agent there, so they have two buttons of their own at the foot of the session tree, 스킬 and 메모리, each opening a window. It shows the folder of the session you are at, with a switch when sessions run in several folders. 스킬 lists the skills by where they come from (project, user, plugin, built in), with the ones the folder's sessions ran marked (a plugin's and the built-in ones show once a conversation has started there); a skill of the project or of your own opens its file (SKILL.md) to edit. 메모리 lists what Claude reads into a session by itself: instructions (your CLAUDE.md and the project's, what they import with `@`, rules, CLAUDE.local.md) and the notes of the project's auto memory. Each opens as the text it is, to edit and save (`Ctrl+S`); a file that changed on disk since it was opened is not overwritten, and is offered to load again.
- **Terminal keys**: as in Windows Terminal, `Ctrl+C` copies a selection (without one it interrupts, as always) and `Ctrl+V` pastes; `Ctrl+Shift+C`/`V` too.
- **Details**: the chevron on a row or pane shows CLI version, model, effort, context use, folder and PID.
- **Ending**: 세션 종료 in a session's details ends its CLI; the session stays listed, ended, with its conversation, like one that quit by itself. Ended sessions fold into one row at the end of the tree ("종료 N"; one shown in a pane or with sessions under it stays where it is). Open the row to see them, 목록에서 제거 in a session's details takes it off the list, and 모두 제거 takes all the folded ones off at once.
- **Resuming**: 이어서 열기 in an ended Claude Code session's details starts it again in its folder, where the conversation stopped (`claude --resume`). It comes back as the same session: its place in the tree, its links and the panes showing it stay. Sessions that ended with the session host (a reboot, `pnpm stop`) are resumed the same way. A session whose conversation was never saved, or whose folder is gone, cannot be resumed.

## Checks

```sh
pnpm typecheck
pnpm test             # protocol, web, server (a fake agent stands in for the CLIs; no login needed)
pnpm licenses:check   # dependency license allowlist
pnpm canary:claude    # the built app against your installed Claude Code; sends no prompt (-- --turn: one short haiku prompt; -- --resume: one, then the session is ended, resumed and asked one more; -- --scenario: approve, deny, interrupt, sub-agents, /clear; -- --background: a background command, a /loop schedule, skills)
pnpm ui:check         # the built app in your installed Chrome with the fake agent (headless; -- --out <folder> keeps screenshots and one page of them, index.html; --before <folder> puts an earlier run's next to them)
```

Working on the code with an AI agent: see [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE).

한국어 안내: [README.ko.md](README.ko.md)
