import { motion, v } from '../theme/tokens';

/**
 * A key: what can be pressed in a tray (the opened details of a row), on the
 * page (the foot of the tree) or among plain names (a skill that can be
 * edited), standing out with a face and a shadow of its own, and a step up
 * under the pointer. Text alone, next to facts that are text too, does not
 * read as something to press.
 */
export const keySx = {
  color: v.on,
  bgcolor: v.thumb,
  boxShadow: v.shadow1,
  transition: `box-shadow ${motion.fast}`,
  '&:hover': { bgcolor: v.thumb, boxShadow: v.shadow2 },
} as const;