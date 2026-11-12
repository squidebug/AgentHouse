import path from 'node:path';
import type { AgentInfo } from '@agenthouse/protocol';
import { askingTool, isClaudeTranscript, type HookEvent } from './status';

// Claude Code's sub-agents as its hooks and sub-agent status line report them
// (2.1.322). The Agent tool starts one in the background: PreToolUse(Agent),
// then SubagentStart { agent_id, agent_type } and, at once, PostToolUse(Agent)
// whose tool_response.agentId names it. Events a sub-agent causes carry its
// agent_id, so a nested Agent call names its parent. SubagentStop ends its turn;
// a SubagentStart with the same id resumes it. Hooks run async, so these can
// arrive in any order. Helpers Claude starts on its own (prompt suggestions,
// /btw) have an empty agent_type and are left out.

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const RESUMES = new Set(['PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'ElicitationResult']);
// Claude's agent ids are short hex strings; a path is built from them, so nothing else is taken.
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_AGENTS = 500;
const TEXT_CHARS = 200;
// An Agent call that never started an agent (refused, failed) is forgotten after this.
const LAUNCH_TTL_MS = 120_000;

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null);
const text = (value: unknown): string | null => (typeof value === 'string' && value ? value.slice(0, TEXT_CHARS) : null);
const agentId = (value: unknown): string | null => (typeof value === 'string' && AGENT_ID.test(value) ? value : null);

/** One of the sub-agents' tools waits for the user. */
export interface AgentAsk {
  agentId: string;
  kind: 'permission' | 'input';
  tool: string | null;
  at: number;
}

interface Launch {
  toolUseId: string | null;
  parentId: string | null;
  agentType: string | null;
  description: string | null;
  at: number;
}

/** What an Agent call's result says about the agent it started, kept until that agent's SubagentStart. */
type Early = Pick<AgentInfo, 'parentId' | 'description' | 'model'>;

/**
 * Where Claude keeps a sub-agent's transcript: next to the session's, in
 * `<session>/subagents/agent-<id>.jsonl`, nested ones included. Null unless it
 * is under Claude's projects folder.
 */
export function agentTranscript(sessionTranscript: string | undefined, id: string, configDir: string): string | null {
  if (!sessionTranscript || !AGENT_ID.test(id)) return null;
  const dir = path.join(path.dirname(sessionTranscript), path.basename(sessionTranscript, '.jsonl'), 'subagents');
  const file = path.join(dir, `agent-${id}.jsonl`);
  return isClaudeTranscript(file, configDir) ? file : null;
}

/** A session's sub-agents, built from its hook events and sub-agent status line. */
export class AgentTracker {
  private readonly agents = new Map<string, AgentInfo>();
  private launches: Launch[] = [];
  private readonly early = new Map<string, Early>();
  private readonly asks = new Map<string, AgentAsk>();
  /** Ids of Claude's own helpers, whose events are ignored. */
  private readonly internal = new Set<string>();

  constructor(
    /** Where the agent's transcript is, from the session's transcript at the time it starts. */
    private readonly transcriptOf: (id: string) => string | null,
    /** Accepts a transcript path from a hook payload (Claude's projects folder only). */
    private readonly isTranscript: (file: string) => boolean,
  ) {}

  list(): AgentInfo[] {
    return [...this.agents.values()];
  }

  /** The longest-waiting question or approval of a sub-agent, the same object until it changes. */
  asking(): AgentAsk | null {
    let first: AgentAsk | null = null;
    for (const ask of this.asks.values()) if (!first || ask.at < first.at) first = ask;
    return first;
  }

  /** One hook event; true when the tree changed. */
  onHook(event: HookEvent, at = Date.now()): boolean {
    const name = event.hook_event_name;
    const caller = agentId(event.agent_id);
    const tool = text(event.tool_name);
    let changed = false;

    if (name === 'SubagentStart') return this.started(caller, event.agent_type, at);
    if (name === 'SubagentStop') return this.stopped(caller, event, at);
    if (name === 'Stop') return this.fromBackgroundTasks(event.background_tasks, at);

    if (tool && AGENT_TOOLS.has(tool)) changed = this.agentCall(name, caller, event, at) || changed;
    if (!caller || this.internal.has(caller)) return changed;

    // Something a sub-agent did: its tool, and whether it waits for the user.
    const agent = this.agents.get(caller);
    const ask = (kind: AgentAsk['kind'], what: string | null) => {
      this.asks.set(caller, { agentId: caller, kind, tool: what, at });
      return this.update(caller, { tool: what, asking: true, state: 'running' }) || true;
    };
    if (name === 'PermissionRequest') return ask('permission', tool) || changed;
    if (name === 'Elicitation') return ask('input', 'elicitation') || changed;
    if (name === 'Notification' && event.notification_type === 'permission_prompt' && !this.asks.has(caller)) return ask('permission', agent?.tool ?? null) || changed;
    if (name === 'PreToolUse') {
      if (askingTool(tool)) return ask('input', tool) || changed;
      return this.update(caller, { tool, state: 'running' }) || changed;
    }
    if (typeof name === 'string' && RESUMES.has(name)) {
      const asked = this.asks.delete(caller);
      return this.update(caller, { tool: null, asking: false }) || asked || changed;
    }
    return changed;
  }

  /**
   * The sub-agent status line's `tasks`: model and tokens as Claude counts them.
   * It runs late and is skipped while a dialog is open, so it never changes
   * whether an agent runs; it only adds agents the hooks missed.
   */
  onStatusLine(tasks: unknown, at = Date.now()): boolean {
    if (!Array.isArray(tasks)) return false;
    let changed = false;
    for (const item of tasks) {
      const task = obj(item);
      const id = agentId(task?.id);
      if (!task || !id || (task.type !== undefined && task.type !== 'local_agent')) continue;
      const agentType = text(task.agentType);
      if (!agentType || this.internal.has(id)) continue;
      const tokens = typeof task.tokenCount === 'number' && Number.isFinite(task.tokenCount) ? task.tokenCount : null;
      const model = text(task.model);
      const description = text(task.description) ?? text(task.label);
      if (!this.agents.has(id)) {
        const startedAt = typeof task.startTime === 'number' && Number.isFinite(task.startTime) ? task.startTime : at;
        changed = this.add(id, agentType, startedAt, { state: task.status === 'running' ? 'running' : 'stopped', endedAt: task.status === 'running' ? null : at }) || changed;
      }
      const agent = this.agents.get(id);
      if (!agent) continue;
      changed =
        this.update(id, {
          ...(tokens !== null ? { tokens } : {}),
          ...(model ? { model } : {}),
          ...(description && !agent.description ? { description } : {}),
        }) || changed;
    }
    return changed;
  }

  /** No dialog is open any more (the session was found idle or busy). */
  clearAsks(): boolean {
    if (!this.asks.size) return false;
    for (const id of this.asks.keys()) this.update(id, { asking: false });
    this.asks.clear();
    return true;
  }

  /** The session ended: whatever ran has stopped. */
  stopAll(at = Date.now()): boolean {
    let changed = this.clearAsks();
    for (const agent of this.agents.values()) {
      if (agent.state === 'running') changed = this.update(agent.id, { state: 'stopped', endedAt: at, tool: null }) || changed;
    }
    return changed;
  }

  private update(id: string, fields: Partial<AgentInfo>): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    const next = { ...agent, ...fields };
    if ((Object.keys(fields) as Array<keyof AgentInfo>).every((key) => agent[key] === next[key])) return false;
    this.agents.set(id, next);
    return true;
  }

  private add(id: string, agentType: string, at: number, fields: Partial<AgentInfo> = {}): boolean {
    if (this.agents.size >= MAX_AGENTS) return false;
    const early = this.early.get(id);
    this.early.delete(id);
    const launch = early ? null : this.takeLaunch(agentType);
    this.agents.set(id, {
      id,
      parentId: early?.parentId ?? launch?.parentId ?? null,
      agentType,
      description: early?.description ?? launch?.description ?? null,
      state: 'running',
      tool: null,
      asking: false,
      model: early?.model ?? null,
      tokens: null,
      startedAt: at,
      endedAt: null,
      transcriptPath: this.transcriptOf(id),
      ...fields,
    });
    return true;
  }

  /** The oldest Agent call of this kind that no agent has claimed yet. */
  private takeLaunch(agentType: string): Launch | null {
    const now = Date.now();
    this.launches = this.launches.filter((l) => now - l.at < LAUNCH_TTL_MS);
    const index = this.launches.findIndex((l) => l.agentType === agentType || l.agentType === null);
    return index === -1 ? null : (this.launches.splice(index, 1)[0] ?? null);
  }

  private started(id: string | null, type: unknown, at: number): boolean {
    if (!id) return false;
    const agentType = typeof type === 'string' ? type.slice(0, TEXT_CHARS) : '';
    if (!agentType) {
      this.internal.add(id);
      return false;
    }
    if (this.agents.has(id)) return this.update(id, { state: 'running', endedAt: null });
    return this.add(id, agentType, at);
  }

  private stopped(id: string | null, event: HookEvent, at: number): boolean {
    if (!id || this.internal.has(id)) return false;
    const type = text(event.agent_type);
    if (!type) {
      this.internal.add(id);
      return false;
    }
    const reported = typeof event.agent_transcript_path === 'string' && this.isTranscript(event.agent_transcript_path) ? event.agent_transcript_path : null;
    if (!this.agents.has(id)) this.add(id, type, at);
    const asked = this.asks.delete(id);
    return this.update(id, { state: 'stopped', endedAt: at, tool: null, asking: false, ...(reported ? { transcriptPath: reported } : {}) }) || asked;
  }

  /** The main conversation's Agent calls (or a sub-agent's, for nested agents). */
  private agentCall(name: unknown, caller: string | null, event: HookEvent, at: number): boolean {
    const input = obj(event.tool_input);
    const toolUseId = text(event.tool_use_id);
    if (name === 'PreToolUse') {
      this.launches.push({ toolUseId, parentId: caller, agentType: text(input?.subagent_type), description: text(input?.description), at });
      return false;
    }
    if (name !== 'PostToolUse' && name !== 'PostToolUseFailure' && name !== 'PermissionDenied') return false;
    // This call is settled: it either named its agent or started none.
    this.launches = this.launches.filter((l) => !toolUseId || l.toolUseId !== toolUseId);
    const response = obj(event.tool_response);
    const child = agentId(response?.agentId);
    if (name !== 'PostToolUse' || !child || this.internal.has(child)) return false;
    const known: Early = {
      parentId: caller,
      description: text(input?.description) ?? text(response?.description),
      model: text(response?.resolvedModel),
    };
    if (!this.agents.has(child)) {
      this.early.set(child, known);
      return false;
    }
    const agent = this.agents.get(child)!;
    return this.update(child, { parentId: caller, ...(known.description ? { description: known.description } : {}), ...(known.model && !agent.model ? { model: known.model } : {}) });
  }

  /** Stop lists the sub-agents still running: it fills in what the other hooks missed. */
  private fromBackgroundTasks(tasks: unknown, at: number): boolean {
    if (!Array.isArray(tasks)) return false;
    let changed = false;
    for (const item of tasks) {
      const task = obj(item);
      const id = agentId(task?.id);
      const type = text(task?.agent_type);
      if (!task || !id || task.type !== 'subagent' || !type || this.internal.has(id)) continue;
      if (!this.agents.has(id) && task.status === 'running') changed = this.add(id, type, at) || changed;
      const description = text(task.description);
      if (description && !this.agents.get(id)?.description) changed = this.update(id, { description }) || changed;
    }
    return changed;
  }
}
