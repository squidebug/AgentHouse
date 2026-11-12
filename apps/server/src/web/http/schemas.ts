import { z } from 'zod';

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

export const ComposeBody = z.object({
  text: z.string().min(1).max(200_000),
  bracketed: z.boolean().optional(),
  enterDelayMs: z.number().int().min(0).max(5000).optional(),
  quietMs: z.number().int().min(0).max(5000).optional(),
  submit: z.boolean().optional(),
});

export const LinkBody = z.object({
  parentId: z.string().min(1).max(64).nullable(),
  kind: z.enum(['group']).optional(),
});

export const TerminalClient = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(1_000_000), binary: z.boolean().optional() }),
  z.object({ type: z.literal('resize'), cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(500) }),
  z.object({ type: z.literal('claim') }),
  z.object({ type: z.literal('theme'), mode: z.enum(['light', 'dark']) }),
]);
