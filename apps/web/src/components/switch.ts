import { motion, v } from '../theme/tokens';

/** A switch between a few views: the track its sides lie in. */
export const switchTrack = { display: 'inline-flex', p: '2px', borderRadius: '10px', bgcolor: v.surface2 } as const;

/** One side of it: the chosen one stands out of the track. */
export const switchSide = (chosen: boolean) =>
  ({
    borderRadius: '8px',
    color: chosen ? v.on : v.on2,
    bgcolor: chosen ? v.thumb : 'transparent',
    boxShadow: chosen ? v.shadow1 : 'none',
    transition: `background-color ${motion.fast}, box-shadow ${motion.fast}`,
    '&:hover': { bgcolor: chosen ? v.thumb : v.hover },
  }) as const;
