import { Box, Button, ButtonBase, Typography } from '@mui/material';
import { memo, useEffect, useState } from 'react';
import { isAsking, type AccountLimits, type LatestWords, type RateWindow, type SessionInfo, type SessionLink } from '@agenthouse/protocol';
import { api } from '../api/client';
import { t } from '../strings';
import { motion, v } from '../theme/tokens';
import { elapsedMs } from '../workspace/agents';
import { clock, scheduleText, taskElapsedMs, taskTitle, taskType } from '../workspace/background';
import { agentsAtWork, board, runningIn, SHOWN_RUNNING, span, type Running, type Standing } from '../workspace/dashboard';
import { folderName, validLinks } from '../workspace/tree';
import { activity, agentStatusText, agentTitle, modelLabel, statusText } from './Details';
import { ChevronIcon, ClockIcon, DelegateIcon, LinkIcon, PlusIcon } from './icons';
import { fresh, resetText, tone } from './LimitsChip';
import { AgentStatusIcon, StatusIcon, TaskStatusIcon } from './StatusIcon';

// How long things have been as they are is told to the minute: often enough to keep that true.
const TICK_MS = 15_000;
// A transcript is written a moment before or after a turn starts or ends: looked at once more, for what came late.
const LATE_MS = 2000;
// While a session works, a prompt that was waiting may take over without the session ever being idle.
const WORKING_MS = 20_000;

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

const sameWords = (a: LatestWords | null, b: LatestWords) => a !== null && a.prompt === b.prompt && a.promptAt === b.promptAt && a.answer === b.answer;

/**
 * What the session was last asked and what it last said: read when its card
 * shows and again whenever it starts or ends something, not with every step of
 * a turn (a status changes with each tool).
 */
function useLatest(session: SessionInfo): LatestWords | null {
  const [words, setWords] = useState<LatestWords | null>(null);
  const { id } = session;
  const conversations = session.transcripts.length;
  const doing = session.status.value;
  // When it came to rest: a turn too short to be seen at work (the host reports in bursts) still ends at a new time.
  const rested = doing === 'working' ? 0 : session.status.at;
  useEffect(() => {
    if (!conversations) {
      setWords(null);
      return undefined;
    }
    let gone = false;
    const load = () => {
      api
        .latest(id)
        .then((next) => {
          if (!gone) setWords((current) => (sameWords(current, next) ? current : next));
        })
        .catch(() => {});
    };
    load();
    const late = setTimeout(load, LATE_MS);
    const again = doing === 'working' ? setInterval(load, WORKING_MS) : undefined;
    return () => {
      gone = true;
      clearTimeout(late);
      clearInterval(again);
    };
  }, [id, conversations, doing, rested]);
  return words;
}

const small = { fontSize: 12, lineHeight: '16px' } as const;
const oneLine = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;
// A few words of a prompt or an answer: two lines of them at most.
const twoLines = { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden', overflowWrap: 'anywhere' } as const;

/** A share of something as a thin bar. */
function Gauge({ label, pct, width, height, track }: { label: string; pct: number; width: number; height: number; track: string }) {
  return (
    <Box role="meter" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} sx={{ flex: 'none', width, height, borderRadius: `${height / 2}px`, bgcolor: track, overflow: 'hidden' }}>
      <Box sx={{ width: `${Math.min(100, pct)}%`, height: '100%', borderRadius: 'inherit', bgcolor: tone(pct) }} />
    </Box>
  );
}

/** Plan usage, both windows at a glance with when they start over: what the top bar's chip shows one number of. */
function Usage({ limits, now }: { limits: AccountLimits[]; now: number }) {
  const claude = limits.find((one) => one.vendor === 'claude');
  const windows: Array<{ label: string; window: RateWindow }> = [];
  for (const [label, window] of [
    [t.fiveHour, fresh(claude?.fiveHour ?? null, now)],
    [t.sevenDay, fresh(claude?.sevenDay ?? null, now)],
  ] as const) {
    if (window) windows.push({ label, window });
  }
  if (!windows.length) return null;
  return (
    <Box role="group" aria-label={`${t.vendorName.claude} ${t.usage}`} sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 20px', color: v.on2, ...small }}>
      <Box component="span" sx={{ fontWeight: 500, color: v.on }}>
        {t.vendorName.claude}
      </Box>
      {windows.map(({ label, window }) => {
        const pct = Math.round(window.usedPct);
        return (
          <Box key={label} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <span>{label}</span>
            <Gauge label={label} pct={pct} width={96} height={6} track={v.bg2} />
            <Box component="span" sx={{ fontWeight: 600, color: tone(pct) }}>
              {pct}%
            </Box>
            {window.resetsAt !== null && <span>{resetText(window.resetsAt, now)}</span>}
          </Box>
        );
      })}
    </Box>
  );
}

/** One of the things that run in a session, on a line of its card: what it is, and what it does now or how long it has run. */
function RunningLine({ one, now }: { one: Running; now: number }) {
  let mark: React.ReactNode;
  let what: string;
  let does: React.ReactNode;
  if (one.kind === 'schedule') {
    const { job } = one;
    mark = <ClockIcon role="img" aria-label={t.scheduled} size={12} style={{ flex: 'none', color: v.on2 }} />;
    what = [scheduleText(job, now), job.runs ? t.runCount(job.runs) : null].filter(Boolean).join(' · ');
    // One that runs once says when in its schedule already.
    does = !job.recurring ? null : job.nextAt !== null && job.nextAt > now ? t.runsAt(clock(job.nextAt, now)) : job.lastAt !== null ? t.ranAt(clock(job.lastAt, now)) : null;
  } else if (one.kind === 'agent') {
    const { agent } = one;
    mark = <AgentStatusIcon agent={agent} size={12} />;
    what = agentTitle(agent);
    const took = span(elapsedMs(agent, now));
    does = agent.asking ? (
      <Box component="span" sx={{ fontWeight: 500, color: v.warn }}>
        {agentStatusText(agent)}
      </Box>
    ) : agent.tool ? (
      <>
        <Box component="span" sx={{ fontWeight: 500, color: v.primary }}>
          {agent.tool}
        </Box>
        {` · ${took}`}
      </>
    ) : (
      took
    );
  } else {
    const { task } = one;
    mark = <TaskStatusIcon task={task} size={12} />;
    what = taskTitle(task);
    does = `${taskType(task)} · ${task.lastEvent ?? span(taskElapsedMs(task, now))}`;
  }
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px', minHeight: 22, minWidth: 0, ...small }}>
      {/* Under the sub-agent that started it, as in the tree. */}
      {one.kind === 'agent' && one.nested && (
        <Box component="span" aria-hidden sx={{ flex: 'none', width: 8, height: 12, m: '-8px 0 0 2px', borderLeft: `1.5px solid ${v.outline}`, borderBottom: `1.5px solid ${v.outline}`, borderBottomLeftRadius: '5px' }} />
      )}
      {mark}
      <Box component="span" sx={{ flex: 1, ...oneLine }}>
        {what}
      </Box>
      {does && (
        <Box component="span" sx={{ flex: 'none', maxWidth: '62%', color: v.on2, ...oneLine }}>
          {does}
        </Box>
      )}
    </Box>
  );
}

interface CardProps {
  session: SessionInfo;
  /** The session it was placed under, and whether that one can hand it work. */
  parent: string | null;
  delegated: boolean;
  now: number;
  onOpen: (sessionId: string) => void;
}

/**
 * A session, all of it the button that shows it in the workspace. Unlike a row
 * of the tree it says more than status, title and model: the dashboard is
 * where the user looks at every session at once, without opening any.
 */
const Card = memo(function Card({ session, parent, delegated, now, onOpen }: CardProps) {
  const latest = useLatest(session);
  const ended = session.state === 'exited';
  // The card speaks for the whole session: at work while its sub-agents are, though its own conversation is idle.
  const byAgents = session.status.value === 'idle' && agentsAtWork(session);
  const inTurn = session.status.value === 'working' || byAgents;
  const status = byAgents ? { ...session.status, value: 'working' as const } : session.status;
  const says = byAgents ? { text: t.agentsAtWork, color: v.primary } : (activity(session) ?? { text: statusText(session.status), color: v.on2 });
  // A status is as old as the last step of a turn: how long the turn has gone on is told by when it was asked for.
  const since = inTurn ? (latest?.promptAt ?? null) : session.status.at;
  const lasted = since === null ? null : ended ? (now - since < 60_000 ? t.justNow : t.before(span(now - since))) : span(now - since);
  const answered = !inTurn && !isAsking(session.status.value);
  const running = runningIn(session);
  const effort = session.telemetry.effort ?? session.effort;
  const context = session.telemetry.contextPct === null ? null : Math.round(session.telemetry.contextPct);

  return (
    <ButtonBase
      component="div"
      onClick={() => onOpen(session.id)}
      aria-label={t.open(session.title)}
      sx={{
        position: 'relative',
        isolation: 'isolate',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        justifyContent: 'flex-start',
        gap: 1,
        p: '12px 14px',
        borderRadius: '12px',
        bgcolor: v.surface,
        boxShadow: v.shadow1,
        textAlign: 'left',
        // The veil under the pointer, between the card's face and what is on it, like a row of the tree.
        '&::before': { content: '""', position: 'absolute', inset: 0, zIndex: -1, borderRadius: 'inherit', bgcolor: v.hover, opacity: 0, transition: `opacity ${motion.fast}` },
        '&:hover::before': { opacity: 1 },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, minWidth: 0 }}>
        <Box component="span" sx={{ flex: 'none', display: 'inline-flex', mt: '3px' }}>
          <StatusIcon status={status} />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Typography noWrap sx={{ fontWeight: 600, color: ended ? v.on2 : v.on }}>
            {session.title}
          </Typography>
          <Typography noWrap sx={{ color: v.on2, ...small }}>
            <Box component="span" sx={{ color: says.color, fontWeight: 500 }}>
              {says.text}
            </Box>
            {lasted && ` · ${lasted}`}
          </Typography>
        </Box>
      </Box>
      {/* Under the title, like the second line of a row. */}
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1, pl: '22px' }}>
        {(latest?.prompt || (answered && latest?.answer)) && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {latest?.prompt && <Typography sx={twoLines}>{latest.prompt}</Typography>}
            {answered && latest?.answer && <Typography sx={{ ...twoLines, ...small, color: v.on2 }}>{latest.answer}</Typography>}
          </Box>
        )}
        {running.length > 0 && (
          // What runs in the session now, set into the card as an area of its own: a card that has one is a
          // session in which something runs.
          <Box role="group" aria-label={`${session.title} ${t.running}`} sx={{ display: 'flex', flexDirection: 'column', p: '3px 8px', borderRadius: '8px', bgcolor: v.surface2, boxShadow: v.well }}>
            {running.slice(0, SHOWN_RUNNING).map((one) => (
              <RunningLine key={one.kind === 'schedule' ? `s${one.job.id}` : one.kind === 'agent' ? `a${one.agent.id}` : `t${one.task.id}`} one={one} now={now} />
            ))}
            {running.length > SHOWN_RUNNING && (
              <Box sx={{ display: 'flex', alignItems: 'center', minHeight: 22, pl: '18px', color: v.on2, ...small }}>{t.more(running.length - SHOWN_RUNNING)}</Box>
            )}
          </Box>
        )}
        {parent !== null && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: '4px', color: v.on2, ...small }}>
            {delegated ? (
              <DelegateIcon role="img" aria-label={t.delegate} size={12} style={{ flex: 'none', color: v.primary }} />
            ) : (
              <LinkIcon role="img" aria-label={t.group} size={12} style={{ flex: 'none' }} />
            )}
            <Box component="span" sx={oneLine}>
              {parent}
            </Box>
          </Box>
        )}
        <Box sx={{ mt: 'auto', display: 'flex', alignItems: 'center', gap: 1, color: v.on2, ...small }}>
          <Box component="span" sx={{ flex: 1, ...oneLine }}>
            {[folderName(session.cwd), modelLabel(session), effort].filter(Boolean).join(' · ')}
          </Box>
          {context !== null && (
            <>
              <Gauge label={t.context} pct={context} width={40} height={4} track={v.surface3} />
              <Box component="span" sx={{ flex: 'none', ...(context >= 75 && { color: tone(context), fontWeight: 500 }) }}>
                {context}%
              </Box>
            </>
          )}
        </Box>
      </Box>
    </ButtonBase>
  );
});

const gridSx = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(296px, 1fr))', gap: '12px' } as const;

// What each place of the board is called; the ended sessions fold into a line of their own.
const TITLES: Record<Exclude<Standing, 'ended'>, string> = { asking: t.waiting, working: t.status.working, scheduled: t.scheduled, idle: t.status.idle };

interface Props {
  sessions: SessionInfo[];
  links: SessionLink[];
  limits: AccountLimits[];
  /** Shows a session in the workspace. */
  onOpen: (sessionId: string) => void;
  onNew: () => void;
}

/**
 * Every session at a glance, by what it is doing: those waiting for the user
 * first, then those at work, those living by a prompt set for them, the idle
 * ones, and the ended ones folded away. What runs inside a session shows in
 * its card.
 */
export function Dashboard({ sessions, links, limits, onOpen, onNew }: Props) {
  const now = useNow(TICK_MS);
  const [endedOpen, setEndedOpen] = useState(false);
  const by = board(sessions);
  const placed = validLinks(sessions, links);
  const titles = new Map(sessions.map((session) => [session.id, session.title]));
  const cards = (list: SessionInfo[]) =>
    list.map((session) => {
      const link = placed.get(session.id);
      return <Card key={session.id} session={session} parent={link ? (titles.get(link.parentId) ?? null) : null} delegated={link?.kind === 'delegate'} now={now} onOpen={onOpen} />;
    });

  return (
    <Box component="section" aria-label={t.screen.dashboard} sx={{ minHeight: '100%', display: 'flex', flexDirection: 'column', gap: 3, p: '12px 16px 24px' }}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 20px', minHeight: 36, pl: '6px' }}>
        <Usage limits={limits} now={now} />
        <Box sx={{ flex: 1 }} />
        <Button variant="contained" startIcon={<PlusIcon />} onClick={onNew}>
          {t.newSession}
        </Button>
      </Box>

      {sessions.length === 0 && <Typography sx={{ pl: '6px', color: v.on2 }}>{t.noSessions}</Typography>}

      {(Object.keys(TITLES) as Array<keyof typeof TITLES>).map(
        (standing) =>
          by[standing].length > 0 && (
            <Box key={standing} role="group" aria-label={TITLES[standing]} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, pl: '6px' }}>
                <Typography component="h2" sx={{ fontSize: 14, fontWeight: 600 }}>
                  {TITLES[standing]}
                </Typography>
                {/* How many wait for the user, in the color the bell counts them in. */}
                <Typography sx={standing === 'asking' ? { color: v.warn, fontWeight: 600 } : { color: v.on2 }}>{by[standing].length}</Typography>
              </Box>
              <Box sx={gridSx}>{cards(by[standing])}</Box>
            </Box>
          ),
      )}

      {by.ended.length > 0 && (
        <Box role="group" aria-label={t.exited} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <ButtonBase
            onClick={() => setEndedOpen((open) => !open)}
            aria-expanded={endedOpen}
            sx={{ alignSelf: 'flex-start', minHeight: 32, gap: '6px', px: '6px', borderRadius: '6px', color: v.on2, fontSize: 12, transition: `background-color ${motion.fast}`, '&:hover': { bgcolor: v.hover } }}
          >
            <ChevronIcon open={endedOpen} size={14} />
            {t.endedSessions(by.ended.length)}
          </ButtonBase>
          {endedOpen && <Box sx={gridSx}>{cards(by.ended)}</Box>}
        </Box>
      )}
    </Box>
  );
}
