# Working on AgentHouse

Notes for coding agents (and people) changing this repository. Keep it short and true: update it in the same commit as the change it describes.

## What runs where

AgentHouse is three programs plus a browser app. Know which one a file runs in before changing it.

| Process | Files | Restart |
|---|---|---|
| Browser | `apps/web/src` (React + MUI) | reload |
| Web server | `apps/server/src/main.ts`, `http/`, `cli/`, `env/`, `sessions/manager.ts`, `sessions/env.ts`, `host/client.ts` | freely; `tsx watch` restarts it in dev |
| Session host | `apps/server/src/host/main.ts`, `host/server.ts`, `host/state.ts`, `sessions/session.ts`, `sessions/status.ts`, `sessions/colors.ts`, `util/`, `packages/protocol/src/terminal.ts` | ends every session: `pnpm dev:stop` (dev) or `pnpm stop` |
| Relay | `apps/server/src/relay/relay.cjs`, run by Claude Code for each hook and as its status line | per event |

- The session host owns the PTYs, so sessions survive web server restarts. The web server prepares launches, checks the environment, serves the UI and relays terminals to the host.
- Browser ↔ web server types: `packages/protocol`. Web server ↔ host messages: `apps/server/src/host/protocol.ts`; bump `HOST_PROTOCOL` whenever they change.
- Claude status comes from hooks (`sessions/status.ts`: `STATUS_EVENTS` and its handler map are the single list the injected hooks are built from), the status line (model, effort, context, plan limits) and, when no hook can tell (Esc, a dialog answered in the terminal), the transcript and `claude agents --json`.

## State

- `~/.agenthouse/` (dev: `~/.agenthouse-dev/`): `host-<protocol>.json` (host port and token, user-only), `logs/host.log`, `run/<protocol>/` (per-session settings and relay config, removed when the session ends; a starting host clears leftovers).
- Browser localStorage: layout (`ah-layout`), last folder (`ah-last-cwd`), theme (`mui-mode`).
- Everything else lives in memory. There is no database: anything that must persist goes into local JSON/JSONL files under the state folder, one writer per file, written atomically.

## Commands

- `pnpm dev` / `pnpm dev:stop`: dev servers with their own state folder and port (7358); never touch the user's real sessions.
- `pnpm build`, `pnpm start` / `pnpm stop`.
- `pnpm typecheck`, `pnpm test` (a fake agent stands in for the CLIs, no login), `pnpm licenses:check`.
- `pnpm canary:claude [-- --turn]`: the built app against the installed Claude Code; no prompt unless `--turn`.
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
