// Unit tests for the pure edit-recipe logic (frontend/edits.js) and the built-in
// presets. No dependencies: run with `node --test tests/unit`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EDITS, mergeDefaults, isEdited, withPreset } from '../../frontend/edits.js';
import { BUILTIN_PRESETS } from '../../frontend/presets-data.js';

const byName = n => BUILTIN_PRESETS.find(p => p.name === n);

test('a default recipe is not "edited", and old recipes gain new keys', () => {
  assert.equal(isEdited(DEFAULT_EDITS()), false);
  const old = { tone: { exposure: 0.5 }, detail: { sharpen: 10 } }; // saved before detail.detail existed
  const e = mergeDefaults(old);
  assert.equal(e.tone.exposure, 0.5);
  assert.equal(e.detail.sharpen, 10);
  assert.equal(e.detail.detail, DEFAULT_EDITS().detail.detail);
  assert.equal(e.preset, null);
});

test('applying a preset replaces the previous one instead of stacking', () => {
  let e = withPreset(DEFAULT_EDITS(), byName('Silver gelatin'));
  assert.equal(e.presence.saturation, -100);
  assert.equal(e.preset.name, 'Silver gelatin');
  e = withPreset(e, byName('Kodak Portra 400'));
  assert.equal(e.presence.saturation, -8, 'B&W must not survive into Portra');
  assert.equal(e.effects.grain, 18);
  assert.equal(e.preset.name, 'Kodak Portra 400');
});

test("the user's own tweaks survive a preset switch; removing restores the base", () => {
  const start = DEFAULT_EDITS(); start.tone.exposure = 0.7; start.wb.temp = 12;
  let e = withPreset(start, byName('Silver gelatin'));
  e.presence.dehaze = 33; // moved by hand after the preset (Portra doesn't set dehaze)
  e = withPreset(e, byName('Kodak Portra 400'));
  assert.equal(e.presence.dehaze, 33, 'manual tweak kept');
  assert.equal(e.tone.exposure, 0.7, 'pre-preset value kept where Portra does not set it');
  e = withPreset(e, null);
  assert.equal(e.preset, null);
  assert.equal(e.presence.saturation, 0);
  assert.equal(e.effects.grain, 0);
  assert.equal(e.wb.temp, 12);
  assert.equal(e.presence.dehaze, 33);
});

test('presets never touch geometry, masks or retouching', () => {
  const start = DEFAULT_EDITS();
  start.crop.w = 0.5; start.masks = [{ id: 'm1', type: 'radial' }]; start.lens.autoProfile = true;
  const e = withPreset(start, byName('Epic landscape'));
  assert.equal(e.crop.w, 0.5);
  assert.equal(e.masks.length, 1);
  assert.equal(e.lens.autoProfile, true);
});

test('built-in presets are sane', () => {
  const names = new Set();
  for (const p of BUILTIN_PRESETS) {
    assert.ok(!names.has(p.name), 'duplicate preset name ' + p.name); names.add(p.name);
    const s = p.settings;
    assert.ok(Math.abs(s.tone?.exposure ?? 0) <= 1.5, `${p.name}: exposure is in EV`);
    assert.ok((s.effects?.vignette ?? 0) <= 0, `${p.name}: a positive vignette lightens the corners`);
    for (const k of ['hue', 'sat', 'lum']) if (s.hsl?.[k]) assert.equal(s.hsl[k].length, 8, `${p.name}: hsl.${k} has 8 bands`);
    for (const k of Object.keys(s)) assert.ok(k in DEFAULT_EDITS(), `${p.name}: unknown section ${k}`);
  }
});
