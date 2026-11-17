import { Badge, Box, Button, ButtonBase, IconButton, Popover, Tooltip, Typography } from '@mui/material';
import { useState } from 'react';
import type { AccountLimits, EnvReport, SessionInfo, ThemeMode, Vendor } from '@agenthouse/protocol';
import { t } from '../strings';
import { v } from '../theme/tokens';
import { SCREENS, type Screen } from '../workspace/dashboard';
import { CliDialog, CliRows } from './CliChoice';
import { CopyCommand } from './CopyCommand';
import { MoonIcon, PulseIcon, SunIcon } from './icons';
import { LimitsChip } from './LimitsChip';
import { Notifications } from './Notifications';
import { switchSide, switchTrack } from './switch';

interface Props {
  /** The workspace or the dashboard, and the switch between them. */
  screen: Screen;
  onScreen: (screen: Screen) => void;
  limits: AccountLimits[];
  env: EnvReport | null;
  envLoading: boolean;
  refreshEnv: () => void;
  mode: ThemeMode;
  onToggleMode: () => void;
  /** Sessions waiting for an approval or an answer, and how to show one. */
  waiting: SessionInfo[];
  onOpenSession: (sessionId: string) => void;
  notifyDone: boolean;
  onNotifyDone: (on: boolean) => void;
}

const LEVEL_COLOR = { error: v.error, warn: v.warn, info: v.on2 } as const;

export function TopBar({ screen, onScreen, limits, env, envLoading, refreshEnv, mode, onToggleMode, waiting, onOpenSession, notifyDone, onNotifyDone }: Props) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [choosing, setChoosing] = useState<Vendor | null>(null);
  const messages = env?.messages ?? [];
  const attention = messages.some((m) => m.level !== 'info');

  return (
    // Part of the page, like the tree below it: no face of its own and no line under it. In a window too
    // narrow for all of it on one line it takes a second one.
    <Box component="header" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, minHeight: 56, px: 2 }}>
      <Typography component="h1" variant="h6">
        {t.appName}
      </Typography>
      {/* What the page shows under the bar. On the page, so its track has the page's fill. */}
      <Box component="nav" aria-label={t.screens} sx={{ ...switchTrack, bgcolor: v.bg2, ml: 1 }}>
        {SCREENS.map((one) => (
          <ButtonBase key={one} aria-pressed={screen === one} onClick={() => onScreen(one)} sx={{ ...switchSide(screen === one), height: 32, px: '14px', fontSize: 13, fontWeight: 500 }}>
            {t.screen[one]}
          </ButtonBase>
        ))}
      </Box>
      <Box sx={{ flex: 1 }} />
      <LimitsChip limits={limits} />
      <Notifications waiting={waiting} onOpen={onOpenSession} notifyDone={notifyDone} onNotifyDone={onNotifyDone} />
      <Tooltip title={t.environment}>
        <IconButton aria-label={t.environment} onClick={(event) => setAnchor(event.currentTarget)} sx={{ width: 40, height: 40 }}>
          <Badge variant="dot" color="warning" invisible={!attention}>
            <PulseIcon />
          </Badge>
        </IconButton>
      </Tooltip>
      <Tooltip title={mode === 'dark' ? t.lightMode : t.darkMode}>
        <IconButton aria-label={mode === 'dark' ? t.lightMode : t.darkMode} onClick={onToggleMode} sx={{ width: 40, height: 40 }}>
          {mode === 'dark' ? <SunIcon /> : <MoonIcon />}
        </IconButton>
      </Tooltip>

      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 420, maxWidth: 'calc(100vw - 32px)', p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 } } }}
      >
        <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{t.environment}</Typography>
        {messages.length === 0 && <Typography sx={{ color: v.on2 }}>{t.noIssues}</Typography>}
        {messages.map((message) => (
          <Box key={message.id} sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'baseline' }}>
              <Box component="span" aria-hidden sx={{ flex: 'none', width: 8, height: 8, borderRadius: '50%', bgcolor: LEVEL_COLOR[message.level], transform: 'translateY(-1px)' }} />
              <Typography>{message.text}</Typography>
            </Box>
            {message.command && <CopyCommand command={message.command} />}
          </Box>
        ))}
        {env && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Typography sx={{ fontSize: 12, color: v.on2 }}>Node {env.node.version}</Typography>
            <CliRows env={env} onChange={setChoosing} />
          </Box>
        )}
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={refreshEnv} disabled={envLoading} size="small">
            {t.recheck}
          </Button>
        </Box>
      </Popover>
      <CliDialog
        status={env && choosing ? env.clis[choosing] : null}
        onClose={() => setChoosing(null)}
        onSaved={() => {
          setChoosing(null);
          refreshEnv();
        }}
      />
    </Box>
  );
}
