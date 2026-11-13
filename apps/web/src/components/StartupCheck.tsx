import { Box, Button, LinearProgress, Tooltip, Typography, useMediaQuery } from '@mui/material';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { EnvMessage, EnvReport, Vendor } from '@agenthouse/protocol';
import { api, RequestError } from '../api/client';
import { describeIssue, startupIssues } from '../cli-choice';
import { t } from '../strings';
import { v } from '../theme/tokens';
import { CliDialog } from './CliChoice';
import { CopyCommand } from './CopyCommand';

// Long enough to read as a step of its own rather than a flicker; a check the server keeps answers at once.
const MIN_MS = 700;
const LEVEL_COLOR = { error: v.error, warn: v.warn, info: v.on2 } as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

type Phase = { name: 'checking' } | { name: 'issues'; env: EnvReport } | { name: 'offline' } | { name: 'ready' };

/** An issue in one line, a block like a copyable command's: what is wrong, and on the right what fixes it. */
function IssueLine({ message, onChange }: { message: EnvMessage; onChange: (vendor: Vendor) => void }) {
  const { label, vendor, change } = describeIssue(message);
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        minHeight: 48,
        pl: 2,
        pr: 1,
        borderRadius: '8px',
        border: `1px solid ${v.outline}`,
        bgcolor: v.surface,
      }}
    >
      <Box component="span" aria-hidden sx={{ flex: 'none', width: 8, height: 8, borderRadius: '50%', bgcolor: LEVEL_COLOR[message.level] }} />
      <Tooltip title={message.text} placement="top">
        <Typography sx={{ flex: 1, minWidth: 0, fontSize: 14, py: 1.25 }}>{label}</Typography>
      </Tooltip>
      {change && vendor ? (
        <Button size="small" onClick={() => onChange(vendor)} aria-label={`${t.vendorName[vendor]} ${t.executable} ${t.change}`} sx={{ flex: 'none', borderRadius: '8px', px: 1.5 }}>
          {t.change}
        </Button>
      ) : (
        message.command && (
          <Box sx={{ flex: 'none', maxWidth: '55%' }}>
            <CopyCommand command={message.command} plain />
          </Box>
        )
      )}
    </Box>
  );
}

/** The buttons under the issues: quiet grey, or in the primary tone for the one that goes on. */
function QuietButton({ children, onClick, primary = false }: { children: ReactNode; onClick: () => void; primary?: boolean }) {
  const [bg, fg] = primary ? [v.primaryContainer, v.onPrimaryContainer] : [v.surface2, v.on];
  return (
    <Button
      onClick={onClick}
      disableElevation
      sx={{
        height: 36,
        px: 2,
        borderRadius: '8px',
        fontSize: 14,
        fontWeight: 500,
        color: fg,
        bgcolor: bg,
        border: '1px solid transparent',
        '&:hover': { bgcolor: bg, borderColor: v.outline },
      }}
    >
      {children}
    </Button>
  );
}

/**
 * What the page shows first: nothing but a loading bar while the environment is
 * checked, then the workspace. When something is wrong (an error or a warning)
 * it stays on the same blank page and says what, a line each, with the fix.
 */
export function StartupCheck({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ name: 'checking' });
  const [choosing, setChoosing] = useState<Vendor | null>(null);
  const still = useMediaQuery('(prefers-reduced-motion: reduce)');

  const check = useCallback(async (refresh: boolean) => {
    setPhase({ name: 'checking' });
    const started = performance.now();
    let next: Phase;
    try {
      const env = await api.env(refresh);
      next = startupIssues(env).length ? { name: 'issues', env } : { name: 'ready' };
    } catch (error) {
      // Not logged in: the login page takes over.
      if (error instanceof RequestError && error.status === 401) return;
      next = { name: 'offline' };
    }
    await sleep(MIN_MS - (performance.now() - started));
    setPhase(next);
  }, []);

  useEffect(() => {
    check(false);
  }, [check]);

  if (phase.name === 'ready') return children;
  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>
      <Box sx={{ width: 'min(560px, 100%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2.5 }}>
        <Typography sx={{ fontSize: 18, fontWeight: 600 }}>{t.appName}</Typography>
        {phase.name === 'checking' && (
          <>
            <LinearProgress
              aria-label={t.checking}
              {...(still ? { variant: 'determinate' as const, value: 40 } : {})}
              sx={{ width: 220, height: 4, borderRadius: 2, bgcolor: v.surface3, '& .MuiLinearProgress-bar': { borderRadius: 2 } }}
            />
            <Typography sx={{ fontSize: 13, color: v.on2 }}>{t.checking}</Typography>
          </>
        )}
        {phase.name === 'offline' && (
          <>
            <Typography sx={{ fontSize: 13, color: v.on2 }}>{t.disconnected}</Typography>
            <QuietButton onClick={() => check(false)}>{t.recheck}</QuietButton>
          </>
        )}
        {phase.name === 'issues' && (
          <>
            <Box sx={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 1.5 }}>
              {startupIssues(phase.env).map((message) => (
                <IssueLine key={message.id} message={message} onChange={setChoosing} />
              ))}
            </Box>
            <Box sx={{ display: 'flex', gap: 1.5 }}>
              <QuietButton onClick={() => check(true)}>{t.recheck}</QuietButton>
              <QuietButton primary onClick={() => setPhase({ name: 'ready' })}>
                {t.continue}
              </QuietButton>
            </Box>
          </>
        )}
      </Box>
      <CliDialog
        status={choosing && phase.name === 'issues' ? phase.env.clis[choosing] : null}
        onClose={() => setChoosing(null)}
        onSaved={() => {
          setChoosing(null);
          check(true);
        }}
      />
    </Box>
  );
}
