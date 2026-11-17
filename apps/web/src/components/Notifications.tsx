import { Badge, Box, FormControlLabel, IconButton, MenuItem, MenuList, Popover, Switch, Tooltip, Typography } from '@mui/material';
import { useState } from 'react';
import type { SessionInfo } from '@agenthouse/protocol';
import { t } from '../strings';
import { v } from '../theme/tokens';
import { ExternalMark, SessionSubtitle } from './Details';
import { BellIcon } from './icons';
import { StatusIcon } from './StatusIcon';

interface Props {
  /** Sessions waiting for an approval or an answer. */
  waiting: SessionInfo[];
  onOpen: (sessionId: string) => void;
  /** Finished work is announced too, while the tab is in the background. */
  notifyDone: boolean;
  onNotifyDone: (on: boolean) => void;
  /** The sessions started outside AgentHouse are watched: shown, and counted here when they wait. */
  external: boolean;
  onExternal: (on: boolean) => void;
}

/** What the browser lets the page announce: `unsupported` where it has no notifications at all. */
const permissionNow = (): NotificationPermission | 'unsupported' => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

/**
 * The bell at the top: how many sessions wait for the user, wherever their rows
 * are in the tree. It opens the list of them (one click shows a session) and
 * the choice of being told about finished work as well.
 */
export function Notifications({ waiting, onOpen, notifyDone, onNotifyDone, external, onExternal }: Props) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [permission, setPermission] = useState(permissionNow);
  const blocked = permission === 'denied' || permission === 'unsupported';
  // Whoever has waited longest comes first.
  const listed = [...waiting].sort((a, b) => a.status.at - b.status.at);

  const toggle = async (on: boolean) => {
    // The browser asks the user once; without a yes there is nothing to turn on.
    if (on && permissionNow() === 'default') {
      const answer = await Notification.requestPermission().catch(() => permissionNow());
      setPermission(answer);
      if (answer !== 'granted') return;
    }
    onNotifyDone(on);
  };

  return (
    <>
      <Tooltip title={t.notifications}>
        <IconButton
          aria-label={waiting.length ? `${t.notifications} · ${t.waitingCount(waiting.length)}` : t.notifications}
          onClick={(event) => {
            setPermission(permissionNow());
            setAnchor(event.currentTarget);
          }}
          sx={{ width: 40, height: 40 }}
        >
          <Badge badgeContent={waiting.length} color="warning" max={9}>
            <BellIcon />
          </Badge>
        </IconButton>
      </Tooltip>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 320, maxWidth: 'calc(100vw - 32px)', p: 2, display: 'flex', flexDirection: 'column', gap: 1 } } }}
      >
        <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{t.waiting}</Typography>
        {waiting.length === 0 ? (
          <Typography sx={{ color: v.on2 }}>{t.none}</Typography>
        ) : (
          <MenuList aria-label={t.waiting} sx={{ p: 0, mx: -1, maxHeight: 280, overflowY: 'auto', scrollbarWidth: 'thin' }}>
            {listed.map((session) => (
              <MenuItem
                key={session.id}
                onClick={() => {
                  setAnchor(null);
                  onOpen(session.id);
                }}
                sx={{ gap: '10px', px: 1, py: '6px', borderRadius: '8px' }}
              >
                <StatusIcon status={session.status} />
                <Box sx={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                    <Typography noWrap sx={{ minWidth: 0, fontWeight: 500 }}>
                      {session.title}
                    </Typography>
                    {session.external && <ExternalMark />}
                  </Box>
                  <SessionSubtitle session={session} />
                </Box>
              </MenuItem>
            ))}
          </MenuList>
        )}
        <Box sx={{ mt: 0.5, pt: 1, borderTop: `1px solid ${v.outline}`, display: 'flex', flexDirection: 'column' }}>
          <FormControlLabel
            label={t.notifyDone}
            labelPlacement="start"
            // On only while the browser would show them: a choice kept from before it stopped allowing them is off.
            control={<Switch size="small" checked={notifyDone && permission === 'granted'} disabled={blocked} onChange={(_event, on) => void toggle(on)} />}
            sx={{ m: 0, justifyContent: 'space-between' }}
          />
          {blocked && <Typography sx={{ fontSize: 12, lineHeight: '16px', color: v.on2 }}>{t.notifyBlocked}</Typography>}
          <FormControlLabel
            label={t.externalSessions}
            labelPlacement="start"
            control={<Switch size="small" checked={external} onChange={(_event, on) => onExternal(on)} />}
            sx={{ m: 0, justifyContent: 'space-between' }}
          />
        </Box>
      </Popover>
    </>
  );
}
