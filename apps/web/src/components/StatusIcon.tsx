import type { SessionInfo } from '@agenthouse/protocol';
import { t } from '../strings';
import { v } from '../theme/tokens';

/**
 * M1 knows only whether the CLI process runs. Working / waiting-for-approval /
 * idle arrive with hook telemetry (M4) and replace the neutral dot.
 */
export function StatusIcon({ state, size = 14 }: { state: SessionInfo['state']; size?: number }) {
  const label = state === 'running' ? t.running : t.exited;
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox="0 0 16 16" style={{ flex: 'none' }}>
      {state === 'running' ? (
        <circle cx="8" cy="8" r="4.5" style={{ fill: v.on2 }} />
      ) : (
        <circle cx="8" cy="8" r="4.5" style={{ fill: 'none', stroke: v.on2, strokeWidth: 1.8 }} />
      )}
    </svg>
  );
}
