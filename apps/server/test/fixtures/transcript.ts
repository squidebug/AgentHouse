// Synthetic Claude Code transcript records, shaped like 2.1.3xx writes them.
// Made-up content only: real transcripts never go into the repository.

export const CWD = process.platform === 'win32' ? 'C:\\work\\shop' : '/work/shop';
let clock = Date.UTC(2026, 10, 11, 5, 0, 0);
let serial = 0;
const next = (prefix: string) => `${prefix}${(serial += 1)}`;
const stamp = () => new Date((clock += 1000)).toISOString();
const common = () => ({ cwd: CWD, sessionId: 'cli-session', version: '2.1.322', userType: 'external', entrypoint: 'cli', isSidechain: false, gitBranch: 'main' });

export interface Usage {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
}

export const usage = (input: number, cacheRead: number, cacheWrite: number, output: number): Usage => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  output_tokens: output,
});

export function prompt(text: string | unknown[], extra: Record<string, unknown> = {}) {
  return { ...common(), type: 'user', message: { role: 'user', content: text }, uuid: next('u'), timestamp: stamp(), origin: { kind: 'human' }, promptId: next('p'), ...extra };
}

/** One assistant record: Claude Code writes each content block of a response as its own record. */
export function assistant(messageId: string, block: Record<string, unknown>, used: Usage = usage(5, 100, 10, 20), extra: Record<string, unknown> = {}) {
  return {
    ...common(),
    type: 'assistant',
    message: { id: messageId, model: 'claude-haiku-5-5', role: 'assistant', type: 'message', content: [block], stop_reason: 'end_turn', usage: used },
    uuid: next('a'),
    timestamp: stamp(),
    effort: 'low',
    requestId: `req-${messageId}`,
    ...extra,
  };
}

export const text = (value: string) => ({ type: 'text', text: value });
export const thinking = (value: string) => ({ type: 'thinking', thinking: value, signature: 'sig' });
export const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input, caller: { type: 'direct' } });

export function toolResult(id: string, content: string, extra: Record<string, unknown> = {}, isError = false) {
  return {
    ...common(),
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
    uuid: next('u'),
    timestamp: stamp(),
    toolUseResult: { stdout: content, stderr: '', interrupted: false },
    ...extra,
  };
}

export const interrupt = (forTool = false) => ({
  ...common(),
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: forTool ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]' }] },
  uuid: next('u'),
  timestamp: stamp(),
});

export const system = (subtype: string, extra: Record<string, unknown> = {}) => ({ ...common(), type: 'system', subtype, uuid: next('s'), timestamp: stamp(), ...extra });

/** Records the conversation view skips: they are large and say nothing to the reader. */
export const noise = () => [
  { type: 'attachment', attachment: { type: 'skill_listing', content: 'x'.repeat(2000) }, uuid: next('n'), timestamp: stamp() },
  { type: 'file-history-snapshot', messageId: next('m'), snapshot: { trackedFileBackups: {} } },
  { type: 'ai-title', aiTitle: 'A title', sessionId: 'cli-session' },
  { type: 'something-new', value: 1 },
  { ...common(), type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat: …</local-command-caveat>' }, uuid: next('u'), timestamp: stamp() },
];

export const jsonl = (records: unknown[]) => records.map((r) => `${JSON.stringify(r)}\n`).join('');
