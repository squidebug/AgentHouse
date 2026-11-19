// Where the stacks of a layout lie in the workspace, worked out from the tree
// of splits: each stack as a box, and between two parts of a split the divider
// that shares their room anew. Free of React and the DOM, so it is tested
// directly. The stacks come as one flat list: drawn from it, a stack stays the
// same element however the splits around it change, and its terminal is not
// taken down for it.
import type { Layout, Side } from './state';

// The room between two stacks, which is also what is dragged to share their room anew.
export const GAP_PX = 12;
// No stack is made narrower or lower than this: not by a divider, and not by another put at its side.
// Narrower, the head of a stack has no room left for its name; lower, a terminal shows a few lines.
export const MIN_WIDTH_PX = 240;
export const MIN_HEIGHT_PX = 160;

/** Whether a stack that large can give half of its room to another on that side: neither would be smaller than a stack may be. */
export const halves = (side: Side, width: number, height: number): boolean =>
  side === 'left' || side === 'right' ? (width - GAP_PX) / 2 >= MIN_WIDTH_PX : (height - GAP_PX) / 2 >= MIN_HEIGHT_PX;

/** A length along one side of the workspace: a share of that side, and pixels on top (the room between stacks). */
export interface Span {
  share: number;
  px: number;
}

/** A box of the workspace. */
export interface Box {
  left: Span;
  top: Span;
  width: Span;
  height: Span;
}

export type Split = Extract<Layout, { type: 'split' }>;

/** The room between two parts of a split: the part before it is `index`, the one after it `index + 1`. */
export interface DividerAt {
  split: Split;
  index: number;
  box: Box;
  /** Where the split starts along its direction, and the room its parts share there (the room between them left out). */
  from: Span;
  room: Span;
}

export interface Arrangement {
  /** In reading order. */
  stacks: Array<{ id: string; box: Box }>;
  dividers: DividerAt[];
}

const span = (share: number, px: number): Span => ({ share, px });
const WHOLE: Box = { left: span(0, 0), top: span(0, 0), width: span(1, 0), height: span(1, 0) };

/** A span of a side that long, in pixels. */
export const pixels = (length: Span, side: number) => length.share * side + length.px;

export function arrange(layout: Layout | null, gap: number): Arrangement {
  const stacks: Arrangement['stacks'] = [];
  const dividers: DividerAt[] = [];
  const place = (node: Layout, box: Box): void => {
    if (node.type === 'stack') {
      stacks.push({ id: node.id, box });
      return;
    }
    const row = node.dir === 'row';
    const from = row ? box.left : box.top;
    const all = row ? box.width : box.height;
    const within = (start: Span, length: Span): Box => (row ? { ...box, left: start, width: length } : { ...box, top: start, height: length });
    // What its parts share: its room without the room between them.
    const room = span(all.share, all.px - gap * (node.children.length - 1));
    let before = 0;
    node.children.forEach((child, i) => {
      const size = node.sizes[i] ?? 0;
      const at = (shares: number) => span(from.share + shares * room.share, from.px + shares * room.px + gap * i);
      place(child, within(at(before), span(size * room.share, size * room.px)));
      before += size;
      if (i < node.children.length - 1) dividers.push({ split: node, index: i, box: within(at(before), span(0, gap)), from, room });
    });
  };
  if (layout) place(layout, WHOLE);
  return { stacks, dividers };
}

/**
 * The shares of a split once the divider after its part `index` is held at `at` (pixels from where
 * the workspace starts, along the split's direction, on a side that long): that part and the next
 * share what the two had, neither smaller than `least` pixels unless half of theirs is less. Null
 * while the split has no room to share.
 */
export function dragged(divider: Pick<DividerAt, 'split' | 'index' | 'from' | 'room'>, at: number, side: number, gap: number, least: number): number[] | null {
  const { split, index } = divider;
  const usable = pixels(divider.room, side);
  if (!(usable > 0)) return null;
  const before = split.sizes.slice(0, index).reduce((sum, size) => sum + size, 0);
  const start = pixels(divider.from, side) + before * usable + gap * index;
  // The pointer holds the middle of the divider.
  return shared(split.sizes, index, (at - gap / 2 - start) / usable, least / usable);
}

/** The shares of a split with part `index` given `first` of what it and the next one have, neither less than `least` of the whole (or than half of theirs). */
export function shared(sizes: number[], index: number, first: number, least = 0): number[] {
  const both = (sizes[index] ?? 0) + (sizes[index + 1] ?? 0);
  const floor = Math.min(both / 2, least);
  const kept = Math.min(both - floor, Math.max(floor, first));
  return sizes.map((size, i) => (i === index ? kept : i === index + 1 ? both - kept : size));
}
