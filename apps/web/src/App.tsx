import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Snackbar, Typography } from '@mui/material';
import { useColorScheme } from '@mui/material/styles';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { isAsking, takesInput, type DelegationInfo, type SessionInfo, type StatusValue, type ThemeMode } from '@agenthouse/protocol';
import { api, RequestError } from './api/client';
import { useEnv, useSessions } from './api/hooks';
import { Composer } from './components/Composer';
import { CopyCommand } from './components/CopyCommand';
import { Dashboard } from './components/Dashboard';
import { statusText } from './components/Details';
import { LaunchDialog } from './components/LaunchDialog';
import { PaneGrid } from './components/PaneGrid';
import { SessionTree } from './components/SessionTree';
import { TopBar } from './components/TopBar';
import { t } from './strings';
import { v } from './theme/tokens';
import { loadScreen, saveScreen, type Screen } from './workspace/dashboard';
import { makeDnd } from './workspace/dnd';
import { finished, loadNotifyDone, saveNotifyDone, statusesOf } from './workspace/notify';
import { delegatesOf, parentsOf } from './workspace/tree';
import { isModeShortcut, loadWorkspace, paneModes, reducer, saveWorkspace, shownMode, switchedMode, type Action, type DropContext, type WorkspaceState } from './workspace/state';

export function App() {
  const { mode, systemMode, setMode } = useColorScheme();
  const resolved: ThemeMode = (mode === 'system' ? systemMode : mode) === 'dark' ? 'dark' : 'light';
  const { env, loading: envLoading, refresh: refreshEnv } = useEnv();
  // What to do with every session list as it arrives; set further down, once what it needs is there.
  const arrived = useRef<(list: SessionInfo[]) => void>(() => {});
  const { sessions, limits, links, delegations, external, connected, loaded } = useSessions((list) => arrived.current(list));

  // Sessions launched from this tab, until the live list includes them.
  const [launched, setLaunched] = useState<Record<string, SessionInfo>>({});
  const [launchOpen, setLaunchOpen] = useState(false);
  const [ending, setEnding] = useState<SessionInfo | null>(null);
  // Ended sessions to take off the list at once, after a yes.
  const [removing, setRemoving] = useState<{ open: boolean; list: SessionInfo[] }>({ open: false, list: [] });

  const ctxRef = useRef<DropContext>({ runningIds: [] });
  const [state, dispatch] = useReducer((s: WorkspaceState, a: Action) => reducer(s, a, ctxRef.current), undefined, () => loadWorkspace());

  const { panes, active, nextPane, paneMode } = state;
  // Only what a reload brings back is saved, so only a change of that saves.
  useEffect(() => saveWorkspace(state), [panes, active, nextPane, paneMode]);

  // What shows under the top bar: the workspace, or the dashboard laid over it.
  const [screen, setScreen] = useState<Screen>(() => loadScreen());
  useEffect(() => saveScreen(screen), [screen]);
  // A session asked for from outside the workspace (the bell, a notification, a card of the dashboard) shows there.
  const openSession = useCallback((sessionId: string) => {
    dispatch({ type: 'open', sessionId });
    setScreen('workspace');
  }, []);

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
  const runningIds = [...byId.values()].filter(takesInput).map((s) => s.id);
  const delegates = delegatesOf([...byId.values()], links);
  const externalIds = [...byId.values()].filter((s) => s.external).map((s) => s.id);
  ctxRef.current = { runningIds, parents: parentsOf([...byId.values()], links), delegates, externalIds };

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
    dispatch({ type: 'sync', sessionIds: [...byId.keys()], runningIds: [...byId.values()].filter(takesInput).map((s) => s.id) });
  }, [byId, loaded]);

  // Sessions waiting for an approval or an answer: counted in the tab title and on the bell, and
  // announced by a notification while the tab is in the background.
  const asking = useMemo(() => sessions.filter((s) => isAsking(s.status.value)), [sessions]);
  useEffect(() => {
    document.title = asking.length ? `(${asking.length}) ${t.appName}` : t.appName;
  }, [asking.length]);
  // One notification per session: the next takes the place of the last one, closed first so that it shows again.
  const notes = useRef(new Map<string, Notification>());
  const announce = useCallback(
    (session: SessionInfo, body: string) => {
      if (document.visibilityState === 'visible' || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      notes.current.get(session.id)?.close();
      const note = new Notification(session.title, { body, tag: session.id });
      notes.current.set(session.id, note);
      note.onclick = () => {
        window.focus();
        openSession(session.id);
        note.close();
      };
    },
    [openSession],
  );
  const announced = useRef(new Map<string, number>());
  useEffect(() => {
    for (const session of asking) {
      if (announced.current.get(session.id) === session.status.at) continue;
      announced.current.set(session.id, session.status.at);
      announce(session, statusText(session.status));
    }
  }, [asking, announce]);

  // Finished work is announced the same way, for a user who asked for that (the bell's switch). Told
  // from one list to the next as they arrive, not from what is drawn, which may skip a list.
  const [notifyDone, setNotifyDone] = useState(() => loadNotifyDone());
  const statuses = useRef(new Map<string, StatusValue>());
  arrived.current = (list) => {
    const done = finished(statuses.current, list);
    statuses.current = statusesOf(list);
    if (!notifyDone) return;
    // How it ended, when not simply done: 오류 · rate_limit, 대기 · 중단됨.
    for (const session of done) announce(session, session.status.error || session.status.reason ? statusText(session.status) : t.workDone);
  };

  // Ctrl+`: the active pane between its terminal and its conversation, from anywhere on the page.
  // Taken before the terminal sees it, so it never reaches the CLI.
  const latest = useRef({ state, byId, screen });
  latest.current = { state, byId, screen };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Under the dashboard no pane is in sight to switch.
      if (!isModeShortcut(event) || latest.current.screen !== 'workspace') return;
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
      <TopBar
        screen={screen}
        onScreen={setScreen}
        limits={limits}
        env={env}
        envLoading={envLoading}
        refreshEnv={() => refreshEnv().catch(() => {})}
        mode={resolved}
        onToggleMode={() => setMode(resolved === 'dark' ? 'light' : 'dark')}
        waiting={asking}
        onOpenSession={openSession}
        notifyDone={notifyDone}
        onNotifyDone={(on) => {
          setNotifyDone(on);
          saveNotifyDone(on);
        }}
        external={external}
        // The server keeps it and tells every page: the switch moves when that comes back.
        onExternal={(on) => void api.watchExternal(on).catch(failed(t.failure.setting))}
      />

      {(!connected || noCli) && (
        <Box role="status" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1.5, m: '12px 16px 0', p: '10px 14px', borderRadius: '12px', bgcolor: v.warnContainer, color: v.onWarnContainer }}>
          <Typography>{connected ? noCli?.text : t.disconnected}</Typography>
          {connected && noCli?.command && <CopyCommand command={noCli.command} />}
        </Box>
      )}

      <Box sx={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Box
          // Under the dashboard the workspace stays as it is, out of sight and out of reach, with every
          // pane at its size. Taken out of the layout instead, a terminal would be fitted again to a box
          // without a size (a few cells) and would tell its PTY so.
          inert={screen !== 'workspace'}
          sx={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexWrap: { xs: 'wrap', md: 'nowrap' },
            alignItems: { xs: 'flex-start', md: 'stretch' },
            gap: '12px 20px',
            p: '12px 16px 16px',
            visibility: screen === 'workspace' ? 'visible' : 'hidden',
          }}
        >
          <SessionTree
            sessions={[...byId.values()]}
            links={links}
            onLink={(childId, parentId, kind) => api.link(childId, parentId, kind).catch(failed(t.failure.link))}
            state={state}
            dispatch={dispatch}
            dnd={dnd}
            onNew={() => setLaunchOpen(true)}
            onEnd={(id) => setEnding(byId.get(id) ?? null)}
            // The same session comes back, shown like one just started: in the pane that has it, else in a new one.
            onResume={(id) =>
              api
                .resume(id, resolved)
                .then(() => dispatch({ type: 'openNew', sessionId: id }))
                .catch(failed(t.failure.resume))
            }
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
            <Composer state={state} dispatch={dispatch} dnd={dnd} sessionById={sessionById} activeSession={activeSession} delegates={delegates} />
          </Box>
        </Box>
        {screen === 'dashboard' && (
          // Over the workspace, with the page's own face: whatever lies under it is covered.
          <Box sx={{ position: 'absolute', inset: 0, overflowY: 'auto', scrollbarWidth: 'thin', bgcolor: v.bg }}>
            <Dashboard sessions={[...byId.values()]} links={links} limits={limits} onOpen={openSession} onNew={() => setLaunchOpen(true)} />
          </Box>
        )}
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
          // Started from the dashboard too, a new session shows where it is worked with.
          setScreen('workspace');
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
