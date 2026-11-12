import { isAsking, type AgentInfo, type SessionStatus } from '@agenthouse/protocol';
import { v } from '../theme/tokens';
import { agentStatusText, statusText } from './Details';

/**
 * Color is kept for what needs attention: working is primary (pulsing),
 * waiting for approval or input is amber with a halo, an error is red; idle is
 * a quiet dot and an ended session a ring. The label carries the same meaning.
 */
export function StatusIcon({ status, size = 14 }: { status: SessionStatus; size?: number }) {
  const value = status.value;
  const asking = isAsking(value);
  const color = status.error ? v.error : asking ? v.warn : value === 'working' ? v.primary : v.on2;
  return (
    <svg role="img" aria-label={statusText(status)} width={size} height={size} viewBox="0 0 16 16" style={{ flex: 'none' }}>
      {asking && <circle cx="8" cy="8" r="7" style={{ fill: v.warnContainer }} />}
      {value === 'exited' || value === 'starting' ? (
        <circle cx="8" cy="8" r="4.5" style={{ fill: 'none', stroke: color, strokeWidth: 1.8, opacity: value === 'starting' ? 0.6 : 1 }} />
      ) : (
        <circle className={value === 'working' ? 'ah-working' : undefined} cx="8" cy="8" r="4.5" style={{ fill: color }} />
      )}
    </svg>
  );
}

/** A sub-agent: working (pulsing), waiting for the user (amber with a halo), or done (a check). */
export function AgentStatusIcon({ agent, size = 14 }: { agent: AgentInfo; size?: number }) {
  const label = agentStatusText(agent);
  if (agent.state === 'stopped' && !agent.asking) {
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
