import { Box, Button, ButtonBase, CircularProgress, IconButton, Menu, MenuItem, Tooltip, Typography } from '@mui/material';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { ConversationEntry, ConversationTurn, DelegationInfo, EntryDetail, ToolState } from '@agenthouse/protocol';
import { api } from '../api/client';
import { useConversation } from '../api/conversation';
import { t } from '../strings';
import { FONT_MONO } from '../theme/theme';
import { motion, v } from '../theme/tokens';
import { arrange, compactCount, delegationTurns, duration, modelName, summarize, type TurnView, type WorkEntry } from '../workspace/conversation';
import { BranchIcon, ChatIcon, ChevronIcon, DelegateIcon, ReturnIcon } from './icons';
import { MarkdownText } from './Markdown';

// The newest turns first; older ones a page at a time.
const PAGE = 20;
// Within this of the bottom, new output keeps the view at the bottom.
const STICK_PX = 80;

const STATE_COLOR: Record<ToolState, string> = { running: v.primary, done: v.on2, error: v.error, denied: v.error, interrupted: v.warn };

// Under the pointer: the hover veil, fading in, as everywhere else.
const hoverSx = { transition: `background-color ${motion.fast}`, '&:hover': { bgcolor: v.hover } } as const;
// A row that opens on a click. These have no ripple, which keeps a long conversation quiet: pressed, they take the stronger veil.
const rowSx = { ...hoverSx, '&:active': { bgcolor: v.press } } as const;

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

/**
 * What the user had in front of them in a conversation: how far back it shows,
 * where it was scrolled to and what was opened. A pane draws one view at a
 * time, so switching to the terminal and back makes this view anew; without
 * this it would come back at the bottom with everything folded.
 */
interface ViewMemory {
  shown: number;
  /** Distance from the end of the page to the top of the view; null while it follows the newest turn. */
  fromBottom: number | null;
  open: Set<string>;
}

// For as long as the page lives; a reload starts every conversation at its end.
const memories = new Map<string, ViewMemory>();
const MAX_MEMORIES = 50;

function memoryOf(sessionId: string, agentId: string | null): ViewMemory {
  const key = `${sessionId}\n${agentId ?? ''}`;
  let memory = memories.get(key);
  if (!memory) {
    memory = { shown: PAGE, fromBottom: null, open: new Set() };
    memories.set(key, memory);
    if (memories.size > MAX_MEMORIES) memories.delete(memories.keys().next().value!);
  }
  return memory;
}

/** Whether a part of the conversation is opened, remembered with the conversation. */
function useOpen(source: ConversationSource, id: string): [boolean, (open: boolean) => void] {
  const { memory } = source;
  const [open, setOpen] = useState(() => memory.open.has(id));
  const set = (next: boolean) => {
    if (next) memory.open.add(id);
    else memory.open.delete(id);
    setOpen(next);
  };
  return [open, set];
}

/** A session delegated under the one whose conversation this is: an answer can be handed to it. */
export interface DelegateTarget {
  id: string;
  title: string;
}

/** Whose conversation it is: a session's, or one of its sub-agents'. */
export interface ConversationSource {
  sessionId: string;
  agentId: string | null;
  memory: ViewMemory;
  /** Opens a sub-agent's own conversation, from its block. */
  onOpenAgent?: ((agentId: string) => void) | undefined;
  delegates?: DelegateTarget[] | undefined;
  onDelegate?: ((childId: string, text: string) => void) | undefined;
  /** Starts dragging a piece of the conversation (to a delegate's chip or pane). */
  onDragText?: ((entryId: string, text: string) => (event: DragEvent) => void) | undefined;
}

/**
 * An answer of the model. With sessions delegated under this one it has a
 * handle: dragged to one of them, or clicked for a menu, it hands the answer
 * over. Only the handle drags, so the text can still be selected and copied.
 */
function AnswerText({ entry, source }: { entry: Extract<ConversationEntry, { kind: 'text' }>; source: ConversationSource }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const delegates = source.delegates ?? [];
  if (!delegates.length || !source.onDelegate) {
    return (
      <Box>
        <MarkdownText text={entry.text} />
        {entry.truncated && <Partial />}
      </Box>
    );
  }
  return (
    <Box
      className="ah-answer"
      sx={{ position: 'relative', m: '-4px -6px', p: '4px 34px 4px 6px', borderRadius: '8px', ...hoverSx, '&:hover .ah-hand': { opacity: 1 } }}
    >
      <MarkdownText text={entry.text} />
      {entry.truncated && <Partial />}
      <Tooltip title={t.delegateAction}>
        <IconButton
          className="ah-hand"
          aria-label={t.delegateAction}
          aria-haspopup="menu"
          draggable={Boolean(source.onDragText)}
          onDragStart={source.onDragText?.(entry.id, entry.text)}
          onClick={(event) => setAnchor(event.currentTarget)}
          sx={{ position: 'absolute', top: 2, right: 2, width: 28, height: 28, color: v.primary, cursor: 'grab', opacity: anchor ? 1 : 0, '&:focus-visible': { opacity: 1 } }}
        >
          <DelegateIcon size={15} />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)} slotProps={{ list: { 'aria-label': t.delegateTo } }}>
        {delegates.map((child) => (
          <MenuItem
            key={child.id}
            onClick={() => {
              setAnchor(null);
              source.onDelegate?.(child.id, entry.text);
            }}
            sx={{ fontSize: 13 }}
          >
            {child.title}
          </MenuItem>
        ))}
      </Menu>
    </Box>
  );
}

/** Work handed to a delegate: in progress, then its answer with the button that hands it to this session. */
function DelegationCard({ task, title, onDeliver }: { task: DelegationInfo; title: string; onDeliver?: ((task: DelegationInfo) => void) | undefined }) {
  if (task.status === 'running') {
    return (
      <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: '8px', p: '8px 10px', borderRadius: '10px', bgcolor: v.surface2, fontSize: 12, lineHeight: '16px' }}>
        <DelegateIcon size={14} style={{ flex: 'none', color: v.primary }} />
        <Box component="span" sx={{ fontWeight: 500 }}>
          {title}
        </Box>
        <Box component="span" sx={{ color: v.on2 }}>
          {t.delegation.running}
        </Box>
      </Box>
    );
  }
  const canDeliver = Boolean(task.summary) && (task.delivery === 'none' || task.delivery === 'failed') && onDeliver;
  return (
    <Box role="group" aria-label={`${t.delegate} · ${title}`} sx={{ display: 'flex', alignItems: 'center', gap: '10px', p: '10px 12px', borderRadius: '12px', bgcolor: v.primaryContainer, color: v.onPrimaryContainer }}>
      <ReturnIcon size={16} style={{ flex: 'none' }} />
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <Box component="span" sx={{ fontWeight: 600 }}>
          {title}
        </Box>
        <Box component="span" sx={{ fontSize: 12, lineHeight: '16px', overflowWrap: 'anywhere' }}>
          {task.status === 'done' && task.summary ? task.summary : [t.delegation[task.status], task.summary].filter(Boolean).join(' · ')}
        </Box>
      </Box>
      {task.delivery === 'failed' && <Box component="span" sx={{ flex: 'none', fontSize: 12 }}>{t.delivery.failed}</Box>}
      {canDeliver ? (
        <Button
          variant="contained"
          onClick={() => onDeliver?.(task)}
          sx={{ flex: 'none', height: 32, px: 1.75, borderRadius: '999px', fontSize: 12, fontWeight: 500, bgcolor: v.primary, color: v.onPrimary }}
        >
          {t.deliver}
        </Button>
      ) : (
        task.delivery !== 'none' && task.delivery !== 'failed' && <Box component="span" sx={{ flex: 'none', fontSize: 12 }}>{t.delivery[task.delivery]}</Box>
      )}
    </Box>
  );
}

/** The full content of an entry, loaded the first time it is opened (again if its state changed). */
function useDetail(source: ConversationSource, entry: ConversationEntry, open: boolean): { detail: EntryDetail | null; failed: boolean } {
  const { sessionId, agentId } = source;
  const [loaded, setLoaded] = useState<{ key: string; detail: EntryDetail | null; failed: boolean } | null>(null);
  const key = `${entry.id}:${'state' in entry ? entry.state : ''}`;
  useEffect(() => {
    if (!open || loaded?.key === key) return;
    let current = true;
    api
      .entry(sessionId, entry.id, agentId)
      .then((detail) => current && setLoaded({ key, detail, failed: false }))
      .catch(() => current && setLoaded({ key, detail: null, failed: true }));
    return () => {
      current = false;
    };
  }, [open, key, sessionId, agentId, entry.id, loaded?.key]);
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
function WorkItem({ entry, source }: { entry: WorkEntry; source: ConversationSource }) {
  const [open, setOpen] = useOpen(source, entry.id);
  const { detail, failed } = useDetail(source, entry, open);
  const label = entry.kind === 'tool' ? entry.name : t.thinking;
  const summary = entry.kind === 'tool' ? entry.summary : entry.chars ? t.chars(compactCount(entry.chars)) : '';
  return (
    <Box>
      <ButtonBase
        disableRipple
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        sx={{ width: '100%', justifyContent: 'flex-start', gap: '8px', minHeight: 26, px: '4px', borderRadius: '6px', textAlign: 'left', ...rowSx }}
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
function WorkRow({ entries, source }: { entries: WorkEntry[]; source: ConversationSource }) {
  const [open, setOpen] = useOpen(source, `work:${entries[0]?.id}`);
  const summary = summarize(entries);
  const lastTool = [...entries].reverse().find((e): e is Extract<WorkEntry, { kind: 'tool' }> => e.kind === 'tool');
  const counts = [summary.tools ? t.tools(summary.tools) : '', summary.thinking ? t.thoughts(summary.thinking) : ''].filter(Boolean).join(' · ');
  return (
    <Box>
      <ButtonBase
        disableRipple
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        sx={{ width: '100%', justifyContent: 'flex-start', gap: '8px', minHeight: 28, px: '4px', borderRadius: '8px', textAlign: 'left', color: v.on2, ...rowSx }}
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
            <WorkItem key={entry.id} entry={entry} source={source} />
          ))}
        </Box>
      )}
    </Box>
  );
}

function Prompt({ entry, source }: { entry: Extract<ConversationEntry, { kind: 'prompt' }>; source: ConversationSource }) {
  const [full, setFull] = useOpen(source, `full:${entry.id}`);
  const { detail } = useDetail(source, entry, full);
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

function Notice({ entry, source }: { entry: Extract<ConversationEntry, { kind: 'notice' }>; source: ConversationSource }) {
  const [open, setOpen] = useOpen(source, entry.id);
  const { detail } = useDetail(source, entry, open);
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

/** A sub-agent the model started: opened, what it reported; its own conversation is a click away. */
function Agent({ entry, source }: { entry: Extract<ConversationEntry, { kind: 'agent' }>; source: ConversationSource }) {
  const [open, setOpen] = useOpen(source, entry.id);
  const { detail, failed } = useDetail(source, entry, open);
  const { onOpenAgent } = source;
  return (
    <Box sx={{ position: 'relative', border: `1px solid ${v.outline}`, borderRadius: '12px', overflow: 'hidden' }}>
      {entry.agentId && onOpenAgent && (
        <Tooltip title={t.openConversation}>
          <IconButton
            aria-label={`${entry.description} ${t.openConversation}`}
            onClick={() => onOpenAgent(entry.agentId!)}
            sx={{ position: 'absolute', top: 2, right: 34, width: 32, height: 32, color: v.on2 }}
          >
            <ChatIcon size={15} />
          </IconButton>
        </Tooltip>
      )}
      <ButtonBase
        disableRipple
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        sx={{ width: '100%', justifyContent: 'flex-start', gap: '8px', p: '8px 12px', pr: entry.agentId && onOpenAgent ? '72px' : '36px', textAlign: 'left', ...rowSx }}
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
        <Box component="span" sx={{ position: 'absolute', right: 12, top: 10, display: 'inline-flex', color: v.on2 }}>
          <ChevronIcon open={open} size={14} />
        </Box>
      </ButtonBase>
      {open && <Box sx={{ p: '0 12px 10px 12px' }}>{detail ? detail.text ? <MarkdownText text={detail.text} /> : null : failed ? null : <Loading />}</Box>}
    </Box>
  );
}

/** A background agent reported back; its report opens below. */
function Task({ entry, source }: { entry: Extract<ConversationEntry, { kind: 'task' }>; source: ConversationSource }) {
  const [open, setOpen] = useOpen(source, entry.id);
  const { detail, failed } = useDetail(source, entry, open);
  const facts = [entry.tokens ? `${t.tokens} ${compactCount(entry.tokens)}` : null, entry.durationMs ? duration(entry.durationMs) : null].filter(Boolean).join(' · ');
  return (
    <Box>
      <ButtonBase
        disableRipple
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        sx={{ width: '100%', justifyContent: 'flex-start', gap: '8px', minHeight: 28, px: '4px', borderRadius: '8px', textAlign: 'left', color: v.on2, ...rowSx }}
      >
        <StateDot state={entry.state} />
        <BranchIcon size={14} style={{ flex: 'none' }} />
        <Box component="span" sx={{ flex: 'none', fontSize: 12, fontWeight: 600, color: entry.state === 'done' ? v.on : STATE_COLOR[entry.state] }}>
          {t.report[entry.state] ?? t.report.done}
        </Box>
        <Box component="span" sx={{ minWidth: 0, flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {[entry.description, facts].filter(Boolean).join(' · ')}
        </Box>
        <ChevronIcon open={open} size={14} />
      </ButtonBase>
      {open && <Box sx={{ p: '2px 4px 6px 26px' }}>{detail ? detail.text ? <MarkdownText text={detail.text} /> : null : failed ? null : <Loading />}</Box>}
    </Box>
  );
}

function EntryView({ entry, source }: { entry: ConversationEntry; source: ConversationSource }) {
  switch (entry.kind) {
    case 'prompt':
      return <Prompt entry={entry} source={source} />;
    case 'text':
      return <AnswerText entry={entry} source={source} />;
    case 'notice':
      return <Notice entry={entry} source={source} />;
    case 'command':
      return <Command entry={entry} />;
    case 'agent':
      return <Agent entry={entry} source={source} />;
    case 'task':
      return <Task entry={entry} source={source} />;
    default:
      return null;
  }
}

/** The model and tokens of a turn; the breakdown behind a click. */
function TurnFooter({ turn, source }: { turn: ConversationTurn; source: ConversationSource }) {
  const [open, setOpen] = useOpen(source, `turn:${turn.index}`);
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
      sx={{ alignSelf: 'flex-start', flexWrap: 'wrap', gap: '2px 0', px: '4px', borderRadius: '6px', fontSize: 12, lineHeight: '18px', color: v.on2, textAlign: 'left', ...rowSx }}
    >
      {[...main, ...(open ? more : [])].filter(Boolean).join(' · ')}
    </ButtonBase>
  );
}

function Turn({ view, source, cards }: { view: TurnView; source: ConversationSource; cards?: React.ReactNode }) {
  return (
    // A turn stands 16px from the line between it and the next: twice the distance between its own parts.
    <Box component="article" aria-label={t.turn(view.turn.index + 1)} sx={{ display: 'flex', flexDirection: 'column', gap: '8px', py: '16px', '& + &': { borderTop: `1px solid ${v.outline}` } }}>
      {view.blocks.map((block) =>
        block.kind === 'work' ? <WorkRow key={block.id} entries={block.entries} source={source} /> : <EntryView key={block.entry.id} entry={block.entry} source={source} />,
      )}
      <TurnFooter turn={view.turn} source={source} />
      {cards}
    </Box>
  );
}

/** What the session delegated, shown after the turn it came from. */
export interface DelegationView {
  tasks: DelegationInfo[];
  titleOf: (sessionId: string) => string;
  onDeliver?: ((task: DelegationInfo) => void) | undefined;
}

/**
 * A session's conversation, read-only, from its transcript: the newest turns,
 * following as they happen. Drawn again only when the conversation or what it
 * was given changes, not with every status a session reports (its pane is).
 */
export const ConversationView = memo(function ConversationView({
  sessionId,
  agentId = null,
  onOpenAgent,
  delegates,
  onDelegate,
  onDragText,
  delegations,
}: {
  sessionId: string;
  agentId?: string | null;
  onOpenAgent?: (agentId: string) => void;
  delegates?: DelegateTarget[];
  onDelegate?: (childId: string, text: string) => void;
  onDragText?: (entryId: string, text: string) => (event: DragEvent) => void;
  delegations?: DelegationView;
}) {
  const conversation = useConversation(sessionId, agentId);
  const source = useMemo<ConversationSource>(
    () => ({ sessionId, agentId, memory: memoryOf(sessionId, agentId), onOpenAgent, delegates, onDelegate, onDragText }),
    [sessionId, agentId, onOpenAgent, delegates, onDelegate, onDragText],
  );
  const turns = useMemo(() => arrange(conversation.turns, conversation.entries), [conversation]);
  const placed = useMemo(() => delegationTurns(conversation.turns, delegations?.tasks ?? []), [conversation.turns, delegations?.tasks]);
  const cardsAfter = (index: number) =>
    placed.get(index)?.map((task) => <DelegationCard key={task.id} task={task} title={delegations!.titleOf(task.childId)} onDeliver={delegations!.onDeliver} />);
  const { memory } = source;
  const [shown, setShown] = useState(memory.shown);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(memory.fromBottom === null);
  // Put back where the user was reading, once, when the conversation arrives.
  const restored = useRef(false);
  // Showing older turns grows the page above the view: keep what is on screen in place.
  const fromBottom = useRef<number | null>(null);

  useEffect(() => {
    // Another conversation in the same pane: as it was left.
    setShown(memory.shown);
    stick.current = memory.fromBottom === null;
    restored.current = false;
  }, [sessionId, agentId]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (conversation.ready && !restored.current) {
      restored.current = true;
      if (memory.fromBottom !== null) {
        element.scrollTop = element.scrollHeight - memory.fromBottom;
        return;
      }
    }
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
        if (!element) return;
        stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX;
        // Not before the conversation is back: the empty view's own scroll event would overwrite the place.
        if (restored.current) memory.fromBottom = stick.current ? null : element.scrollHeight - element.scrollTop;
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
            memory.shown = shown + PAGE;
            setShown(shown + PAGE);
          }}
          sx={{ mt: '4px', fontSize: 12 }}
        >
          {t.earlierTurns(hidden)}
        </Button>
      )}
      {turns.slice(hidden).map((view) => (
        <Turn key={view.turn.index} view={view} source={source} cards={cardsAfter(view.turn.index)} />
      ))}
      {placed.has(-1) && <Box sx={{ display: 'flex', flexDirection: 'column', gap: '8px', py: '16px' }}>{cardsAfter(-1)}</Box>}
    </Box>
  );
});
