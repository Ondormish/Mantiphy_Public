/* The edit recipe — plain JSON, stored per photo — and the pure functions that
   manipulate it (defaults, merging, presets). No DOM and no application state,
   so it runs (and is tested) under plain Node: see tests/unit. */
import { deepClone } from './util.js';

// ---------------------------------------------------------------------------
// default edit recipe
// ---------------------------------------------------------------------------
const DEFAULT_EDITS = () => ({
  v: 1,
  wb: { temp: 0, tint: 0 },
  tone: { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 },
  presence: { texture: 0, clarity: 0, dehaze: 0, vibrance: 0, saturation: 0, denoise: 0, denoiseDetail: 30 },
  curve: { rgb: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] },
  hsl: { hue: [0, 0, 0, 0, 0, 0, 0, 0], sat: [0, 0, 0, 0, 0, 0, 0, 0], lum: [0, 0, 0, 0, 0, 0, 0, 0] },
  grading: { shadows: { h: 220, s: 0, l: 0 }, midtones: { h: 40, s: 0, l: 0 }, highlights: { h: 50, s: 0, l: 0 }, blending: 50, balance: 0 },
  detail: { sharpen: 40, radius: 1, detail: 25, masking: 0 },
  lens: { distortion: 0, vignette: 0, autoProfile: false, profileVignette: 100 },
  effects: {
    vignette: 0, midpoint: 50, feather: 50, roundness: 0, grain: 0, grainSize: 2,
    colorEnhance: 0, dynamicContrast: 0,
    glow: { amount: 0, radius: 50, threshold: 0, warmth: 30 },
    sunFlare: { x: 50, y: 30, amount: 0, size: 40, warmth: 40 },
  },
  crop: { x: 0, y: 0, w: 1, h: 1, angle: 0, flipH: false, flipV: false, aspect: 'original' },
  masks: [],
  heal: { strokes: [] },
  clone: { strokes: [] },
  snapshots: [],
  preset: null, // { name, base, applied } — see withPreset()
});
const MASK_ADJ = () => ({ temp: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, texture: 0, clarity: 0, dehaze: 0, saturation: 0, sharpness: 0 });
const SKY_LOOKS = [
  { name: 'Dramatic', adj: { contrast: 35, dehaze: 30, clarity: 20, highlights: -35, shadows: 10, saturation: 10 } },
  { name: 'Sunset glow', adj: { temp: 25, tint: 5, exposure: -0.2, contrast: 15, saturation: 20, highlights: -15 } },
  { name: 'Deep blue', adj: { temp: -20, saturation: 25, contrast: 15, dehaze: 15, exposure: -0.15 } },
  { name: 'Moody', adj: { dehaze: -25, exposure: -0.4, contrast: 10, saturation: -15 } },
  { name: 'Clear & bright', adj: { exposure: 0.3, dehaze: 20, contrast: 8, saturation: 8 } },
];
const mergeDefaults = e => { const d = DEFAULT_EDITS(); const m = (a, b) => { for (const k in a) if (b && k in b) { if (a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) m(a[k], b[k]); else a[k] = b[k]; } }; m(d, e || {}); if (Array.isArray(e?.masks)) d.masks = e.masks.map(x => ({ ...x, adj: { ...MASK_ADJ(), ...(x.adj || {}) }, refine: { strokes: (x.refine && x.refine.strokes) || [] } })); return d; };
const isEdited = e => JSON.stringify(e) !== JSON.stringify(DEFAULT_EDITS());

function mergeSettings(dst, src) { for (const k in src) { if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && dst[k] && typeof dst[k] === 'object') mergeSettings(dst[k], src[k]); else dst[k] = deepClone(src[k]); } return dst; }

// Presets replace each other instead of piling up. The look before the first
// preset is remembered (base), along with the look the preset produced (applied);
// switching presets goes back to base — keeping any slider the user moved since
// (a value that no longer matches `applied`) — and applies the new one on top.
// Geometry, masks, retouching and lens corrections are never touched by presets.
const PRESET_SKIP = new Set(['v', 'crop', 'masks', 'heal', 'clone', 'snapshots', 'lens', 'preset']);
const lookOf = e => { const o = {}; for (const k in e) if (!PRESET_SKIP.has(k)) o[k] = deepClone(e[k]); return o; };
function keepTweaks(base, applied, now) {
  const out = deepClone(base);
  const walk = (o, a, n) => { for (const k in n) { const nv = n[k], av = a?.[k];
    if (nv && typeof nv === 'object' && !Array.isArray(nv) && o[k] && typeof o[k] === 'object') walk(o[k], av, nv);
    else if (JSON.stringify(nv) !== JSON.stringify(av)) o[k] = deepClone(nv); } };
  walk(out, applied, now); return out;
}
/** edits with preset p applied (p=null removes the current preset). Pure. */
function withPreset(edits, p) {
  let e = deepClone(edits);
  const base = e.preset?.base ? keepTweaks(e.preset.base, e.preset.applied, lookOf(e)) : lookOf(e);
  Object.assign(e, deepClone(base));
  if (p) { const ps = deepClone(p.settings); for (const k of PRESET_SKIP) delete ps[k]; mergeSettings(e, ps); }
  e = mergeDefaults(e);
  e.preset = p ? { name: p.name, base, applied: lookOf(e) } : null;
  return e;
}
// ---------------------------------------------------------------------------
// Copy / paste / sync settings — the groups offered in the Copy Settings
// dialog, as in Lightroom. Each group owns one or more paths of the recipe;
// every setting of DEFAULT_EDITS belongs to exactly one group (tested), so a
// setting added later cannot silently escape copying. Masks are listed one by
// one by the dialog itself, since each photo has its own.
// ---------------------------------------------------------------------------
const COPY_GROUPS = [
  { section: 'Basic', id: 'wb', label: 'White balance', paths: ['wb'] },
  { section: 'Basic', id: 'exposure', label: 'Exposure', paths: ['tone.exposure'] },
  { section: 'Basic', id: 'contrast', label: 'Contrast', paths: ['tone.contrast'] },
  { section: 'Basic', id: 'highlights', label: 'Highlights', paths: ['tone.highlights'] },
  { section: 'Basic', id: 'shadows', label: 'Shadows', paths: ['tone.shadows'] },
  { section: 'Basic', id: 'whites', label: 'Whites', paths: ['tone.whites'] },
  { section: 'Basic', id: 'blacks', label: 'Blacks', paths: ['tone.blacks'] },
  { section: 'Presence', id: 'texture', label: 'Texture', paths: ['presence.texture'] },
  { section: 'Presence', id: 'clarity', label: 'Clarity', paths: ['presence.clarity'] },
  { section: 'Presence', id: 'dehaze', label: 'Dehaze', paths: ['presence.dehaze'] },
  { section: 'Presence', id: 'vibrance', label: 'Vibrance', paths: ['presence.vibrance'] },
  { section: 'Presence', id: 'saturation', label: 'Saturation', paths: ['presence.saturation'] },
  { section: 'Tone & colour', id: 'curve', label: 'Tone curve', paths: ['curve'] },
  { section: 'Tone & colour', id: 'hsl', label: 'HSL / colour mixer', paths: ['hsl'] },
  { section: 'Tone & colour', id: 'grading', label: 'Colour grading', paths: ['grading'] },
  { section: 'Detail', id: 'sharpen', label: 'Sharpening', paths: ['detail'] },
  { section: 'Detail', id: 'denoise', label: 'Noise reduction', paths: ['presence.denoise', 'presence.denoiseDetail'] },
  { section: 'Lens corrections', id: 'lensProfile', label: 'Lens profile', paths: ['lens.autoProfile', 'lens.profileVignette'] },
  { section: 'Lens corrections', id: 'lensManual', label: 'Manual distortion & vignetting', paths: ['lens.distortion', 'lens.vignette'] },
  { section: 'Effects', id: 'vignette', label: 'Post-crop vignette', paths: ['effects.vignette', 'effects.midpoint', 'effects.feather', 'effects.roundness'] },
  { section: 'Effects', id: 'grain', label: 'Grain', paths: ['effects.grain', 'effects.grainSize'] },
  { section: 'Effects', id: 'glow', label: 'Glow', paths: ['effects.glow'] },
  { section: 'Effects', id: 'sunFlare', label: 'Sun flare', paths: ['effects.sunFlare'] },
  { section: 'Effects', id: 'colorEnhance', label: 'Colour enhance', paths: ['effects.colorEnhance'] },
  { section: 'Effects', id: 'dynamicContrast', label: 'Dynamic contrast', paths: ['effects.dynamicContrast'] },
  { section: 'Geometry', id: 'crop', label: 'Crop', paths: ['crop.x', 'crop.y', 'crop.w', 'crop.h', 'crop.aspect'] },
  { section: 'Geometry', id: 'straighten', label: 'Straighten angle', paths: ['crop.angle'] },
  { section: 'Geometry', id: 'flip', label: 'Flip', paths: ['crop.flipH', 'crop.flipV'] },
  { section: 'Retouching', id: 'heal', label: 'Object removal', paths: ['heal'] },
  { section: 'Retouching', id: 'clone', label: 'Clone stamp', paths: ['clone'] },
];
// Not settings of the look: format version, history snapshots, preset bookkeeping.
const COPY_NEVER = new Set(['v', 'snapshots', 'preset', 'masks']);
// Like Lightroom: geometry, retouching and masks are photo-specific, so they
// start unchecked; everything else starts checked.
const COPY_OFF_BY_DEFAULT = new Set(['crop', 'straighten', 'flip', 'heal', 'clone']);

const _get = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const _set = (o, p, v) => { const ks = p.split('.'); let c = o; for (let i = 0; i < ks.length - 1; i++) c = c[ks[i]] ??= {}; c[ks[ks.length - 1]] = v; };

/** Group ids whose settings differ from the defaults in edits (the "Modified" button). */
function modifiedGroups(edits) {
  const d = DEFAULT_EDITS();
  return COPY_GROUPS.filter(g => g.paths.some(p => JSON.stringify(_get(edits, p)) !== JSON.stringify(_get(d, p)))).map(g => g.id);
}

/** A clipboard holding only the chosen groups and masks of edits. */
function pickSettings(edits, groupIds, maskIds = []) {
  const want = new Set(groupIds), values = {};
  for (const g of COPY_GROUPS) if (want.has(g.id)) for (const p of g.paths) _set(values, p, deepClone(_get(edits, p)));
  const ids = new Set(maskIds);
  const masks = (edits.masks || []).filter(m => ids.has(m.id)).map(deepClone);
  return { values, masks, groups: [...want].filter(id => COPY_GROUPS.some(g => g.id === id)) };
}

/** edits with a clipboard pasted in. Chosen settings replace the photo's own;
 *  masks are added to the photo's masks (AI masks recompute for the new photo),
 *  and a mask already pasted there once is not added twice. Pure. */
function applySettings(edits, clip) {
  const e = deepClone(edits);
  mergeSettings(e, clip.values || {});
  const have = new Set((e.masks || []).map(m => m.id));
  e.masks = [...(e.masks || []), ...(clip.masks || []).filter(m => !have.has(m.id)).map(deepClone)];
  return e;
}

export { DEFAULT_EDITS, MASK_ADJ, SKY_LOOKS, mergeDefaults, isEdited, mergeSettings, PRESET_SKIP, lookOf, keepTweaks, withPreset,
  COPY_GROUPS, COPY_NEVER, COPY_OFF_BY_DEFAULT, modifiedGroups, pickSettings, applySettings };
