import { isAgentBusy, isAsking, type AgentInfo, type BackgroundTask, type SessionStatus } from '@agenthouse/protocol';
import { v } from '../theme/tokens';
import { taskStatusText } from '../workspace/background';
import { agentStatusText, statusText } from './Details';

/**
 * Color is kept for what needs attention: working is primary (pulsing),
 * waiting for approval or input is amber with a halo, an error is red; idle is
 * a quiet dot and an ended session a ring. A session nothing reports about
 * (no hooks) is a dashed ring: it may be working, and must not read as idle.
 * The label carries the same meaning.
 */
export function StatusIcon({ status, size = 14 }: { status: SessionStatus; size?: number }) {
  const value = status.value;
  const asking = isAsking(value);
  const color = status.error ? v.error : asking ? v.warn : value === 'working' ? v.primary : v.on2;
  return (
    <svg role="img" aria-label={statusText(status)} width={size} height={size} viewBox="0 0 16 16" style={{ flex: 'none' }}>
      {asking && <circle cx="8" cy="8" r="7" style={{ fill: v.warnContainer }} />}
      {value === 'exited' || value === 'starting' || value === 'unobserved' ? (
        <circle
          cx="8"
          cy="8"
          r="4.5"
          style={{ fill: 'none', stroke: color, strokeWidth: 1.8, opacity: value === 'starting' ? 0.6 : 1, ...(value === 'unobserved' ? { strokeDasharray: '2.4 2.3' } : {}) }}
        />
      ) : (
        <circle className={value === 'working' ? 'ah-working' : undefined} cx="8" cy="8" r="4.5" style={{ fill: color }} />
      )}
    </svg>
  );
}

/** A background task: running (pulsing), done (a check), failed (a red cross) or stopped (a ring). */
export function TaskStatusIcon({ task, size = 14 }: { task: Pick<BackgroundTask, 'state' | 'exitCode'>; size?: number }) {
  const line = { fill: 'none', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  return (
    <svg role="img" aria-label={taskStatusText(task)} width={size} height={size} viewBox="0 0 16 16" style={{ flex: 'none' }}>
      {task.state === 'running' && <circle className="ah-working" cx="8" cy="8" r="4.5" style={{ fill: v.primary }} />}
      {task.state === 'done' && <path d="M3.6 8.4 L6.6 11.2 L12.4 4.8" style={{ ...line, stroke: v.done }} />}
      {task.state === 'failed' && <path d="M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5" style={{ ...line, stroke: v.error }} />}
      {task.state === 'stopped' && <circle cx="8" cy="8" r="4.5" style={{ fill: 'none', stroke: v.on2, strokeWidth: 1.8 }} />}
    </svg>
  );
}

/** A sub-agent: working (pulsing), waiting for the user (amber with a halo), or done (a check). */
export function AgentStatusIcon({ agent, size = 14 }: { agent: AgentInfo; size?: number }) {
  const label = agentStatusText(agent);
  if (!isAgentBusy(agent)) {
    return (
      <svg role="img" aria-label={label} width={size} height={size} viewBox="0 0 16 16" style={{ flex: 'none' }}>
        <path d="M3.6 8.4 L6.6 11.2 L12.4 4.8" style={{ fill: 'none', stroke: v.done, strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' }} />
      </svg>
    );
  }
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox="0 0 16 16" style={{ flex: 'none' }}>
      {agent.asking && <circle cx="8" cy="8" r="7" style={{ fill: v.warnContainer }} />}
      <circle className={agent.asking ? undefined : 'ah-working'} cx="8" cy="8" r="4.5" style={{ fill: agent.asking ? v.warn : v.primary }} />
    </svg>
  );
}
