import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentInfo, BackgroundTask, ScheduledPrompt, SessionInfo, StatusValue } from '@agenthouse/protocol';
import { agentsAtWork, board, loadScreen, runningIn, saveScreen, SHOWN_RUNNING, span, standingOf } from '../src/workspace/dashboard';

const agent = (id: string, extra: Partial<AgentInfo> = {}) => ({ id, parentId: null, state: 'running', asking: false, startedAt: 0, ...extra }) as unknown as AgentInfo;
const task = (id: string, state: BackgroundTask['state'] = 'running') => ({ id, state }) as unknown as BackgroundTask;
const job = (id: string) => ({ id, schedule: '*/5 * * * *', recurring: true }) as unknown as ScheduledPrompt;
const session = (id: string, value: StatusValue, extra: Partial<SessionInfo> = {}, at = 1) =>
  ({ id, title: id, state: 'running', startedAt: 0, exit: null, status: { value, reason: null, tool: null, error: false, at }, agents: [], tasks: [], schedules: [], ...extra }) as unknown as SessionInfo;
const ended = (id: string, at: number) => session(id, 'exited', { state: 'exited', exit: { code: 0, signal: null, at } });
const ids = (list: SessionInfo[]) => list.map((s) => s.id);

test('where a session stands: what needs the user first, then what works, what lives by a loop, what is idle, what ended', () => {
  assert.equal(standingOf(session('a', 'awaiting_permission')), 'asking');
  assert.equal(standingOf(session('a', 'awaiting_input', { schedules: [job('j')] })), 'asking', 'a looping session that asks is with those that ask');
  assert.equal(standingOf(session('a', 'working')), 'working');
  assert.equal(standingOf(session('a', 'idle', { agents: [agent('x')] })), 'working', 'idle itself while its sub-agents work: at work');
  assert.equal(standingOf(session('a', 'idle', { agents: [agent('x', { state: 'stopped' })] })), 'idle', 'its sub-agents are done');
  assert.equal(standingOf(session('a', 'idle', { schedules: [job('j')] })), 'scheduled');
  assert.equal(standingOf(session('a', 'working', { schedules: [job('j')] })), 'scheduled', 'a loop keeps its place while a run of it works, too');
  assert.equal(standingOf(session('a', 'idle', { tasks: [task('t')] })), 'idle', 'a command left running does not make it work');
  for (const value of ['idle', 'starting', 'unobserved'] as const) assert.equal(standingOf(session('a', value)), 'idle');
  assert.equal(standingOf(session('a', 'exited', { state: 'exited', schedules: [job('j')], agents: [agent('x')] })), 'ended');
  assert.equal(agentsAtWork(session('a', 'exited', { state: 'exited', agents: [agent('x')] })), false, 'nothing works in a session that ended');
});

test('the board: longest wait first, the order they started in, what went wrong and what finished last first', () => {
  const sessions = [
    session('ask-late', 'awaiting_permission', {}, 50),
    session('ask-early', 'awaiting_input', {}, 10),
    session('work-b', 'working', { startedAt: 2 }, 99),
    session('work-a', 'idle', { startedAt: 1, agents: [agent('x')] }, 5),
    session('loop', 'idle', { schedules: [job('j')] }),
    session('idle-old', 'idle', {}, 10),
    session('idle-new', 'idle', {}, 30),
    session('idle-failed', 'idle', { status: { value: 'idle', reason: 'rate_limit', tool: null, error: true, at: 20 } }),
    ended('ended-old', 10),
    ended('ended-new', 20),
  ];
  const by = board(sessions);
  assert.deepEqual(ids(by.asking), ['ask-early', 'ask-late']);
  assert.deepEqual(ids(by.working), ['work-a', 'work-b'], 'whatever each does at the moment, they keep their places');
  assert.deepEqual(ids(by.scheduled), ['loop']);
  assert.deepEqual(ids(by.idle), ['idle-failed', 'idle-new', 'idle-old']);
  assert.deepEqual(ids(by.ended), ['ended-new', 'ended-old']);
  assert.equal(Object.values(by).flat().length, sessions.length, 'every session is on it once');
});

test('what runs in a session: its loops, then its sub-agents at work under the one that started them, then what it left running', () => {
  const agents = [
    agent('lead'),
    agent('done', { state: 'stopped' }),
    agent('under-lead', { parentId: 'lead' }),
    agent('asks', { state: 'stopped', asking: true }),
    agent('under-done', { parentId: 'done' }),
  ];
  const running = runningIn(session('a', 'working', { agents, tasks: [task('watch'), task('built', 'done'), task('failed', 'failed')], schedules: [job('j')] }));
  assert.deepEqual(
    running.map((one) => (one.kind === 'schedule' ? `schedule ${one.job.id}` : one.kind === 'agent' ? `agent ${one.agent.id}${one.nested ? ' nested' : ''}` : `task ${one.task.id}`)),
    ['schedule j', 'agent lead', 'agent under-lead nested', 'agent under-done', 'agent asks', 'task watch'],
    'the one whose starter is done stands by itself; what ended is not among them',
  );
  assert.deepEqual(runningIn(session('a', 'idle')), []);
  assert.deepEqual(runningIn(session('a', 'exited', { state: 'exited', agents, schedules: [job('j')] })), [], 'nothing runs in a session that ended');
  assert.equal(SHOWN_RUNNING, 5);
});

test('how long something has been as it is, to the minute', () => {
  const minute = 60_000;
  assert.deepEqual(
    [0, 59_999, minute, 59 * minute, 60 * minute, 64 * minute, 24 * 60 * minute, 27 * 60 * minute, -5].map(span),
    ['1분 미만', '1분 미만', '1분', '59분', '1시간', '1시간 4분', '1일', '1일 3시간', '1분 미만'],
  );
});

test('the screen shown last is shown again: the workspace unless the dashboard or the usage was', () => {
  const kept = new Map<string, string>();
  const storage = { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value), removeItem: (key: string) => void kept.delete(key) };
  assert.equal(loadScreen(storage), 'workspace');
  saveScreen('dashboard', storage);
  assert.equal(loadScreen(storage), 'dashboard');
  saveScreen('usage', storage);
  assert.equal(loadScreen(storage), 'usage');
  saveScreen('workspace', storage);
  assert.equal(loadScreen(storage), 'workspace');
  assert.equal(kept.size, 0, 'the workspace leaves nothing behind');
  kept.set('ah-screen', 'settings');
  assert.equal(loadScreen(storage), 'workspace', 'a screen this page does not have');
  const blocked = {
    getItem: () => {
      throw new Error('blocked');
    },
  };
  assert.equal(loadScreen(blocked), 'workspace', 'storage that cannot be read');
});
