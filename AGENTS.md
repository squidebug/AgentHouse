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
- The conversation view is read in the web server (`web/conversations.ts`): only the transcripts the host reported (a sub-agent's next to its session's), only under Claude's projects folder, in small pieces so the event loop stays free.
- The session host owns the PTYs, so sessions survive web server restarts. The web server prepares launches, checks the environment, serves the UI and relays terminals to the host.
- Browser ↔ web server types: `packages/protocol`. Web server ↔ host messages: `apps/server/src/shared/host-protocol.ts`; bump `HOST_PROTOCOL` whenever they change, and keep the hello's proof and the `shutdown` request as they are, so `--stop` still reaches older hosts.
- Until the host restarts after its code changed, the environment check warns (`shared/build.ts` hashes the files listed above).
- Claude status comes from hooks (`claude/status.ts`: `STATUS_EVENTS` and its handler map are the single list the injected hooks are built from), the status line (model, effort, context, plan limits) and, when no hook can tell (Esc, a dialog answered in the terminal), the transcript and `claude agents --json`.
- Sub-agents (`claude/agents.ts`) run in the background. Hooks name them (SubagentStart/Stop; the Agent tool's result names the agent it started; events a sub-agent causes carry its `agent_id`), and the sub-agent status line adds model and tokens. Their tool calls never change the session's status; a dialog they open does.

## State

- `~/.agenthouse/` (dev: `~/.agenthouse-dev/`): `host-<protocol>.json` (host port and token, user-only), `logs/host.log`, `run/<protocol>/` (per-session settings and relay config, removed when the session ends; a starting host clears leftovers).
- Written by the web server: `sessions.json` (session registry: what the host reported last, so ended sessions and their transcripts stay listed after a host restart), `usage/limits-YYYY-MM.jsonl` (plan usage, a line per change; the last one shows until a session reports again).
- Browser localStorage: layout (`ah-layout`), last folder (`ah-last-cwd`), theme (`mui-mode`).
- Everything else lives in memory. There is no database: anything that must persist goes into local JSON/JSONL files under the state folder, one writer per file, written atomically.

## Commands

- `pnpm dev` / `pnpm dev:stop`: dev servers with their own state folder and port (7358); never touch the user's real sessions.
- `pnpm build`, `pnpm start` / `pnpm stop`.
- `pnpm typecheck`, `pnpm test` (a fake agent stands in for the CLIs, no login; launched like Claude Code it sends hook events and, under a temporary `CLAUDE_CONFIG_DIR`, writes a transcript; `agents` in a prompt runs background sub-agents), `pnpm licenses:check`.
- `pnpm canary:claude [-- --turn | --scenario]`: the built app against the installed Claude Code; no prompt unless `--turn` (one) or `--scenario` (haiku, low effort: reply, approve, deny with Esc, interrupt, `/clear`, then the conversation view from the real transcript; runs in `%TEMP%/agenthouse-canary-work` and tells Claude to trust it the first time).
- `pnpm ui:check [-- --out <folder>]`: the built app in the installed Chrome (playwright-core, nothing downloaded) with the fake agent (sub-agents included) and a made-up ended session (`scripts/ui-sample.mjs`); light and dark screenshots.
- Tests that need a host use a temporary state folder (`tempStateDir()`, or `AGENTHOUSE_HOME` for a spawned server); never the real `~/.agenthouse`.

## Rules

- Users keep their setup: never require reinstalling or upgrading Node (18+) or the CLIs, or changing PATH. Detect what is there, use the install the user's shell runs, and gate features by CLI version.
- Never read credential files (`~/.claude/.credentials.json`, `~/.codex/auth.json`); never proxy model traffic.
- Change a CLI's behaviour only per session (Claude: `--settings`); never edit the user's settings files.
- The relay prints nothing as a hook, always exits 0, stays fast and has no dependencies.
- Never type into a dialog: the composer refuses sessions waiting for an approval or an answer.
- node-pty only on the host's main thread.
- Start programs by absolute path, or after a PATH search that skips empty and relative entries: Windows runs a same-named program from the current folder first.
- Security problems that plain CLI use also has are environment facts, not AgentHouse bugs; AgentHouse must just not make them worse.
- UI text lives in `apps/web/src/strings.ts`: short Korean labels, no explanatory or self-referential sentences. Show status, title and model by default; everything else behind the expand toggle.
- Dependencies must pass `pnpm licenses:check`; never copy code from AGPL projects.
- No real transcripts, company data or personal paths in the repository.
- Commits: one logical change each; no `Co-Authored-By` trailers.

## Local notes (not in the repository)

If `docs/` exists, read it first: `docs/plan.md` (plan; §0 is progress, scope and next steps), `docs/facts.md` (verified facts, the source of truth), `docs/review-*.md`. After changing anything in `docs/`, run `node docs-backup/snapshot.mjs "<one-line summary>"`; it keeps every version as a new file.
