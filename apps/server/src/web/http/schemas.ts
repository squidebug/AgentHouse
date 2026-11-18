// What the web server takes from a request: the bodies of the API, the address
// of a sub-agent, and the messages of a terminal socket.
import { z } from 'zod';
import type { ChooseCliRequest, ComposeRequest, ExternalRequest, LaunchOptions, LoginRequest, TerminalClientMessage } from '@agenthouse/protocol';
import { AGENT_ID } from '../../claude/agents';

/**
 * The fields of a request's schema, held to the type the browser sends it as
 * (packages/protocol): a schema for every field of that type, and for nothing
 * else. zod drops the fields a schema does not name, so one added to the type
 * alone would be lost here without a word; now it does not compile.
 */
type Fields<T> = { [K in keyof T]-?: z.ZodType<T[K]> };

export const LoginBody = z.object({ code: z.string().min(1).max(200) } satisfies Fields<LoginRequest>);

export const ChooseCliBody = z.object({ path: z.string().min(1).max(1024).nullable() } satisfies Fields<ChooseCliRequest>);

/** Watching the sessions started outside AgentHouse, on or off. */
export const ExternalBody = z.object({ on: z.boolean() } satisfies Fields<ExternalRequest>);

export const LaunchBody = z.object({
  vendor: z.enum(['claude', 'codex', 'fake']),
  title: z.string().max(80).optional(),
  cwd: z.string().max(1024).optional(),
  model: z.string().max(80).optional(),
  effort: z.string().max(20).optional(),
  permissionMode: z.string().max(40).optional(),
  cols: z.number().int().min(20).max(500).optional(),
  rows: z.number().int().min(5).max(200).optional(),
  theme: z.enum(['light', 'dark']).optional(),
} satisfies Fields<LaunchOptions>);

/** Starting an ended session again takes everything from that session, but the app's theme now. */
export const ResumeBody = z.object({ theme: z.enum(['light', 'dark']).optional() } satisfies Fields<Pick<LaunchOptions, 'theme'>>);

// What a browser may ask for; enterOnly and verify are the web server's own (unknown keys are dropped).
export const ComposeBody = z.object({
  text: z.string().min(1).max(200_000),
  enterDelayMs: z.number().int().min(0).max(5000).optional(),
  quietMs: z.number().int().min(0).max(5000).optional(),
} satisfies Fields<Omit<ComposeRequest, 'enterOnly' | 'verify'>>);

export const LinkBody = z.object({
  parentId: z.string().min(1).max(64).nullable(),
  kind: z.enum(['group', 'delegate']).optional(),
});

export const DelegateBody = z.object({
  childId: z.string().min(1).max(64),
  text: z.string().min(1).max(200_000),
});

export const DeliverBody = z.object({
  /** One line in front of the answer, in the browser's words. */
  header: z.string().min(1).max(200).regex(/^[^\r\n]*$/),
});

/** A note saved from the page: its text, and the version of the file it was loaded as. */
export const NoteBody = z.object({
  text: z.string().max(600_000),
  version: z.string().min(1).max(64),
});

/**
 * The sub-agent an address asks about (`?agent=`): its id as Claude writes it,
 * null without one, undefined for anything else, which names no transcript.
 */
export function agentParam(url: URL): string | null | undefined {
  const value = url.searchParams.get('agent');
  if (value === null) return null;
  return AGENT_ID.test(value) ? value : undefined;
}

// Each message of the protocol as the host may get it: what parses here is passed on, anything else is dropped.
export const TerminalClient = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(1_000_000), binary: z.boolean().optional() }),
  z.object({ type: z.literal('resize'), cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(500) }),
  z.object({ type: z.literal('claim') }),
  z.object({ type: z.literal('theme'), mode: z.enum(['light', 'dark']) }),
]) satisfies z.ZodType<TerminalClientMessage>;
