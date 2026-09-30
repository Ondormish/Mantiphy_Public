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
export { DEFAULT_EDITS, MASK_ADJ, SKY_LOOKS, mergeDefaults, isEdited, mergeSettings, PRESET_SKIP, lookOf, keepTweaks, withPreset };
