// How a session's sub-agents show in the tree and the pane header, kept free
// of React so it can be tested directly.
import { isAgentBusy as busy, type AgentInfo } from '@agenthouse/protocol';

/** Finished agents beyond this many are folded until the user opens them. */
export const SHOWN_FINISHED = 3;

export interface AgentRow {
  agent: AgentInfo;
  /** 1 for an agent the main conversation started, one more per level of nesting. */
  depth: number;
}

/** The agents by the one that started them (null: the main conversation), each list oldest first. */
function byParent(agents: AgentInfo[]): Map<string | null, AgentInfo[]> {
  const ids = new Set(agents.map((a) => a.id));
  const children = new Map<string | null, AgentInfo[]>();
  for (const agent of agents) {
    // An agent whose parent is not listed (a missed start) shows at the top level.
    const parentId = agent.parentId !== null && ids.has(agent.parentId) ? agent.parentId : null;
    const siblings = children.get(parentId);
    if (siblings) siblings.push(agent);
    else children.set(parentId, [agent]);
  }
  return children;
}

/** The agents an agent (or, for null, the main conversation) started, oldest first. */
export function childAgents(agents: AgentInfo[], parentId: string | null): AgentInfo[] {
  return byParent(agents).get(parentId) ?? [];
}

/**
 * The tree rows under a session: each agent below the one that started it, in
 * the order they started. With more than SHOWN_FINISHED finished agents and
 * `all` off, only the busy ones and the agents above them are listed.
 */
export function agentRows(agents: AgentInfo[], all: boolean): { rows: AgentRow[]; folded: number } {
  const finished = agents.filter((a) => !busy(a)).length;
  const fold = !all && finished > SHOWN_FINISHED;
  const shown = new Set<string>();
  if (fold) {
    const byId = new Map(agents.map((a) => [a.id, a]));
    for (const agent of agents) {
      if (!busy(agent)) continue;
      // An agent and everything above it, so it shows where it belongs.
      for (let at: AgentInfo | undefined = agent; at && !shown.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) shown.add(at.id);
    }
  }
  const rows: AgentRow[] = [];
  const seen = new Set<string>();
  // Sorted out once: asked of the whole list at every agent, a long list took its length squared.
  const children = byParent(agents);
  const walk = (parentId: string | null, depth: number) => {
    for (const agent of children.get(parentId) ?? []) {
      if (seen.has(agent.id)) continue; // a parent loop in bad data
      seen.add(agent.id);
      if (!fold || shown.has(agent.id)) rows.push({ agent, depth });
      walk(agent.id, depth + 1);
    }
  };
  walk(null, 1);
  return { rows, folded: fold ? agents.length - rows.length : 0 };
}

/** How long it has run, or ran. */
export function elapsedMs(agent: AgentInfo, now: number): number {
  return Math.max(0, (agent.endedAt ?? now) - agent.startedAt);
}
