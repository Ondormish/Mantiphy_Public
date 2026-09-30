// Copy Settings: which parts of a recipe are offered, picked and pasted.
// Run with `node --test tests/unit`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EDITS, mergeDefaults, COPY_GROUPS, COPY_NEVER, modifiedGroups, pickSettings, applySettings } from '../../frontend/edits.js';

// Every leaf path of a recipe (arrays and their contents count as one value).
const leaves = (o, pre = '') => Object.entries(o).flatMap(([k, v]) =>
  v && typeof v === 'object' && !Array.isArray(v) ? leaves(v, pre + k + '.') : [pre + k]);

test('every setting of the recipe belongs to exactly one copy group', () => {
  const owned = COPY_GROUPS.flatMap(g => g.paths);
  for (const leaf of leaves(DEFAULT_EDITS())) {
    if (COPY_NEVER.has(leaf.split('.')[0])) continue;
    const owners = owned.filter(p => leaf === p || leaf.startsWith(p + '.'));
    assert.equal(owners.length, 1, `${leaf} is owned by ${owners.length} groups`);
  }
  assert.equal(new Set(COPY_GROUPS.map(g => g.id)).size, COPY_GROUPS.length, 'group ids are unique');
});

test('only the chosen groups are copied, and pasting leaves the rest alone', () => {
  const src = DEFAULT_EDITS();
  src.tone.exposure = 1.2; src.tone.contrast = 30; src.wb.temp = 15; src.crop = { ...src.crop, x: 0.1, w: 0.8, angle: 3 };
  const dst = DEFAULT_EDITS();
  dst.tone.contrast = -10; dst.crop.angle = -2;
  const out = applySettings(dst, pickSettings(src, ['exposure', 'wb', 'crop']));
  assert.equal(out.tone.exposure, 1.2);
  assert.equal(out.wb.temp, 15);
  assert.equal(out.tone.contrast, -10, 'contrast was not chosen');
  assert.equal(out.crop.x, 0.1);
  assert.equal(out.crop.w, 0.8);
  assert.equal(out.crop.angle, -2, 'straighten is its own group');
  assert.equal(dst.tone.exposure, 0, 'the target recipe itself is not mutated');
});

test("masks are added once, never replacing the photo's own", () => {
  const src = mergeDefaults({ masks: [{ id: 'a', type: 'ai', name: 'Subject', params: { kind: 'subject' } }, { id: 'b', type: 'linear', name: 'Sky', params: {} }] });
  const dst = mergeDefaults({ masks: [{ id: 'z', type: 'radial', name: 'Face', params: {} }] });
  const clip = pickSettings(src, [], ['a']);
  const once = applySettings(dst, clip);
  assert.deepEqual(once.masks.map(m => m.id), ['z', 'a']);
  assert.deepEqual(applySettings(once, clip).masks.map(m => m.id), ['z', 'a'], 'pasting twice does not duplicate');
});

test('"Modified" finds exactly the groups that differ from the defaults', () => {
  const e = DEFAULT_EDITS();
  assert.deepEqual(modifiedGroups(e), []);
  e.tone.shadows = 20; e.effects.glow.amount = 10; e.lens.autoProfile = true;
  assert.deepEqual(modifiedGroups(e).sort(), ['glow', 'lensProfile', 'shadows']);
});
