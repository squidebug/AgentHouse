import { Box, Button, ButtonBase, CircularProgress, Typography } from '@mui/material';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ConversationEntry, ConversationTurn, EntryDetail, ToolState } from '@agenthouse/protocol';
import { api } from '../api/client';
import { useConversation } from '../api/conversation';
import { t } from '../strings';
import { FONT_MONO } from '../theme/theme';
import { v } from '../theme/tokens';
import { arrange, compactCount, duration, modelName, summarize, type TurnView, type WorkEntry } from '../workspace/conversation';
import { BranchIcon, ChevronIcon } from './icons';
import { MarkdownText } from './Markdown';

// The newest turns first; older ones a page at a time.
const PAGE = 20;
// Within this of the bottom, new output keeps the view at the bottom.
const STICK_PX = 80;

const STATE_COLOR: Record<ToolState, string> = { running: v.primary, done: v.on2, error: v.error, denied: v.error, interrupted: v.warn };

const preSx = {
  m: 0,
  p: '8px 10px',
  maxHeight: 320,
  overflow: 'auto',
  borderRadius: '8px',
  bgcolor: v.surface2,
  fontFamily: FONT_MONO,
  fontSize: 12,
  lineHeight: '18px',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
} as const;

/** The full content of an entry, loaded the first time it is opened (again if its state changed). */
function useDetail(sessionId: string, entry: ConversationEntry, open: boolean): { detail: EntryDetail | null; failed: boolean } {
  const [loaded, setLoaded] = useState<{ key: string; detail: EntryDetail | null; failed: boolean } | null>(null);
  const key = `${entry.id}:${'state' in entry ? entry.state : ''}`;
  useEffect(() => {
    if (!open || loaded?.key === key) return;
    let current = true;
    api
      .entry(sessionId, entry.id)
      .then((detail) => current && setLoaded({ key, detail, failed: false }))
      .catch(() => current && setLoaded({ key, detail: null, failed: true }));
    return () => {
      current = false;
    };
  }, [open, key, sessionId, entry.id, loaded?.key]);
  return loaded?.key === key ? loaded : { detail: null, failed: false };
}

function Loading() {
  return <CircularProgress size={14} sx={{ color: v.on2, m: '4px' }} />;
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <Box component="pre" sx={preSx}>
      {children}
    </Box>
  );
}

function Partial() {
  return <Typography sx={{ fontSize: 12, color: v.on2 }}>{t.partial}</Typography>;
}

function Diff({ patch }: { patch: NonNullable<EntryDetail['patch']> }) {
  return (
    <Box component="pre" sx={preSx}>
      {patch.map((hunk, i) => (
        <Box key={i} component="span" sx={{ display: 'block' }}>
          <Box component="span" sx={{ display: 'block', color: v.on2 }}>{`@@ -${hunk.oldStart} +${hunk.newStart} @@`}</Box>
          {hunk.lines.map((line, j) => (
            <Box key={j} component="span" sx={{ display: 'block', color: line.startsWith('+') ? v.done : line.startsWith('-') ? v.error : 'inherit' }}>
              {line || ' '}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

function field(input: unknown, key: string): string | null {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' ? value : null;
}

/** A tool call opened: what went in (as the tool reads it) and what came back. */
function ToolDetail({ name, detail }: { name: string; detail: EntryDetail }) {
  const command = field(detail.input, 'command');
  const written = field(detail.input, 'content');
  let input: React.ReactNode = null;
  if ((name === 'Bash' || name === 'PowerShell') && command !== null) input = <Pre>{`$ ${command}`}</Pre>;
  else if (detail.patch) input = <Diff patch={detail.patch} />;
  else if (name === 'Write' && written !== null) input = <Pre>{written}</Pre>;
  else if (name !== 'Read' && detail.input && Object.keys(detail.input as object).length) input = <Pre>{JSON.stringify(detail.input, null, 2)}</Pre>;
  const showOutput = detail.text && !(detail.patch && name !== 'Bash');
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '6px', p: '2px 0 6px 18px' }}>
      {input}
      {showOutput && <Pre>{detail.text}</Pre>}
      {detail.truncated && <Partial />}
    </Box>
  );
}

function StateDot({ state }: { state: ToolState }) {
  return (
    <Box
      component="span"
      aria-label={t.toolState[state]}
      className={state === 'running' ? 'ah-working' : undefined}
      sx={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', bgcolor: STATE_COLOR[state], opacity: state === 'done' ? 0.6 : 1 }}
    />
  );
}

/** One tool call or one thought in an opened work row. */
function WorkItem({ entry, sessionId }: { entry: WorkEntry; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const { detail, failed } = useDetail(sessionId, entry, open);
  const label = entry.kind === 'tool' ? entry.name : t.thinking;
  const summary = entry.kind === 'tool' ? entry.summary : entry.chars ? t.chars(compactCount(entry.chars)) : '';
  return (
    <Box>
      <ButtonBase
        disableRipple
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        sx={{ width: '100%', justifyContent: 'flex-start', gap: '8px', minHeight: 26, px: '4px', borderRadius: '6px', textAlign: 'left', '&:hover': { bgcolor: v.surface2 } }}
      >
        {entry.kind === 'tool' ? <StateDot state={entry.state} /> : <Box component="span" sx={{ flex: 'none', width: 7 }} />}
        <Box component="span" sx={{ flex: 'none', fontFamily: FONT_MONO, fontSize: 12, fontWeight: 500, color: entry.kind === 'tool' ? v.on : v.on2 }}>
          {label}
        </Box>
        <Box component="span" sx={{ minWidth: 0, flex: 1, fontFamily: FONT_MONO, fontSize: 12, color: v.on2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summary}
        </Box>
        {entry.kind === 'tool' && entry.state !== 'done' && entry.state !== 'running' && (
          <Box component="span" sx={{ flex: 'none', fontSize: 12, color: STATE_COLOR[entry.state] }}>
            {t.toolState[entry.state]}
          </Box>
        )}
      </ButtonBase>
      {open &&
        (detail ? (
          entry.kind === 'tool' ? (
            <ToolDetail name={entry.name} detail={detail} />
          ) : (
            <Box sx={{ p: '2px 0 6px 18px' }}>
              <Box component="pre" sx={{ ...preSx, color: v.on2, bgcolor: 'transparent', p: 0, fontFamily: 'inherit', fontSize: 12 }}>
                {detail.text}
              </Box>
            </Box>
          )
        ) : failed ? null : (
          <Loading />
        ))}
    </Box>
  );
}

/** A run of tool calls and thinking: one quiet row until opened. */
function WorkRow({ entries, sessionId }: { entries: WorkEntry[]; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const summary = summarize(entries);
  const lastTool = [...entries].reverse().find((e): e is Extract<WorkEntry, { kind: 'tool' }> => e.kind === 'tool');
  const counts = [summary.tools ? t.tools(summary.tools) : '', summary.thinking ? t.thoughts(summary.thinking) : ''].filter(Boolean).join(' · ');
  return (
    <Box>
      <ButtonBase
        disableRipple
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        sx={{ width: '100%', justifyContent: 'flex-start', gap: '8px', minHeight: 28, px: '4px', borderRadius: '8px', textAlign: 'left', color: v.on2, '&:hover': { bgcolor: v.surface2 } }}
      >
        <ChevronIcon open={open} size={14} />
        <Box component="span" sx={{ flex: 'none', fontSize: 12, fontWeight: 500 }}>
          {counts}
        </Box>
        {summary.failed > 0 && (
          <Box component="span" sx={{ flex: 'none', fontSize: 12, color: v.error }}>
            {t.failedCount(summary.failed)}
          </Box>
        )}
        {!open && lastTool && (
          <Box component="span" sx={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: '6px', fontFamily: FONT_MONO, fontSize: 12, overflow: 'hidden' }}>
            {summary.running > 0 && <StateDot state="running" />}
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{`${lastTool.name} ${lastTool.summary}`}</Box>
          </Box>
        )}
      </ButtonBase>
      {open && (
        <Box sx={{ pl: '14px' }}>
          {entries.map((entry) => (
            <WorkItem key={entry.id} entry={entry} sessionId={sessionId} />
          ))}
        </Box>
      )}
    </Box>
  );
}

function Prompt({ entry, sessionId }: { entry: Extract<ConversationEntry, { kind: 'prompt' }>; sessionId: string }) {
  const [full, setFull] = useState(false);
  const { detail } = useDetail(sessionId, entry, full);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' }}>
      {entry.from && (
        <Typography sx={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: 12, color: v.on2 }}>
          <BranchIcon size={13} />
          {entry.from}
        </Typography>
      )}
      <Box
        sx={{
          maxWidth: '100%',
          p: '8px 12px',
          borderRadius: '12px',
          bgcolor: entry.from ? 'transparent' : v.surface3,
          border: entry.from ? `1px solid ${v.outline}` : 'none',
          fontSize: 13,
          lineHeight: '20px',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
        }}
      >
        {detail?.text ?? entry.text}
        {entry.images > 0 && (
          <Box component="span" sx={{ display: 'block', mt: '4px', fontSize: 12, color: v.on2 }}>
            {t.images(entry.images)}
          </Box>
        )}
      </Box>
      {entry.truncated && !detail && (
        <Button size="small" onClick={() => setFull(true)} sx={{ minHeight: 24, px: 1, fontSize: 12 }}>
          {t.showAll}
        </Button>
      )}
    </Box>
  );
}

function Notice({ entry, sessionId }: { entry: Extract<ConversationEntry, { kind: 'notice' }>; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const { detail } = useDetail(sessionId, entry, open);
  const error = entry.notice === 'api_error';
  const label = error && entry.text ? `${t.notice.api_error} · ${entry.text}` : t.notice[entry.notice];
  const line = <Box component="span" sx={{ flex: 1, height: '1px', bgcolor: v.outline }} />;
  return (
    <Box>
      <ButtonBase
        disableRipple
        disabled={entry.notice !== 'compacted'}
        onClick={() => setOpen(!open)}
        aria-expanded={entry.notice === 'compacted' ? open : undefined}
        sx={{ width: '100%', gap: '10px', py: '2px', fontSize: 12, color: error ? v.error : v.on2 }}
      >
        {line}
        <Box component="span" sx={{ maxWidth: '80%', overflowWrap: 'anywhere' }}>
          {label}
        </Box>
        {line}
      </ButtonBase>
      {open && (detail ? <Pre>{detail.text}</Pre> : <Loading />)}
    </Box>
  );
}

function Command({ entry }: { entry: Extract<ConversationEntry, { kind: 'command' }> }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' }}>
      <Box component="span" sx={{ px: '8px', py: '2px', borderRadius: '6px', bgcolor: v.surface2, fontFamily: FONT_MONO, fontSize: 12 }}>
        {[entry.name, entry.args].filter(Boolean).join(' ')}
      </Box>
      {entry.output && <Box sx={{ fontSize: 12, color: v.on2, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{entry.output}</Box>}
    </Box>
  );
}

/** A sub-agent the model started. Its own steps come with the sub-agent tree (M6); for now, its final report. */
function Agent({ entry, sessionId }: { entry: Extract<ConversationEntry, { kind: 'agent' }>; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const { detail, failed } = useDetail(sessionId, entry, open);
  return (
    <Box sx={{ border: `1px solid ${v.outline}`, borderRadius: '12px', overflow: 'hidden' }}>
      <ButtonBase
        disableRipple
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        sx={{ width: '100%', justifyContent: 'flex-start', gap: '8px', p: '8px 12px', textAlign: 'left', '&:hover': { bgcolor: v.surface2 } }}
      >
        <StateDot state={entry.state} />
        <BranchIcon size={15} style={{ flex: 'none', color: v.on2 }} />
        <Box component="span" sx={{ flex: 'none', fontSize: 12, fontWeight: 600 }}>
          {entry.agentType ?? t.subagent}
        </Box>
        <Box component="span" sx={{ minWidth: 0, flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entry.description}
        </Box>
        {entry.state !== 'done' && (
          <Box component="span" sx={{ flex: 'none', fontSize: 12, color: STATE_COLOR[entry.state] }}>
            {t.toolState[entry.state]}
          </Box>
        )}
        <Box component="span" sx={{ flex: 'none', display: 'inline-flex', color: v.on2 }}>
          <ChevronIcon open={open} size={14} />
        </Box>
      </ButtonBase>
      {open && <Box sx={{ p: '0 12px 10px 12px' }}>{detail ? detail.text ? <MarkdownText text={detail.text} /> : null : failed ? null : <Loading />}</Box>}
    </Box>
  );
}

function EntryView({ entry, sessionId }: { entry: ConversationEntry; sessionId: string }) {
  switch (entry.kind) {
    case 'prompt':
      return <Prompt entry={entry} sessionId={sessionId} />;
    case 'text':
      return (
        <Box>
          <MarkdownText text={entry.text} />
          {entry.truncated && <Partial />}
        </Box>
      );
    case 'notice':
      return <Notice entry={entry} sessionId={sessionId} />;
    case 'command':
      return <Command entry={entry} />;
    case 'agent':
      return <Agent entry={entry} sessionId={sessionId} />;
    default:
      return null;
  }
}

/** The model and tokens of a turn; the breakdown behind a click. */
function TurnFooter({ turn }: { turn: ConversationTurn }) {
  const [open, setOpen] = useState(false);
  const { usage } = turn;
  if (!usage.calls && !turn.model) return null;
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  const main = [turn.model && modelName(turn.model), turn.effort, `${t.input} ${compactCount(input)}`, `${t.output} ${compactCount(usage.output)}`, turn.durationMs ? duration(turn.durationMs) : null];
  const more = [`${t.uncached} ${compactCount(usage.input)}`, `${t.cacheRead} ${compactCount(usage.cacheRead)}`, `${t.cacheWrite} ${compactCount(usage.cacheWrite)}`, `${t.apiCalls} ${usage.calls}`];
  return (
    <ButtonBase
      disableRipple
      onClick={() => setOpen(!open)}
      aria-expanded={open}
      sx={{ alignSelf: 'flex-start', flexWrap: 'wrap', gap: '2px 0', px: '4px', borderRadius: '6px', fontSize: 12, lineHeight: '18px', color: v.on2, textAlign: 'left', '&:hover': { bgcolor: v.surface2 } }}
    >
      {[...main, ...(open ? more : [])].filter(Boolean).join(' · ')}
    </ButtonBase>
  );
}

function Turn({ view, sessionId }: { view: TurnView; sessionId: string }) {
  return (
    <Box component="article" aria-label={t.turn(view.turn.index + 1)} sx={{ display: 'flex', flexDirection: 'column', gap: '8px', py: '12px', '& + &': { borderTop: `1px solid ${v.outline}` } }}>
      {view.blocks.map((block) =>
        block.kind === 'work' ? <WorkRow key={block.id} entries={block.entries} sessionId={sessionId} /> : <EntryView key={block.entry.id} entry={block.entry} sessionId={sessionId} />,
      )}
      <TurnFooter turn={view.turn} />
    </Box>
  );
}

/** A session's conversation, read-only, from its transcript: the newest turns, following as they happen. */
export function ConversationView({ sessionId }: { sessionId: string }) {
  const conversation = useConversation(sessionId);
  const turns = useMemo(() => arrange(conversation.turns, conversation.entries), [conversation]);
  const [shown, setShown] = useState(PAGE);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Showing older turns grows the page above the view: keep what is on screen in place.
  const fromBottom = useRef<number | null>(null);

  useEffect(() => {
    setShown(PAGE);
    stick.current = true;
  }, [sessionId]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (fromBottom.current !== null) {
      element.scrollTop = element.scrollHeight - fromBottom.current;
      fromBottom.current = null;
    } else if (stick.current) element.scrollTop = element.scrollHeight;
  }, [turns, shown]);

  const hidden = Math.max(0, turns.length - shown);
  return (
    <Box
      ref={scroller}
      onScroll={() => {
        const element = scroller.current;
        if (element) stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX;
      }}
      sx={{ height: '100%', overflowY: 'auto', pr: '8px', color: v.on }}
    >
      {!conversation.ready && <Loading />}
      {conversation.ready && !turns.length && <Typography sx={{ p: '4px', color: v.on2 }}>{t.noConversation}</Typography>}
      {hidden > 0 && (
        <Button
          size="small"
          onClick={() => {
            const element = scroller.current;
            if (element) fromBottom.current = element.scrollHeight - element.scrollTop;
            setShown(shown + PAGE);
          }}
          sx={{ mt: '4px', fontSize: 12 }}
        >
          {t.earlierTurns(hidden)}
        </Button>
      )}
      {turns.slice(hidden).map((view) => (
        <Turn key={view.turn.index} view={view} sessionId={sessionId} />
      ))}
    </Box>
  );
}
