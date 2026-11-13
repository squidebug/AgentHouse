import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Snackbar, Typography } from '@mui/material';
import { useColorScheme } from '@mui/material/styles';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { isAsking, type DelegationInfo, type SessionInfo, type ThemeMode } from '@agenthouse/protocol';
import { api, RequestError } from './api/client';
import { useEnv, useSessions } from './api/hooks';
import { Composer } from './components/Composer';
import { CopyCommand } from './components/CopyCommand';
import { statusText } from './components/Details';
import { LaunchDialog } from './components/LaunchDialog';
import { PaneGrid } from './components/PaneGrid';
import { SessionTree } from './components/SessionTree';
import { TopBar } from './components/TopBar';
import { t } from './strings';
import { v } from './theme/tokens';
import { makeDnd } from './workspace/dnd';
import { delegatesOf, parentsOf } from './workspace/tree';
import { isModeShortcut, loadWorkspace, paneModes, reducer, saveWorkspace, shownMode, switchedMode, type Action, type DropContext, type WorkspaceState } from './workspace/state';

export function App() {
  const { mode, systemMode, setMode } = useColorScheme();
  const resolved: ThemeMode = (mode === 'system' ? systemMode : mode) === 'dark' ? 'dark' : 'light';
  const { env, loading: envLoading, refresh: refreshEnv } = useEnv();
  const { sessions, limits, links, delegations, connected, loaded } = useSessions();

  // Sessions launched from this tab, until the live list includes them.
  const [launched, setLaunched] = useState<Record<string, SessionInfo>>({});
  const [launchOpen, setLaunchOpen] = useState(false);
  const [ending, setEnding] = useState<SessionInfo | null>(null);
  // Ended sessions to take off the list at once, after a yes.
  const [removing, setRemoving] = useState<{ open: boolean; list: SessionInfo[] }>({ open: false, list: [] });

  const ctxRef = useRef<DropContext>({ runningIds: [] });
  const [state, dispatch] = useReducer((s: WorkspaceState, a: Action) => reducer(s, a, ctxRef.current), undefined, () => loadWorkspace());

  const { panes, active, nextPane, paneMode } = state;
  useEffect(() => saveWorkspace({ ...state, panes, active, nextPane, paneMode }), [panes, active, nextPane, paneMode]);

  const byId = useMemo(() => {
    const map = new Map<string, SessionInfo>(Object.entries(launched));
    for (const s of sessions) map.set(s.id, s);
    return map;
  }, [sessions, launched]);
  // One function for as long as the page lives, reading the newest list: nothing is redrawn just because
  // the list was replaced. Whoever shows a session is redrawn with it anyway.
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  const sessionById = useCallback((id: string) => byIdRef.current.get(id), []);
  // Where sessions ran before, the latest first: what the launcher offers for a new one.
  const folders = useMemo(() => [...new Set([...byId.values()].sort((a, b) => b.startedAt - a.startedAt).map((s) => s.cwd))], [byId]);
  const runningIds = [...byId.values()].filter((s) => s.state === 'running').map((s) => s.id);
  ctxRef.current = { runningIds, parents: parentsOf([...byId.values()], links), delegates: delegatesOf([...byId.values()], links) };

  useEffect(() => {
    const listed = new Set(sessions.map((s) => s.id));
    setLaunched((current) => {
      const pending = Object.fromEntries(Object.entries(current).filter(([id]) => !listed.has(id)));
      return Object.keys(pending).length === Object.keys(current).length ? current : pending;
    });
  }, [sessions]);

  useEffect(() => {
    // Until the first list arrives, every restored pane would look like a removed session.
    if (!loaded) return;
    dispatch({ type: 'sync', sessionIds: [...byId.keys()], runningIds: [...byId.values()].filter((s) => s.state === 'running').map((s) => s.id) });
  }, [byId, loaded]);

  // Sessions waiting for an approval or an answer: counted in the tab title, and
  // announced by a notification while the tab is in the background.
  const asking = useMemo(() => sessions.filter((s) => isAsking(s.status.value)), [sessions]);
  useEffect(() => {
    document.title = asking.length ? `(${asking.length}) ${t.appName}` : t.appName;
  }, [asking.length]);
  const announced = useRef(new Map<string, number>());
  useEffect(() => {
    for (const session of asking) {
      if (announced.current.get(session.id) === session.status.at) continue;
      announced.current.set(session.id, session.status.at);
      if (document.visibilityState === 'visible' || typeof Notification === 'undefined' || Notification.permission !== 'granted') continue;
      const note = new Notification(session.title, { body: statusText(session.status), tag: session.id });
      note.onclick = () => {
        window.focus();
        dispatch({ type: 'open', sessionId: session.id });
        note.close();
      };
    }
  }, [asking]);

  // Ctrl+`: the active pane between its terminal and its conversation, from anywhere on the page.
  // Taken before the terminal sees it, so it never reaches the CLI.
  const latest = useRef({ state, byId });
  latest.current = { state, byId };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isModeShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const { state: now, byId: known } = latest.current;
      const pane = now.panes.find((p) => p.id === now.active);
      const session = pane ? known.get(pane.sessionId) : undefined;
      if (!pane || !session) return;
      const modes = paneModes(pane, session);
      const next = switchedMode(shownMode(now.paneMode[pane.id], modes), modes);
      if (next) dispatch({ type: 'setMode', paneId: pane.id, mode: next });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const dnd = makeDnd(state, dispatch, ctxRef.current);
  const activePane = state.panes.find((p) => p.id === state.active);
  const activeSession = activePane ? byId.get(activePane.sessionId) : undefined;
  const noCli = env?.messages.find((m) => m.id === 'ENV_NO_CLI');

  // A refused or failed change (a delegate waiting on a dialog, the host away) leaves things as they
  // are and says so for a moment, with the server's reason when there is one.
  const [problem, setProblem] = useState<string | null>(null);
  const failed = useCallback((label: string) => (error: unknown) => setProblem(error instanceof RequestError ? `${label} · ${error.message}` : label), []);
  const onDelegate = useCallback((parentId: string, childId: string, text: string) => void api.delegate(parentId, childId, text).catch(failed(t.failure.delegate)), [failed]);
  const onDeliver = useCallback((task: DelegationInfo, header: string) => void api.deliver(task.id, header).catch(failed(t.failure.deliver)), [failed]);

  const endSession = async (session: SessionInfo) => {
    setEnding(null);
    await api.end(session.id).catch(failed(t.failure.end));
  };

  return (
    <Box
      onDragOver={() => dispatch({ type: 'clearOver' })}
      onDragEnd={() => dispatch({ type: 'dragEnd' })}
      // Side by side (a window wide enough), the page is the window: the tree and the panes scroll on their
      // own, so a long tree never takes the panes off the screen. Narrower, it is a page that scrolls.
      sx={{ minHeight: '100vh', height: { md: '100vh' }, overflow: { md: 'hidden' }, display: 'flex', flexDirection: 'column', bgcolor: v.bg, color: v.on }}
    >
      <TopBar limits={limits} env={env} envLoading={envLoading} refreshEnv={() => refreshEnv().catch(() => {})} mode={resolved} onToggleMode={() => setMode(resolved === 'dark' ? 'light' : 'dark')} />

      {(!connected || noCli) && (
        <Box role="status" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1.5, m: '12px 16px 0', p: '10px 14px', borderRadius: '12px', bgcolor: v.warnContainer, color: v.onWarnContainer }}>
          <Typography>{connected ? noCli?.text : t.disconnected}</Typography>
          {connected && noCli?.command && <CopyCommand command={noCli.command} />}
        </Box>
      )}

      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexWrap: { xs: 'wrap', md: 'nowrap' }, alignItems: { xs: 'flex-start', md: 'stretch' }, gap: '12px 20px', p: '12px 16px 16px' }}>
        <SessionTree
          sessions={[...byId.values()]}
          links={links}
          onLink={(childId, parentId, kind) => api.link(childId, parentId, kind).catch(failed(t.failure.link))}
          state={state}
          dispatch={dispatch}
          dnd={dnd}
          onNew={() => setLaunchOpen(true)}
          onEnd={(id) => setEnding(byId.get(id) ?? null)}
          onRemove={(id) => api.remove(id).catch(failed(t.failure.remove))}
          onRemoveEnded={(list) => setRemoving({ open: true, list })}
        />
        <Box
          component="main"
          sx={{
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            // Its scrollbar has its place whether it shows or not: a draft growing in the composer must
            // not narrow the panes, which would resize every terminal.
            overflowY: { md: 'auto' },
            scrollbarGutter: { md: 'stable' },
            scrollbarWidth: 'thin',
            // What scrolls cuts off whatever is outside it: the padding is room for the panes' shadows and
            // the active pane's outline. The margin takes the room back and the basis grows by as much
            // (560 + 2 × (12 - 3)), so the panes are exactly as wide as they were with 3px of it.
            flex: { xs: '999 1 560px', md: '999 1 578px' },
            p: { md: '12px' },
            m: { md: '-12px' },
          }}
        >
          <PaneGrid
            state={state}
            dispatch={dispatch}
            dnd={dnd}
            sessionById={sessionById}
            mode={resolved}
            windowsBuild={env?.windowsBuild ?? null}
            onNew={() => setLaunchOpen(true)}
            links={links}
            delegations={delegations}
            onDelegate={onDelegate}
            onDeliver={onDeliver}
          />
          <Composer state={state} dispatch={dispatch} dnd={dnd} sessionById={sessionById} activeSession={activeSession} />
        </Box>
      </Box>

      <LaunchDialog
        open={launchOpen}
        env={env}
        folders={folders}
        mode={resolved}
        onClose={() => setLaunchOpen(false)}
        onLaunched={(session) => {
          setLaunched((current) => ({ ...current, [session.id]: session }));
          dispatch({ type: 'openNew', sessionId: session.id });
          // Asked once, right after the user starts a session: approval requests notify from then on.
          if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
        }}
      />

      <Dialog open={Boolean(ending)} onClose={() => setEnding(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: 18, fontWeight: 600 }}>{t.endSession}</DialogTitle>
        <DialogContent>
          <Typography>{ending?.title}</Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setEnding(null)}>
            {t.cancel}
          </Button>
          <Button variant="contained" color="error" onClick={() => ending && endSession(ending)}>
            {t.endSession}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={removing.open} onClose={() => setRemoving((current) => ({ ...current, open: false }))} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: 18, fontWeight: 600 }}>{t.removeEnded(removing.list.length)}</DialogTitle>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setRemoving((current) => ({ ...current, open: false }))}>
            {t.cancel}
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={() => {
              setRemoving((current) => ({ ...current, open: false }));
              void Promise.all(removing.list.map((session) => api.remove(session.id))).catch(failed(t.failure.remove));
            }}
          >
            {t.removeAll}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={Boolean(problem)} message={problem} autoHideDuration={6000} onClose={() => setProblem(null)} anchorOrigin={{ vertical: 'top', horizontal: 'center' }} />
    </Box>
  );
}
