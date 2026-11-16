import { z } from 'zod';

export const LoginBody = z.object({ code: z.string().min(1).max(200) });

export const ChooseCliBody = z.object({ path: z.string().min(1).max(1024).nullable() });

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
});

/** Starting an ended session again takes everything from that session, but the app's theme now. */
export const ResumeBody = z.object({ theme: z.enum(['light', 'dark']).optional() });

// What a browser may ask for; enterOnly and verify are the web server's own (unknown keys are dropped).
export const ComposeBody = z.object({
  text: z.string().min(1).max(200_000),
  enterDelayMs: z.number().int().min(0).max(5000).optional(),
  quietMs: z.number().int().min(0).max(5000).optional(),
});

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

export const TerminalClient = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(1_000_000), binary: z.boolean().optional() }),
  z.object({ type: z.literal('resize'), cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(500) }),
  z.object({ type: z.literal('claim') }),
  z.object({ type: z.literal('theme'), mode: z.enum(['light', 'dark']) }),
]);
