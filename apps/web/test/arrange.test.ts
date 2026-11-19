import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrange, dragged, GAP_PX, halves, MIN_HEIGHT_PX, MIN_WIDTH_PX, pixels, shared, type Box } from '../src/workspace/arrange';
import type { Layout } from '../src/workspace/state';

const GAP = 12;
const stack = (id: string): Layout => ({ type: 'stack', id });
const split = (id: string, dir: 'row' | 'column', sizes: number[], ...children: Layout[]): Layout => ({ type: 'split', id, dir, children, sizes });
const near = (px: number) => Math.round(px * 100) / 100;
/** A box on a workspace that wide and high, in pixels: left, top, width, height. */
const on = (box: Box, width: number, height: number) => [pixels(box.left, width), pixels(box.top, height), pixels(box.width, width), pixels(box.height, height)].map(near);

test('one stack has the whole workspace; no layout, nothing', () => {
  assert.deepEqual(arrange(null, GAP), { stacks: [], dividers: [] });
  const { stacks, dividers } = arrange(stack('s1'), GAP);
  assert.deepEqual(stacks.map(({ id, box }) => [id, on(box, 1000, 700)]), [['s1', [0, 0, 1000, 700]]]);
  assert.deepEqual(dividers, []);
});

test('the parts of a split share its room without the room between them, whatever the size of the workspace', () => {
  const layout = split('x1', 'row', [0.6, 0.4], stack('s1'), split('x2', 'column', [0.5, 0.5], stack('s2'), stack('s3')));
  const { stacks, dividers } = arrange(layout, GAP);
  assert.deepEqual(stacks.map(({ id }) => id), ['s1', 's2', 's3'], 'in the order they are read');
  // 1000 wide: 988 to share side by side; 700 high: 688 to share one above the other.
  assert.deepEqual(stacks.map(({ box }) => on(box, 1000, 700)), [[0, 0, 592.8, 700], [604.8, 0, 395.2, 344], [604.8, 356, 395.2, 344]]);
  assert.deepEqual(dividers.map((divider) => [divider.split.id, divider.index, on(divider.box, 1000, 700)]), [['x1', 0, [592.8, 0, 12, 700]], ['x2', 0, [604.8, 344, 395.2, 12]]], 'a divider lies in the room between its two parts');
  assert.deepEqual(stacks.map(({ box }) => on(box, 512, 412)), [[0, 0, 300, 412], [312, 0, 200, 200], [312, 212, 200, 200]], 'the same shares of another size');

  const three = arrange(split('x1', 'row', [0.5, 0.25, 0.25], stack('s1'), stack('s2'), stack('s3')), GAP);
  assert.deepEqual(three.stacks.map(({ box }) => on(box, 1024, 600)), [[0, 0, 500, 600], [512, 0, 250, 600], [774, 0, 250, 600]]);
  assert.deepEqual(three.dividers.map(({ index, box }) => [index, on(box, 1024, 600)]), [[0, [500, 0, 12, 600]], [1, [762, 0, 12, 600]]]);
});

test('a divider held somewhere gives one of its two parts what it takes from the other, and leaves neither too small', () => {
  const shares = (sizes: number[] | null) => sizes?.map((size) => Math.round(size * 1000) / 1000);
  const two = arrange(split('x1', 'row', [0.5, 0.5], stack('s1'), stack('s2')), GAP).dividers[0]!;
  // 1012 wide: 1000 to share. The pointer holds the middle of the divider.
  assert.deepEqual(shares(dragged(two, 706, 1012, GAP, 280)), [0.7, 0.3]);
  assert.deepEqual(shares(dragged(two, 990, 1012, GAP, 280)), [0.72, 0.28], 'no narrower than a stack may be');
  assert.deepEqual(shares(dragged(two, -50, 1012, GAP, 280)), [0.28, 0.72]);
  assert.deepEqual(shares(dragged(two, 206, 412, GAP, 280)), [0.5, 0.5], 'two that are already smaller than that share evenly at most');
  assert.equal(dragged(two, 5, 10, GAP, 280), null, 'no room to share');

  // Only the two parts next to it change; a split inside another is measured from where it starts.
  const [outer, inner] = arrange(split('x1', 'row', [0.25, 0.25, 0.5], stack('s1'), stack('s2'), split('x2', 'column', [0.5, 0.5], stack('s3'), stack('s4'))), GAP).dividers.filter((divider) => divider.index === 1 || divider.split.id === 'x2');
  assert.deepEqual([outer!.split.id, outer!.index, inner!.split.id], ['x1', 1, 'x2']);
  // 2024 wide: 2000 to share; the second part starts at 512 and its divider is held at 1118, 600 into it.
  assert.deepEqual(shares(dragged(outer!, 1118, 2024, GAP, 280)), [0.25, 0.3, 0.45]);
  // 712 high: 700 to share; held 216 down.
  assert.deepEqual(shares(dragged(inner!, 216, 712, GAP, 180)), [0.3, 0.7]);
});

test('a stack gives half of its room to another only while both halves are large enough to be stacks', () => {
  const wide = 2 * MIN_WIDTH_PX + GAP_PX;
  const high = 2 * MIN_HEIGHT_PX + GAP_PX;
  assert.deepEqual([halves('left', wide, 50), halves('right', wide, 50), halves('left', wide - 1, 2000)], [true, true, false], 'side by side: by its width alone');
  assert.deepEqual([halves('top', 50, high), halves('bottom', 50, high), halves('bottom', 2000, high - 1)], [true, true, false], 'one above the other: by its height alone');
});

test('a share given by the keyboard or a double click stays within what the two parts have', () => {
  const shares = (sizes: number[]) => sizes.map((size) => Math.round(size * 1000) / 1000);
  const sizes = [0.5, 0.25, 0.25];
  assert.deepEqual(shares(shared(sizes, 1, 0.27, 0.1)), [0.5, 0.27, 0.23]);
  assert.deepEqual(shares(shared(sizes, 1, 0.49, 0.1)), [0.5, 0.4, 0.1], 'a tenth of the split is left to the other');
  assert.deepEqual(shares(shared(sizes, 0, 0.375)), [0.375, 0.375, 0.25], 'evenly: half of what the two have');
  assert.deepEqual(shares(shared([0.9, 0.05, 0.05], 1, 0.09, 0.1)), [0.9, 0.05, 0.05], 'two parts under a tenth each stay even');
});
