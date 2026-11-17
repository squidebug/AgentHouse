// One page of a run's screenshots, to look at them next to each other: light next to dark, and
// before next to after when the folder of an earlier run is given. The pictures are inside the
// file, so the page is all there is to open or hand on.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const template = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui-page.html');
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MODES = ['light', 'dark', null];

/** A PNG's bytes and the size its header gives, or null for anything else. */
function png(file) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    return null;
  }
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(SIGNATURE)) return null;
  return { bytes, w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
}

/**
 * Writes `index.html` into `out` from the PNGs there: `<scene>-light.png` and `<scene>-dark.png`
 * are one scene, in the order they were taken.
 * - `before`: the folder of an earlier run; a shot of the same name there is the one to compare with.
 * - `since`: leaves out what an earlier run left in `out` (a time in ms).
 * - `labels`: what to call a scene, by its name; `notes`: a line to say about one, under its name.
 * - `scale`: the device pixel ratio the shots were taken at.
 * Returns the page's path.
 */
export function writePage({ out, before = null, since = 0, labels = {}, notes = {}, scale = 1, title = 'AgentHouse 화면' }) {
  if (before !== null && !statSync(before, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`no such folder: ${before}`);
  const images = [];
  const known = new Map();
  // The same picture is kept once: an unchanged shot is told by that, and the page stays smaller.
  const keep = (shot) => {
    const digest = createHash('sha256').update(shot.bytes).digest('hex');
    if (!known.has(digest)) {
      known.set(digest, images.length);
      images.push({ src: `data:image/png;base64,${shot.bytes.toString('base64')}`, w: shot.w, h: shot.h });
    }
    return known.get(digest);
  };
  const taken = readdirSync(out)
    .filter((name) => name.endsWith('.png'))
    .map((name) => ({ name, at: statSync(path.join(out, name)).mtimeMs }))
    // A file system may keep times to the second or two.
    .filter((file) => file.at >= since - 2000)
    .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
  const scenes = new Map();
  for (const { name } of taken) {
    const shot = png(path.join(out, name));
    if (!shot) continue;
    const [, id, mode = null] = /^(.+?)(?:-(light|dark))?\.png$/.exec(name);
    const earlier = before === null ? null : png(path.join(before, name));
    if (!scenes.has(id)) scenes.set(id, { id, label: labels[id] ?? id, note: notes[id] ?? null, shots: [] });
    scenes.get(id).shots.push({ mode, before: earlier && keep(earlier), after: keep(shot) });
  }
  for (const scene of scenes.values()) scene.shots.sort((a, b) => MODES.indexOf(a.mode) - MODES.indexOf(b.mode));
  const data = { title, made: new Date().toISOString(), before: before !== null, scale, scenes: [...scenes.values()], images };
  // Nothing in the data may end the script element it sits in.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const file = path.join(out, 'index.html');
  writeFileSync(file, readFileSync(template, 'utf8').replace('__DATA__', () => json));
  return file;
}
