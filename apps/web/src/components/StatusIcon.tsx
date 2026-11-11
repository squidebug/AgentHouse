import { isAsking, type SessionStatus } from '@agenthouse/protocol';
import { v } from '../theme/tokens';
import { statusText } from './Details';

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
