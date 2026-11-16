# Working on AgentHouse

Notes for coding agents (and people) changing this repository. Keep it short and true: update it in the same commit as the change it describes.

## What runs where

AgentHouse is three programs plus a browser app. Know which one a file runs in before changing it.

| Process | Files | Restart |
|---|---|---|
| Browser | `apps/web/src` (React + MUI) | reload |
| Web server | everything else in `apps/server/src` (`main.ts`, `web/`, ...) | freely; `tsx watch` restarts it in dev |
| Session host | `apps/server/src/host/` and what it loads: `src/shared/`, `src/claude/status.ts`, `agents.ts` and `settings.ts`, `packages/protocol/src/` | ends every session: `pnpm dev:stop` (dev) or `pnpm stop` |
| Relay | `apps/server/src/relay/relay.cjs`, run by Claude Code for each hook and as its status line and sub-agent status line | per event |

- `src/claude/` is what AgentHouse knows about Claude Code (hook events, status line, settings files, sub-agents in `agents.ts`, the transcript format in `transcript.ts`); `src/shared/` is used by both servers.
- The conversation view is read in the web server (`web/conversations.ts`): only the transcripts the host reported (a sub-agent's next to its session's), only under Claude's projects folder, in small pieces so the event loop stays free. The flow view (`workspace/flow.ts`) asks for the turns only (`turns=only`).
- The session host owns the PTYs, so sessions survive web server restarts. The web server prepares launches, checks the environment, serves the UI and relays terminals to the host.
- Browser ↔ web server types: `packages/protocol`. Web server ↔ host messages: `apps/server/src/shared/host-protocol.ts`; bump `HOST_PROTOCOL` whenever they change, and keep the hello's proof and the `shutdown` request as they are, so `--stop` still reaches older hosts.
- Until the host restarts after its code changed, the environment check warns (`shared/build.ts` hashes the files listed above).
- Claude status comes from hooks (`claude/status.ts`: `STATUS_EVENTS` and its handler map are the single list the injected hooks are built from), the status line (model, effort, context, plan limits) and, when no hook can tell (Esc, a dialog answered in the terminal), the transcript and `claude agents --json`.
- Delegation (`web/delegations.ts`, web server): text sent to an idle delegated session through the composer path; done once that session is idle with no sub-agent running and idle again since the last one it started ended (that one's report is a turn of its own); its last answer after the send is read from its transcript and, when the user says so, composed into the parent (queued while the parent is busy or asking, never typed into a dialog).
- The page: the login (`LoginGate`), then the start screen (`StartupCheck`: a loading bar while `/api/env` answers; it stops on errors, and on warnings the user has not gone on past before; notes stay in the environment check), then the workspace. The start screen is for a tab's first load: a reload goes straight to the workspace.
- CLIs run as found on PATH (`web/cli/resolve.ts`, the first is the one the user's shell runs) unless the user chose a file (`PUT /api/cli/:vendor`, checked by its `--version`); a launch looks again when the file it would run is gone, and never falls back from a chosen file.
- An ended Claude session starts again where its conversation stopped (`SessionManager.resume` in `web/manager.ts`): `claude --resume <its id>` in its folder, with what it was launched with, under the AgentHouse id it had, so its row, links, delegations and panes stay. The host takes an id again once it has let go of it: one that saw the session end is asked to close it first. Nothing of the host changed for this.
- Sub-agents (`claude/agents.ts`) run in the background. Hooks name them (SubagentStart/Stop; the Agent tool's result names the agent it started; events a sub-agent causes carry its `agent_id`), and the sub-agent status line adds model and tokens. Their tool calls never change the session's status; a dialog they open does.
- What the page announces (a browser notification while its tab is hidden; the bell in the top bar, `components/Notifications.tsx`, counts and lists who waits): a session that asks and, once the user turned it on there, one whose work ended. The host sends one session list per burst of events (150 ms), so a state held for a moment may never arrive: an end is told from the list before (`workspace/notify.ts`: in a turn, then idle with no sub-agent at work), list by list as they arrive, not from what is drawn.

## State

- `~/.agenthouse/` (dev: `~/.agenthouse-dev/`; must be the user's alone, `web/state-dir.ts` checks it at start): `host-<protocol>.json` (host port and token, user-only), `web.json` (the web server serving this folder and the key local tools present to it, user-only: a second start asks it for a login address and opens that instead of running another, `--stop` ends it before the host; the dev runner keeps none), `logs/host.log` and `logs/web.log` (the web server: what it could not save, errors nothing caught), `run/<protocol>/` (per-session settings and relay config, removed when the session ends; a starting host clears leftovers).
- Written by the web server: `settings.json` (the executable the user chose per CLI in the environment check; the doctor reads it), `sessions.json` (session registry: what the host reported last, so ended sessions and their transcripts stay listed after a host restart), `usage/limits-YYYY-MM.jsonl` (plan usage, a line per change; the last one shows until a session reports again), `state.json` (which session the user placed under which, grouped or delegated; one level, links of removed sessions dropped), `delegations.json` (work handed to a delegated session: where its answer is in that session's transcript, never the answer itself).
- Browser localStorage: login token (`ah-token`, per port), layout (`ah-layout`), last folder (`ah-last-cwd`), theme (`mui-mode`), the start screen's warnings the user went on past (`ah-passed-issues`), finished work announced too (`ah-notify-done`). sessionStorage: this tab has been through the start screen (`ah-started`).
- Everything else lives in memory. There is no database: anything that must persist goes into local JSON/JSONL files under the state folder, one writer per file, written atomically (`writeJsonFile` in `shared/state.ts`).

## Commands

- `pnpm dev` / `pnpm dev:stop`: dev servers with their own state folder and port (7358); never touch the user's real sessions.
- `pnpm build`, `pnpm start` / `pnpm stop`, `pnpm run doctor [-- --json]` (the environment check in the terminal, starting nothing; exit 1 when AgentHouse cannot run; `web/doctor-command.ts`; `pnpm doctor` is pnpm's own command).
- `pnpm typecheck`, `pnpm test` (a fake agent stands in for the CLIs, no login; launched like Claude Code it sends hook events and, under a temporary `CLAUDE_CONFIG_DIR`, writes a transcript, which `--resume` goes on with; `agents` in a prompt runs background sub-agents, `approval` waits for an approval until a key is pressed), `pnpm licenses:check`.
- `pnpm canary:claude [-- --turn | --resume | --scenario]`: the built app against the installed Claude Code; no prompt unless `--turn` (one), `--resume` (one, then the session is ended and resumed and asked for what the first got; in the canary's folder) or `--scenario` (haiku, low effort: reply, approve, deny with Esc, interrupt, sub-agents (two parallel, one nested), `/clear`, work delegated to a second session and handed back, then delegated work that runs through a sub-agent, then the conversation views from the real transcripts; runs in `%TEMP%/agenthouse-canary-work` and tells Claude to trust it the first time).
- `pnpm ui:check [-- --out <folder>]`: the built app in the installed Chrome (playwright-core, nothing downloaded) with the fake agent (sub-agents included) and a made-up ended session (`scripts/ui-sample.mjs`); light and dark screenshots.
- Tests that need a host use a temporary state folder (`tempStateDir()`, or `AGENTHOUSE_HOME` for a spawned server); never the real `~/.agenthouse`.

## Rules

- Users keep their setup: never require reinstalling or upgrading Node (18+) or the CLIs, or changing PATH. Detect what is there, use the install the user's shell runs, and gate features by CLI version.
- Never read credential files (`~/.claude/.credentials.json`, `~/.codex/auth.json`); never proxy model traffic.
- Change a CLI's behaviour only per session (Claude: `--settings`); never edit the user's settings files.
- A Claude session's `--settings` deny its file tools the state folder (`stateFolderRules` in `web/cli/launch.ts`): the tokens there start programs and type into every session. They add to the user's permission rules.
- The relay prints nothing as a hook, always exits 0, stays fast and has no dependencies.
- Never type into a dialog: the host takes text only from a CLI that has started (Claude's folder trust question comes before any hook) and shows no dialog; dialogs are tracked apart from the status (`Dialogs` in `claude/status.ts`), and automatic sends (delegation) wait while someone types in that terminal, then ask `claude agents --json` first. Text is pasted without control characters, one at a time per session; a held-back Enter is sent again alone, never with the text.
- node-pty only on the host's main thread.
- Start programs by absolute path, or after a PATH search that skips empty and relative entries: Windows runs a same-named program from the current folder first.
- Security problems that plain CLI use also has are environment facts, not AgentHouse bugs; AgentHouse must just not make them worse.
- UI text lives in `apps/web/src/strings.ts`: short Korean labels, no explanatory or self-referential sentences. Show status, title and model by default; everything else behind the expand toggle.
- Looks come from `apps/web/src/theme/tokens.ts`. Height is a tone and a shadow: the page (`bg`; the bar and the tree lie on it), a card (`surface`, `shadow1`: a pane, the row of what a pane shows), a card in use (`shadow2`: the active pane, the open composer), what floats (`raised`, `shadow3`: menus, popovers, dialogs); what is set into a card (a terminal, a conversation) has an inset edge (`well`). Under the pointer: the `hover` veil on what has no fill, the stronger fill on a chip, a step up for a filled button. What is shown or chosen is told by its face and height, not by a tint: color is kept for status. Changes are timed by `motion`, which stands still when the system asks for less of it. Type is 12, 13, 14 or 18, in 400, 500 or 600.
- Light and dark differ only under `apps/web/src/theme/`: in the values `tokens.ts` builds (light shows a height as a shadow, dark as a lighter tone and an edge), in MUI's palette made of them and in the terminal's colors. No component has a style for one mode alone. It gives a height both its face and its shadow (`surface` with `shadow1`), so each mode shows it in its own way; to change how deep something looks in one mode, change the values.
- A change of looks never changes the size of a pane or its terminal, which would resize the PTY: height is a shadow, not a border. `pnpm ui:check` prints the pane's box and the terminal's size to compare.
- Dependencies must pass `pnpm licenses:check`; never copy code from AGPL projects.
- No real transcripts, company data or personal paths in the repository.
- Commits: one logical change each; no `Co-Authored-By` trailers.

## Local notes (not in the repository)

If `docs/` exists, read it first: `docs/plan.md` (plan; §0 is progress, scope and next steps), `docs/facts.md` (verified facts, the source of truth), `docs/review-*.md`. After changing anything in `docs/`, run `node docs-backup/snapshot.mjs "<one-line summary>"`; it keeps every version as a new file.
