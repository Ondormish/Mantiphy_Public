import { Engine, curveLut } from './engine.js';
import { $, $$, api, clamp, deepClone, getPath, setPath, uid, toast, status, loadImg, debounce, esc } from './util.js';
import { DEFAULT_EDITS, MASK_ADJ, SKY_LOOKS, mergeDefaults, isEdited, mergeSettings, withPreset } from './edits.js';
import { BUILTIN_PRESETS } from './presets-data.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function loadImage16(iid) {
  const r = await fetch('/api/image/' + iid + '/preview16');
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'Failed to load 16-bit preview');
  const w = +r.headers.get('X-Width'), h = +r.headers.get('X-Height');
  const buf = await r.arrayBuffer();
  const u16 = new Uint16Array(buf, 8); // skip the <u32 w><u32 h> header (it used to be read as the first pixel)
  const f32 = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) f32[i] = u16[i] / 65535;
  return { data: f32, w, h };
}
async function maybeUseCleanTexture() {
  if (!S.edits.heal.strokes.length && !S.edits.clone.strokes.length && origPreview16) {
    engine.setImage16(origPreview16.data, origPreview16.w, origPreview16.h);
    // setImage16 drops every per-photo texture (masks, denoise): put them back, or a
    // reopened photo shows none of its saved AI/brush masks or AI denoise
    await rebuildMaskTextures(); await ensureDenoise(); requestRender();
  }
}

const HSL_NAMES = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'];
const HSL_COLORS = ['#d8584c', '#dd8a3c', '#d6c24a', '#6db55c', '#4fb7b2', '#5b8ed6', '#9b6fd0', '#cf64b3'];
const LABELS = { red: 'var(--red)', yellow: 'var(--yellow)', green: 'var(--green)', blue: 'var(--blue)', purple: 'var(--purple)' };

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const S = {
  module: 'library', images: [], byId: new Map(), folder: null, collection: null, smartCollection: null, query: '', minRating: 0, flag: '',
  sort: 'captured', desc: false,
  collapsed: new Set(JSON.parse(localStorage.getItem('mantiphy.collapsed') || '[]')),
  stack: localStorage.getItem('mantiphy.stack') === '1', expanded: new Set(),
  activeId: null, selection: new Set(), anchor: null,
  edits: DEFAULT_EDITS(), history: [], histIdx: -1, copied: null, presets: [], collections: [],
  anyWatched: false,
  tool: null, activeMask: null, maskOverlay: localStorage.getItem('mantiphy.maskOverlay') !== '0', maskSliding: false, before: false, clip: false, info: false,
  zoom: 'fit', pan: { x: 0, y: 0 }, dragging: null, curveChan: 'rgb', hslMode: 'hue', wbPicking: false, colorPicking: false,
  brush: { size: 6, feather: 60, flow: 100, erase: false }, health: {},
  healBrush: { size: 20, feather: 60 }, healBusy: false,
  cloneBrush: { size: 20, feather: 60, flow: 100 }, cloneSource: null,
  refineMode: null, refineBrush: { size: 15, feather: 60 },
};
let engine, previewImg = null, origPreview = null, origPreview16 = null, maskCanvases = new Map(), healCanvas = null, curHealStroke = null, healAppliedSig = null, refineCanvases = new Map(), curRefineStroke = null, denoisePending = null;
let cloneCanvas = null, curCloneStroke = null, healedPreview = null;
let lensProfile = null; // { matched, cameraName, lensName, distortion, vignetting } from /lensprofile, refetched per photo — not part of S.edits
let cameraMatrix = null; // flat 9-number array from /cameraprofile, or null (identity) — refetched per photo, not part of S.edits
const glCanvas = $('#gl');

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
async function boot() {
  try { engine = new Engine(glCanvas); } catch (e) { document.body.innerHTML = `<div class="empty"><h2>WebGL2 is required</h2><p>${esc(e.message)}</p></div>`; return; }
  S.health = await api.get('/api/health').catch(() => ({}));
  if (!S.health.rawpy) toast('rawpy missing — RAW files cannot be decoded');
  if (!S.health.ai) { $('#addSubject').disabled = $('#addBackground').disabled = $('#addPeople').disabled = true; $('#addSubject').title = $('#addBackground').title = $('#addPeople').title = 'Install rembg + onnxruntime to enable AI subject masks'; }
  { const dn = $('.sl[data-path="presence.denoise"]'); if (dn && S.health.aiDevice) dn.title = 'AI denoise runs on: ' + S.health.aiDevice; }
  if (!S.health.inpaint) { $$('[data-tool="heal"]').forEach(b => { b.disabled = true; b.title = 'Install simple-lama-inpainting (+ torch) to enable object removal'; }); }
  else if (S.health.gpu) { const h = $('#healHint'); if (h) h.textContent += ` (running on ${S.health.gpu}.)`; }
  buildSliders(); buildHsl(); buildQuick(); buildAspects(); buildCurve(); buildWheels(); buildKeys();
  bindShell(); bindLibrary(); bindDevelop(); bindMasks(); bindHeal(); bindClone(); bindSnapshots(); bindCrop(); bindCanvas(); bindExport(); bindSlideshow(); bindDrop();
  await Promise.all([refreshFolders(), refreshCollections(), refreshPresets()]);
  const last = localStorage.getItem('mantiphy.folder');
  if (last) S.folder = last;
  await refreshImages();
  if (!S.images.length && !(await api.get('/api/folders')).length) showEmpty();
  startTetherPolling();
}

// ---------------------------------------------------------------------------
// shell & modules
// ---------------------------------------------------------------------------
function setModule(m) {
  if (m === 'develop' && !S.activeId) { toast('Select a photo first'); return; }
  S.module = m;
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.mod === m));
  $('#grid').classList.toggle('hidden', m !== 'library'); $('#loupe').classList.toggle('hidden', m !== 'develop');
  $('#mapView').classList.toggle('hidden', m !== 'map');
  $('#app').classList.toggle('mapmode', m === 'map');
  $('#rightLibrary').classList.toggle('hidden', m !== 'library'); $('#rightDevelop').classList.toggle('hidden', m !== 'develop');
  ['pFolders', 'pCollections'].forEach(id => $('#' + id).classList.toggle('hidden', m === 'develop' || m === 'map'));
  ['pPresets', 'pHistory', 'pSnapshots', 'pSnap'].forEach(id => $('#' + id).classList.toggle('hidden', m !== 'develop'));
  if (m === 'develop') openInDevelop(S.activeId); else { setTool(null); }
  if (m === 'map') openMap();
  renderFilmstrip();
}
async function jumpToLibraryWithSelection(ids) {
  S.folder = null; S.collection = null; S.smartCollection = null; S.query = '';
  S.minRating = 0; S.flag = '';
  localStorage.removeItem('mantiphy.folder');
  const search = $('#search'); if (search) search.value = '';
  $$('#ratingFilter button').forEach(x => x.classList.toggle('on', +x.dataset.v === 0));
  $$('#flagFilter button').forEach(x => x.classList.toggle('on', x.dataset.v === ''));
  await refreshImages();
  refreshFolders(); refreshCollections();
  S.selection = new Set(ids);
  setModule('library');
  renderGrid();
  const cell = $(`#grid .cell[data-id="${ids[0]}"]`);
  if (cell) cell.scrollIntoView({ block: 'center' });
}
let mapInstance = null, mapMarkers = null;
async function openMap() {
  let geo, total;
  try {
    ({ items: geo, total } = await api.get('/api/images/geo'));
  } catch (e) {
    toast('Failed to load map data: ' + e.message);
    return;
  }
  const withCoords = geo.length;
  const el = $('#mapView');
  if (!el.querySelector('.map-count')) {
    const c = document.createElement('div'); c.className = 'map-count'; el.append(c);
  }
  $('.map-count', el).textContent = `${withCoords} photo${withCoords === 1 ? '' : 's'} with location` + (total > withCoords ? ` · ${total - withCoords} without` : '');
  if (!mapInstance) {
    if (!el.querySelector('#mapCanvas')) { const d = document.createElement('div'); d.id = 'mapCanvas'; el.append(d); }
    mapInstance = L.map('mapCanvas').setView([20, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(mapInstance);
    mapMarkers = L.markerClusterGroup();
    mapMarkers.on('clusterclick', (e) => {
      if (mapInstance.getZoom() < mapInstance.getMaxZoom()) return; // still room to zoom in — let default spiderfy/zoom behavior run
      const ids = e.layer.getAllChildMarkers().map(mk => mk._mantiphyId);
      if (ids.length) jumpToLibraryWithSelection(ids);
    });
    mapInstance.addLayer(mapMarkers);
  }
  mapMarkers.clearLayers();
  const latLngs = [];
  for (const g of geo) {
    const m = L.marker([g.lat, g.lon]);
    m._mantiphyId = g.id;
    m.on('click', () => jumpToLibraryWithSelection([g.id]));
    mapMarkers.addLayer(m);
    latLngs.push([g.lat, g.lon]);
  }
  if (latLngs.length) mapInstance.fitBounds(latLngs, { maxZoom: 10, padding: [20, 20] });
  setTimeout(() => mapInstance.invalidateSize(), 0);
}
function bindShell() {
  $$('.tabs button').forEach(b => b.onclick = () => setModule(b.dataset.mod));
  $$('.panel>header').forEach(h => h.addEventListener('click', e => { if (e.target.closest('.reset,.sw,button')) return; h.parentElement.classList.toggle('closed'); }));
  $$('dialog [data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());
  $('#shortcutsBtn').onclick = () => $('#dlgKeys').showModal();
  $('#search').oninput = debounce(() => { S.query = $('#search').value.trim(); refreshImages(); }, 250);
  $('#ratingFilter').onclick = e => { const b = e.target.closest('button'); if (!b) return; $$('#ratingFilter button').forEach(x => x.classList.toggle('on', x === b)); S.minRating = +b.dataset.v; refreshImages(); };
  $('#flagFilter').onclick = e => { const b = e.target.closest('button'); if (!b) return; $$('#flagFilter button').forEach(x => x.classList.toggle('on', x === b)); S.flag = b.dataset.v; refreshImages(); };
  const paintStack = () => { $('#stackBtn').classList.toggle('on', S.stack); $('#stackBtn').title = S.stack ? 'Versions of the same shot are grouped \u2014 click to ungroup' : 'Group versions of the same shot (RAW+JPEG, edited copies)'; };
  paintStack();
  $('#stackBtn').onclick = () => { S.stack = !S.stack; S.expanded.clear(); localStorage.setItem('mantiphy.stack', S.stack ? '1' : '0'); paintStack(); renderGrid(); };
  $('#sortBy').value = S.sort;
  $('#sortBy').onchange = () => { S.sort = $('#sortBy').value; refreshImages(); };
  $('#sortDir').onclick = () => { S.desc = !S.desc; $('#sortDir').textContent = S.desc ? '\u2193' : '\u2191'; refreshImages(); };
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', () => requestRender());
}
function showEmpty() {
  $('#grid').innerHTML = `<div class="empty"><h2>Your catalog is empty</h2><p>Import a folder of photos to begin. RAW files (CR3, ARW, RAF, NEF, DNG…) are decoded with LibRaw; JPEG, PNG and TIFF work too.</p><button class="tb primary" onclick="document.getElementById('importBtn').click()">Import a folder</button></div>`;
}

// ---------------------------------------------------------------------------
// library
// ---------------------------------------------------------------------------
async function refreshFolders() {
  const fl = await api.get('/api/folders'); const t = $('#folderTree'); t.innerHTML = '';
  S.anyWatched = fl.some(f => f.watched);
  const all = document.createElement('div'); all.className = 'node' + (S.folder ? '' : ' on'); all.innerHTML = `<svg><use href="#i-grid"/></svg><span>All photographs</span>`;
  all.onclick = () => { S.folder = null; S.collection = null; S.smartCollection = null; localStorage.removeItem('mantiphy.folder'); refreshImages(); refreshFolders(); refreshCollections(); }; t.append(all);

  const hasKids = f => fl.some(o => o.path.startsWith(f.path + '/'));
  const hidden = f => {
    // masque si un ancetre est replie
    for (const o of fl) if (f.path.startsWith(o.path + '/') && S.collapsed.has(o.path)) return true;
    return false;
  };
  for (const f of fl) {
    if (hidden(f)) continue;
    const kids = hasKids(f), open = !S.collapsed.has(f.path);
    const n = document.createElement('div'); n.className = 'node' + (S.folder === f.path ? ' on' : '');
    n.style.paddingLeft = (14 + f.depth * 13) + 'px';
    n.innerHTML = `<span class="tw${kids ? '' : ' leaf'}">${kids ? (open ? '\u25be' : '\u25b8') : ''}</span>` +
      `<svg><use href="#i-folder"/></svg><span title="${esc(f.path)}">${esc(f.name)}</span>` +
      `<span class="n">${esc(f.n)}</span>` + (f.root ? `<span class="watch${f.watched ? ' on' : ''}" title="${f.watched ? 'Stop watching for new photos' : 'Watch for new photos (tethering)'}"><svg><use href="#i-watch"/></svg></span><span class="x" title="Remove from catalog">\u00d7</span>` : '');
    n.onclick = e => {
      if (kids && e.target.classList.contains('tw')) { S.collapsed.has(f.path) ? S.collapsed.delete(f.path) : S.collapsed.add(f.path); saveCollapsed(); refreshFolders(); return; }
      if (e.target.closest('.watch')) { toggleWatch(f.path, !f.watched); return; }
      if (e.target.classList.contains('x')) { if (confirm(`Remove "${f.path}" from the catalog? Files are not deleted.`)) fetch('/api/folders?path=' + encodeURIComponent(f.path), { method: 'DELETE' }).then(() => { if (S.folder === f.path) S.folder = null; refreshFolders(); refreshImages(); }); return; }
      S.folder = f.path; S.collection = null; S.smartCollection = null; localStorage.setItem('mantiphy.folder', f.path); refreshImages(); refreshFolders(); refreshCollections();
    };
    n.oncontextmenu = async ev => {
      ev.preventDefault();
      const removed = await api.get('/api/ignored?folder=' + encodeURIComponent(f.path)).catch(() => []);
      const pick = () => { S.folder = f.path; S.collection = null; S.smartCollection = null; localStorage.setItem('mantiphy.folder', f.path); };
      const items = [
        { label: `Show these ${f.n} photos`, run: () => { pick(); refreshImages(); refreshFolders(); refreshCollections(); } },
        { label: `Select all ${f.n} photos`, run: async () => { pick(); refreshFolders(); refreshCollections(); await refreshImages(); selectAll(); } },
        '-',
        { label: `Export these ${f.n} photos\u2026`, run: async () => { pick(); refreshFolders(); refreshCollections(); await refreshImages(); selectAll(); $('#exportBtn').click(); } },
      ];
      const back = removed.filter(r => r.exists);
      if (back.length) items.push('-', { label: `Restore ${back.length} removed photo${back.length > 1 ? 's' : ''}`, run: async () => { const r = await api.send('/api/ignored/restore', 'POST', { paths: back.map(x => x.path) }); toast(`${r.restored.length} photo${r.restored.length > 1 ? 's' : ''} back in the library`); refreshFolders(); refreshImages(); } });
      if (kids) items.push('-', { label: open ? 'Collapse subfolders' : 'Expand subfolders', run: () => { open ? S.collapsed.add(f.path) : S.collapsed.delete(f.path); saveCollapsed(); refreshFolders(); } });
      if (f.root) items.push('-', { label: 'Remove from catalog\u2026', danger: true, run: () => { if (confirm(`Remove "${f.path}" from the catalog? Files are not deleted.`)) fetch('/api/folders?path=' + encodeURIComponent(f.path), { method: 'DELETE' }).then(() => { if (S.folder === f.path) S.folder = null; refreshFolders(); refreshImages(); }); } });
      showCtx(ev.clientX, ev.clientY, f.name, items);
    };
    t.append(n);
  }
}
async function toggleWatch(path, watch) {
  try {
    await api.send('/api/folders/watch', 'POST', { path, watch });
  } catch (e) {
    toast('Failed to toggle watch: ' + e.message);
  }
  refreshFolders();
}
let tetherSince = 0, tetherPrimed = false;
function startTetherPolling() {
  setInterval(async () => {
    if (!S.anyWatched) return;
    let r;
    try { r = await api.get('/api/tether/events?since=' + tetherSince); }
    catch { return; }
    tetherSince = r.now;
    if (!tetherPrimed) { tetherPrimed = true; return; }
    if (r.events.length) {
      const n = r.events.length;
      toast(`${n} nouvelle${n > 1 ? 's' : ''} photo${n > 1 ? 's' : ''} importée${n > 1 ? 's' : ''}`);
      refreshImages(); refreshFolders();
    }
  }, 2500);
}
function saveCollapsed() { localStorage.setItem('mantiphy.collapsed', JSON.stringify([...S.collapsed])); }
async function refreshCollections() {
  S.collections = await api.get('/api/collections'); const t = $('#collTree'); t.innerHTML = '';
  for (const c of S.collections) {
    const n = document.createElement('div'); n.className = 'node' + (c.filter ? (S.smartCollection === c.id ? ' on' : '') : (S.collection === c.id ? ' on' : ''));
    n.innerHTML = `<svg><use href="#${c.filter ? 'i-smart' : 'i-coll'}"/></svg><span>${esc(c.name)}</span><span class="n">${esc(c.n)}</span><span class="x" title="Delete collection">×</span>`;
    n.onclick = e => {
      if (e.target.classList.contains('x')) { if (confirm(`Delete collection "${c.name}"?`)) fetch('/api/collections/' + c.id, { method: 'DELETE' }).then(() => { if (S.collection === c.id) S.collection = null; if (S.smartCollection === c.id) S.smartCollection = null; refreshCollections(); refreshImages(); }); return; }
      if (c.filter) {
        S.collection = null; S.smartCollection = c.id; S.folder = c.filter.folder || null;
        S.query = c.filter.q || ''; S.minRating = c.filter.min_rating || 0;
        S.flag = c.filter.edited ? 'edited' : (c.filter.flag || '');
        $('#search').value = S.query;
        $$('#ratingFilter button').forEach(x => x.classList.toggle('on', +x.dataset.v === S.minRating));
        $$('#flagFilter button').forEach(x => x.classList.toggle('on', x.dataset.v === S.flag));
        refreshImages(); refreshFolders(); refreshCollections();
        return;
      }
      S.collection = c.id; S.smartCollection = null; S.folder = null; refreshImages(); refreshFolders(); refreshCollections();
    };
    t.append(n);
  }
}
async function refreshImages() {
  const p = new URLSearchParams(); if (S.folder) p.set('folder', S.folder); if (S.collection) p.set('collection', S.collection); if (S.query) p.set('q', S.query);
  if (S.minRating) p.set('min_rating', S.minRating); if (S.flag === 'edited') p.set('edited', 'true'); else if (S.flag) p.set('flag', S.flag);
  p.set('sort', S.sort); if (S.desc) p.set('desc', 'true');
  S.images = await api.get('/api/images?' + p); S.byId = new Map(S.images.map(i => [i.id, i]));
  for (const id of [...S.selection]) if (!S.byId.has(id)) S.selection.delete(id);
  if (S.activeId && !S.byId.has(S.activeId)) S.activeId = null;
  renderGrid(); renderFilmstrip(); renderMeta();
}
function cellHtml(im, film = false) {
  const stars = '★'.repeat(clamp(im.rating | 0, 0, 5));
  return `<img loading="lazy" src="/api/image/${esc(im.id)}/thumb${im.esig ? '?v=' + esc(im.esig) : ''}" onload="this.classList.add('ld')" alt="">
    ${im.flag ? `<span class="flag ${esc(im.flag)}"></span>` : ''}${LABELS[im.label] ? `<span class="lbl" style="background:${LABELS[im.label]}"></span>` : ''}${im.copy_of ? `<span class="edited" style="left:4px;right:auto">Copy ${esc(im.copy_index)}</span>` : ''}
    ${film ? (im.edited ? '<span class="fedited" title="Edited"></span>' : '') : `<span class="rawtag">${esc(im.ext.toUpperCase())}</span>${im.edited ? '<span class="edited">edited</span>' : ''}<div class="meta"><span class="stars">${stars}</span><span>${esc(im.filename)}</span></div>`}`;
}
function groupKey(im) {
  // Two files are versions of one shot when they share a capture time (RAW+JPEG,
  // or an original and its edited export); failing that, the same base name in one folder.
  return im.captured ? 'c:' + im.captured : 'n:' + im.folder + '/' + im.filename.replace(/\.[^.]+$/, '');
}
function gridItems() {
  if (!S.stack) return S.images.map(im => ({ im }));
  const groups = new Map();
  for (const im of S.images) { const k = groupKey(im); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(im); }
  const out = [];
  for (const [k, members] of groups) {
    if (members.length === 1) { out.push({ im: members[0] }); continue; }
    const rep = members.find(m => m.is_raw) || members[0];
    if (S.expanded.has(k)) for (const m of members) out.push({ im: m, key: k, n: members.length, head: m === rep, open: true });
    else out.push({ im: rep, key: k, n: members.length, head: true, open: false });
  }
  return out;
}
function renderGrid() {
  const g = $('#grid'); g.innerHTML = '';
  if (!S.images.length) { g.innerHTML = `<div class="empty"><h2>No photos here</h2><p>${S.query || S.minRating || S.flag ? 'Nothing matches the current filters.' : 'Import a folder, or pick another source on the left.'}</p></div>`; return; }
  const items = gridItems();
  const frag = document.createDocumentFragment();
  for (const it of items) {
    const im = it.im;
    const c = document.createElement('div');
    c.className = 'cell' + (S.selection.has(im.id) ? ' sel' : '') + (S.activeId === im.id ? ' active' : '') + (im.flag === 'reject' ? ' reject' : '')
      + (it.key && it.head && !it.open ? ' stacked' : '') + (it.key && it.open ? ' instack' : '');
    c.dataset.id = im.id;
    c.innerHTML = cellHtml(im) + (it.key && it.head
      ? `<span class="stackn" data-key="${esc(it.key)}" title="${esc(it.n)} versions of this shot — click to ${it.open ? 'collapse' : 'expand'}">\u29c9 ${it.open ? '\u2212' : it.n}</span>` : '');
    c.onclick = e => {
      const b = e.target.closest('.stackn');
      if (b) { e.stopPropagation(); S.expanded.has(b.dataset.key) ? S.expanded.delete(b.dataset.key) : S.expanded.add(b.dataset.key); renderGrid(); return; }
      selectImage(im.id, e);
    };
    c.ondblclick = () => { S.activeId = im.id; setModule('develop'); };
    c.oncontextmenu = ev => photoMenu(ev, im);
    frag.append(c);
  }
  g.append(frag);
  const hidden = S.images.length - items.length;
  $('#counter').textContent = `${S.images.length} photo${S.images.length === 1 ? '' : 's'}` + (hidden > 0 ? ` \u00b7 ${hidden} stacked` : '');
}
/** Right-click menu for a photo — the same in the Library grid, the filmstrip and
 *  on the Develop canvas. Acts on the selection when the clicked photo is part of it. */
function photoMenu(ev, im) {
  ev.preventDefault();
  if (!S.selection.has(im.id)) selectImage(im.id);
  const n = targets().length, s = n > 1 ? 's' : '', N = `${n} photo${s}`;
  const items = [];
  if (S.module !== 'develop') items.push({ label: 'Open in Develop', run: () => { S.activeId = im.id; setModule('develop'); } });
  items.push(
    { label: 'Copy settings', run: () => copySettingsFrom(im.id) },
    ...(S.copied ? [{ label: n > 1 || im.id !== S.activeId || S.module !== 'develop' ? `Paste settings to ${N}` : 'Paste settings', run: () => (n === 1 && im.id === S.activeId && S.module === 'develop') ? pasteSettings() : applyToSelection(S.copied, 'Pasting') }] : []),
    '-',
    { label: `Export ${N}…`, run: () => $('#exportBtn').click() },
    { label: n > 1 ? `Duplicate ${N} (virtual copies)` : 'Duplicate (virtual copy)', run: createVirtualCopy },
    { label: 'Start Slideshow…', run: () => openSlideshowDialog(targets()) },
  );
  if (n >= 2) items.push('-', { label: `Stack ${N}…`, run: () => openStackDialog(targets()) });
  if (n >= 2 && S.health.hdr) items.push({ label: `Merge ${N} to HDR…`, run: mergeToHdr });
  if (n >= 2 && S.health.panorama) items.push({ label: `Stitch ${N} to Panorama…`, run: stitchToPanorama });
  if (n === 1 && S.health.cameraProfile) items.push('-', { label: 'Calibrate camera profile from this photo…', run: calibrateCameraProfile });
  if (S.module !== 'develop') items.push('-', { label: 'Select all', run: selectAll }, { label: 'Select none', run: selectNone });
  items.push('-',
    { label: `Remove ${N} from library`, run: () => removePhotos(false) },
    { label: `Delete ${N} from disk…`, danger: true, run: () => removePhotos(true) });
  showCtx(ev.clientX, ev.clientY, n > 1 ? `${N} selected` : im.filename, items);
}
async function copySettingsFrom(id) {
  const e = (S.module === 'develop' && id === S.activeId) ? S.edits : mergeDefaults((await api.get('/api/image/' + id)).edits);
  S.copied = deepClone(e); for (const k of ['crop', 'masks', 'heal', 'clone', 'snapshots', 'preset']) delete S.copied[k];
  toast('Settings copied');
}
async function removePhotos(disk) {
  const ids = targets(); if (!ids.length) return;
  const n = ids.length, N = `${n} photo${n > 1 ? 's' : ''}`;
  const copies = ids.filter(i => S.byId.get(i)?.copy_of).length;
  const msg = disk
    ? `Move ${N} to the trash?\n\nThe file${n > 1 ? 's' : ''} and ${n > 1 ? 'their' : 'its'} sidecars go to your system trash (restore them from the file manager). ${copies ? 'Virtual copies only lose their own edits. ' : ''}Virtual copies of these photos are removed too.`
    : `Remove ${N} from the library?\n\nNothing is deleted on disk, and re-importing the folder won't bring ${n > 1 ? 'them' : 'it'} back. To restore: right-click the folder \u2192 "Restore removed photos".`;
  if (!confirm(msg)) return;
  const order = S.images.map(i => i.id); const after = order.find((id, i) => i > order.indexOf(ids[ids.length - 1]) && !ids.includes(id)) || order.filter(id => !ids.includes(id)).pop();
  try {
    const r = await api.send('/api/images/remove', 'POST', { ids, disk });
    if (r.errors?.length) toast('Some files could not be moved to the trash: ' + r.errors.join(', '));
    else toast(disk ? `${r.trashed.length || r.removed.length} moved to the trash` : `${r.removed.length} removed from the library`);
  } catch (e) { return toast('Failed: ' + e.message); }
  S.selection = new Set();
  if (ids.includes(S.activeId)) S.activeId = after || null;
  await refreshImages(); refreshFolders();
  if (S.module === 'develop') { if (S.activeId) openInDevelop(S.activeId); else setModule('library'); }
}
async function createVirtualCopy() {
  const ids = targets(); if (!ids.length) return;
  // the open photo's unsaved slider state must be on disk before it is duplicated
  if (S.module === 'develop' && ids.includes(S.activeId)) await api.send('/api/image/' + S.activeId, 'PATCH', { edits: S.edits }).catch(() => { });
  let last; for (const id of ids) last = (await api.send(`/api/image/${id}/copy`, 'POST')).iid;
  await refreshImages();
  S.activeId = last; S.selection = new Set([last]); renderGrid(); renderFilmstrip();
  if (S.module === 'develop') openInDevelop(last);
  toast(ids.length > 1 ? `${ids.length} virtual copies created` : 'Virtual copy created');
}
async function calibrateCameraProfile() {
  const ids = targets(); if (ids.length !== 1) return;
  status('Calibrating camera profile…');
  try {
    const r = await api.send(`/api/image/${ids[0]}/cameraprofile/calibrate`, 'POST');
    toast(`Camera profile saved for ${r.camera}`);
  } catch (e) { toast('Calibration failed: ' + e.message); }
  status('');
}
async function mergeToHdr() {
  const ids = targets(); if (ids.length < 2) return;
  status('Merging to HDR\u2026');
  try {
    const r = await api.send('/api/hdr/merge', 'POST', { ids });
    S.activeId = r.iid; S.selection = new Set([r.iid]);
    await refreshImages();
    toast('HDR merge complete');
  } catch (e) { toast('HDR merge failed: ' + e.message); }
  status('');
}
async function stitchToPanorama() {
  const ids = targets(); if (ids.length < 2) return;
  status('Stitching panorama\u2026');
  try {
    const r = await api.send('/api/panorama/stitch', 'POST', { ids });
    S.activeId = r.iid; S.selection = new Set([r.iid]);
    await refreshImages();
    toast('Panorama complete');
  } catch (e) { toast('Panorama stitch failed: ' + e.message); }
  status('');
}
function renderFilmstrip() {
  const f = $('#filmstrip'); f.innerHTML = '';
  if (S.module !== 'develop') { document.getElementById('app').classList.add('nostrip'); return; }
  document.getElementById('app').classList.remove('nostrip');
  for (const im of S.images) {
    const c = document.createElement('div'); c.className = 'fcell' + (S.activeId === im.id ? ' active' : S.selection.has(im.id) ? ' sel' : ''); c.dataset.id = im.id;
    c.innerHTML = cellHtml(im, true); c.onclick = e => { selectImage(im.id, e); openInDevelop(im.id); }; c.oncontextmenu = ev => photoMenu(ev, im); f.append(c);
    if (S.activeId === im.id) requestAnimationFrame(() => c.scrollIntoView({ inline: 'center', block: 'nearest' }));
  }
}
function selectImage(id, e) {
  const ids = S.images.map(i => i.id);
  if (e?.shiftKey && S.anchor) { const a = ids.indexOf(S.anchor), b = ids.indexOf(id); S.selection = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1)); }
  else if (e?.ctrlKey || e?.metaKey) { S.selection.has(id) ? S.selection.delete(id) : S.selection.add(id); S.anchor = id; }
  else { S.selection = new Set([id]); S.anchor = id; }
  S.activeId = id;
  $$('#grid .cell').forEach(c => { c.classList.toggle('sel', S.selection.has(c.dataset.id)); c.classList.toggle('active', c.dataset.id === id); });
  $$('#filmstrip .fcell').forEach(c => { c.classList.toggle('active', c.dataset.id === id); c.classList.toggle('sel', c.dataset.id !== id && S.selection.has(c.dataset.id)); });
  renderMeta(); updateSelCount();
}
function targets() { return S.selection.size ? [...S.selection] : S.activeId ? [S.activeId] : []; }
function selectAll() { S.selection = new Set(S.images.map(i => i.id)); if (!S.activeId && S.images.length) S.activeId = S.images[0].id; renderGrid(); renderFilmstrip(); renderMeta(); updateSelCount(); }
function selectNone() { S.selection.clear(); renderGrid(); renderFilmstrip(); renderMeta(); updateSelCount(); }
function updateSelCount() { const el = $('#selCount'); if (el) el.textContent = S.selection.size ? `${S.selection.size} selected` : ''; }
async function applyToSelection(partial, label) {
  const ids = targets(); if (!ids.length) return toast('Select photos first');
  // partial: settings to merge in, or a function edits -> edits (presets use withPreset)
  const ps = typeof partial === 'function' ? null : deepClone(partial); if (ps) { delete ps.crop; delete ps.masks; delete ps.heal; delete ps.clone; delete ps.snapshots; }
  let done = 0;
  for (const id of ids) {
    status(`${label} ${++done}/${ids.length}\u2026`);
    try {
      const full = await api.get('/api/image/' + id);
      const e = ps ? mergeSettings(mergeDefaults(full.edits), ps) : partial(mergeDefaults(full.edits));
      await api.send('/api/image/' + id, 'PATCH', { edits: e });
      const im = S.byId.get(id); if (im) im.edited = isEdited(e);
    } catch (err) { toast(`${S.byId.get(id)?.filename}: ${err.message}`); }
  }
  status('');
  if (S.activeId && ids.includes(S.activeId) && S.module === 'develop') openInDevelop(S.activeId);
  renderGrid(); renderFilmstrip();
  toast(`${label} \u2192 ${ids.length} photo${ids.length > 1 ? 's' : ''}`);
}

// ---- context menu --------------------------------------------------------------
function closeCtx() { $('#ctxmenu').classList.add('hidden'); }
function showCtx(x, y, title, items) {
  const m = $('#ctxmenu'); m.innerHTML = (title ? `<div class="hd" title="${esc(title)}">${esc(title)}</div>` : '') +
    items.map((it, i) => it === '-' ? '<div class="sep"></div>' : `<div class="mi${it.danger ? ' danger' : ''}" data-i="${i}">${esc(it.label)}</div>`).join('');
  m.onclick = e => { const d = e.target.closest('.mi'); if (!d) return; closeCtx(); items[+d.dataset.i].run(); };
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}
document.addEventListener('click', e => { if (!e.target.closest('#ctxmenu')) closeCtx(); });
window.addEventListener('blur', closeCtx);

async function patchImages(changes) {
  const ids = targets(); if (!ids.length) return;
  const rows = await api.send('/api/images/batch', 'POST', { ids, changes });
  for (const r of rows) { const im = S.byId.get(r.id); if (im) Object.assign(im, { rating: r.rating, flag: r.flag, label: r.label, keywords: r.keywords, edited: isEdited(mergeDefaults(r.edits)) }); }
  for (const id of ids) refreshCell(id);
}
/** Redraw one photo's tile in the Library grid and the filmstrip. */
function refreshCell(id) {
  const im = S.byId.get(id); if (!im) return;
  const c = $(`#grid .cell[data-id="${id}"]`); if (c) c.innerHTML = cellHtml(im);
  const fc = $(`#filmstrip .fcell[data-id="${id}"]`); if (!fc) return;
  // Swap only once the new thumbnail has loaded: filmstrip images have no
  // fade-in, so replacing them straight away blinks on every save.
  const html = cellHtml(im, true), src = /src="([^"]+)"/.exec(html)[1];
  fc.dataset.pending = src;
  const pre = new Image();
  pre.onload = pre.onerror = () => { if (fc.dataset.pending === src) fc.innerHTML = html; };
  pre.src = src;
  renderMeta();
}
function fmtMeta(im) {
  if (!im) return {};
  return { 'File': im.filename, 'Format': im.ext.toUpperCase() + (im.is_raw ? ' (RAW)' : ''), 'Dimensions': im.width ? `${im.width} × ${im.height}` : '—', 'Captured': im.captured || '—', 'Camera': im.camera || '—', 'Lens': im.lens || '—',
    'Exposure': [im.shutter ? im.shutter + 's' : null, im.aperture ? 'f/' + im.aperture : null, im.iso ? 'ISO ' + im.iso : null, im.focal ? im.focal + 'mm' : null].filter(Boolean).join('  ') || '—', 'Folder': im.folder };
}
function renderMeta() {
  const im = S.byId.get(S.activeId); const m = fmtMeta(im);
  for (const el of [$('#metaLib'), $('#metaDev')]) el.innerHTML = Object.entries(m).map(([k, v]) => `<dt>${esc(k)}</dt><dd title="${esc(v)}">${esc(v)}</dd>`).join('');
  $$('#quickRating .chip').forEach(b => b.classList.toggle('on', im && +b.dataset.v === im.rating && im.rating > 0));
  $$('#quickFlags .chip').forEach(b => b.classList.toggle('on', im && b.dataset.v === im.flag));
  $$('#quickLabels .chip').forEach(b => b.classList.toggle('on', im && b.dataset.v === im.label));
  $('#keywords').value = im?.keywords || '';
}
function buildQuick() {
  $('#quickRating').innerHTML = [1, 2, 3, 4, 5].map(n => `<button class="chip" data-v="${n}">${'★'.repeat(n)}</button>`).join('') + `<button class="chip" data-v="0">none</button>`;
  $('#quickFlags').innerHTML = `<button class="chip" data-v="pick">Pick <span class="kbd">P</span></button><button class="chip" data-v="reject">Reject <span class="kbd">X</span></button><button class="chip" data-v="">Unflag <span class="kbd">U</span></button>`;
  $('#quickLabels').innerHTML = Object.keys(LABELS).map((l, i) => `<button class="chip" data-v="${l}" style="border-left:3px solid ${LABELS[l]}">${l} <span class="kbd">${6 + i}</span></button>`).join('') + `<button class="chip" data-v="">none</button>`;
  $('#quickRating').onclick = e => { const b = e.target.closest('.chip'); if (b) patchImages({ rating: +b.dataset.v }); };
  $('#quickFlags').onclick = e => { const b = e.target.closest('.chip'); if (b) patchImages({ flag: b.dataset.v }); };
  $('#quickLabels').onclick = e => { const b = e.target.closest('.chip'); if (b) patchImages({ label: b.dataset.v }); };
  $('#keywords').onchange = () => patchImages({ keywords: $('#keywords').value });
  $('#selAllBtn').onclick = selectAll;
  $('#selNoneBtn').onclick = selectNone;
  $('#batchPasteBtn').onclick = () => S.copied ? applyToSelection(S.copied, 'Pasting') : toast('Copy settings from a photo first (Develop \u2192 Copy settings)');
  $('#batchResetBtn').onclick = () => { const ids = targets(); if (!ids.length) return toast('Select photos first'); if (confirm(`Reset all edits on ${ids.length} photo${ids.length > 1 ? 's' : ''}?`)) applyToSelection(DEFAULT_EDITS(), 'Resetting'); };
  $('#batchPreset').onchange = e => { const p = S.presets[+e.target.value]; e.target.selectedIndex = 0; if (p) applyToSelection(ed => withPreset(ed, p), `Applying \u201c${p.name}\u201d`); };
  $('#cellSize').oninput = () => $('#grid').style.setProperty('--cell', $('#cellSize').value + 'px');
}
function bindLibrary() {
  // import dialog with folder browser
  let cur = null, picked = null;
  // Click selects a folder, double-click opens it — the convention every file
  // picker uses. Before, a click only ever descended, so a folder you could
  // see was one you could not choose: importing it meant stepping inside first.
  const paintTarget = () => {
    $('#impGo').textContent = picked ? `Import "${picked.name}"` : 'Import this folder';
  };
  const browse = async p => {
    // Walk up to the nearest folder that still exists. The last-browsed path is
    // remembered across sessions, so a folder that has since been moved or
    // renamed made /api/fs 404, which threw before anything was rendered and
    // left the dialog blank — open, but with nothing in it to choose.
    let d = null, at = p, fellBack = false;
    for (let hop = 0; hop < 16 && !d; hop++) {
      try {
        d = await api.get('/api/fs?path=' + encodeURIComponent(at));
      } catch (e) {
        fellBack = true;
        const up = at.replace(/\/+[^/]*\/*$/, '');
        at = (!up || up === at || at === '~') ? '~' : up;
        if (at === '~' && hop > 0 && !up) break;
      }
    }
    if (!d) { toast('Could not open ' + p); return; }
    if (fellBack) {
      localStorage.removeItem('mantiphy.lastBrowse');
      toast(`${p} is gone — showing ${d.path}`);
    }
    cur = d.path; picked = null;
    $('#impPath').textContent = d.path + (d.images ? `   (${d.images} photos here)` : '');
    const b = $('#impBrowser'); b.innerHTML = '';
    if (d.parent) { const up = document.createElement('div'); up.className = 'node up'; up.textContent = '↑ ..'; up.onclick = () => browse(d.parent); b.append(up); }
    for (const x of d.dirs) {
      const n = document.createElement('div'); n.className = 'node';
      n.innerHTML = `<svg style="width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:1.5"><use href="#i-folder"/></svg>${esc(x.name)}<span class="go" title="Open this folder">›</span>`;
      n.onclick = e => {
        if (e.target.closest('.go')) return browse(x.path);
        picked = picked?.path === x.path ? null : x;
        $$('.node', b).forEach(e2 => e2.classList.remove('sel'));
        if (picked) n.classList.add('sel');
        paintTarget();
      };
      n.ondblclick = () => browse(x.path);
      b.append(n);
    }
    paintTarget();
  };
  $('#importBtn').onclick = () => { browse(localStorage.getItem('mantiphy.lastBrowse') || '~'); $('#dlgImport').showModal(); };
  $('#impGo').onclick = async () => {
    const target = picked ? picked.path : cur;
    $('#dlgImport').close(); status('Importing ' + target + '…'); localStorage.setItem('mantiphy.lastBrowse', target);
    try { const r = await api.send('/api/import', 'POST', { path: target, recursive: $('#impRecursive').checked }); toast(`Imported ${r.added} new, ${r.updated} updated`); S.folder = r.folder || target; localStorage.setItem('mantiphy.folder', S.folder); await refreshFolders(); await refreshImages(); }
    catch (e) { toast(e.message); } status('');
  };
  $('#newCollBtn').onclick = () => askName('New collection', 'Name', '', async name => { await api.send('/api/collections', 'POST', { name }); refreshCollections(); });
  $('#newSmartCollBtn').onclick = () => askName('Save current filters as Smart Collection', 'Name', '', async name => {
    const filter = { folder: S.folder, q: S.query, min_rating: S.minRating, flag: S.flag === 'edited' ? '' : S.flag, edited: S.flag === 'edited' ? true : null };
    await api.send('/api/collections', 'POST', { name, filter });
    refreshCollections();
  });
  $('#addToCollBtn').onclick = () => {
    if (!targets().length) return toast('Select photos first');
    const l = $('#pickList'); l.innerHTML = S.collections.map(c => `<div class="node" data-id="${esc(c.id)}">${esc(c.name)}<span class="n">${esc(c.n)}</span></div>`).join('') || '<div class="node">No collections yet — create one first.</div>';
    l.onclick = async e => { const n = e.target.closest('[data-id]'); if (!n) return; try { await api.send(`/api/collections/${n.dataset.id}/items`, 'POST', { ids: targets() }); } catch (err) { return toast(err.message); } $('#dlgPick').close(); toast('Added to collection'); refreshCollections(); };
    $('#dlgPick').showModal();
  };
}
function askName(title, label, val, cb, opts) {
  $('#nameTitle').textContent = title; $('#nameLabel').textContent = label; $('#nameInput').value = val;
  const folderRow = $('#nameFolderRow'); folderRow.style.display = opts?.folder ? '' : 'none';
  if (opts?.folder) {
    $('#nameFolderInput').value = opts.folderVal || '';
    $('#presetFolders').innerHTML = [...new Set(S.presets.filter(p => p.id).map(p => p.grp))].map(g => `<option value="${esc(g)}">`).join('');
  }
  const d = $('#dlgName'); d.showModal(); $('#nameInput').focus();
  $('#nameGo').onclick = () => { const v = $('#nameInput').value.trim(); if (!v) return; d.close(); cb(v, opts?.folder ? ($('#nameFolderInput').value.trim() || 'User') : undefined); };
  $('#nameInput').onkeydown = e => { if (e.key === 'Enter') $('#nameGo').click(); };
}

// ---------------------------------------------------------------------------
// develop: loading & history
// ---------------------------------------------------------------------------
async function openInDevelop(id) {
  const im = S.byId.get(id); if (!im) return;
  S.activeId = id; $('#loupeName').textContent = im.filename; $('#spinner').style.display = 'block';
  try {
    const [full, img, img16] = await Promise.all([api.get('/api/image/' + id), loadImg('/api/image/' + id + '/preview'), loadImage16(id).catch(() => null)]);
    if (S.activeId !== id) return;
    origPreview = img; origPreview16 = img16; maskCanvases.clear(); healCanvas = null; healAppliedSig = null; cloneCanvas = null; curCloneStroke = null; healedPreview = null;
    S.edits = mergeDefaults(full.edits); S.history = [{ label: 'Open', edits: deepClone(S.edits) }]; S.histIdx = 0;
    S.activeMask = null; setTool(null); S.zoom = 'fit'; S.before = false;
    lensProfile = null; syncLensPanel();
    api.get('/api/image/' + id + '/lensprofile').then(p => { if (S.activeId === id) { lensProfile = p; syncLensPanel(); requestRender(); } }).catch(() => { if (S.activeId === id) syncLensPanel(); });
    cameraMatrix = null;
    api.get('/api/image/' + id + '/cameraprofile').then(p => { if (S.activeId === id && p.matched) { cameraMatrix = p.matrix.flat(); requestRender(); } }).catch(() => {});
    await syncHeal(false); await syncClone(); await maybeUseCleanTexture(); syncUI(); renderHistory(); renderSnapshots(); renderMeta(); requestRender();
  } catch (e) { toast('Could not load: ' + e.message); }
  $('#spinner').style.display = 'none'; renderFilmstrip();
}
function syncLensPanel() {
  const el = $('#lensProfileStatus'); if (!el) return;
  el.textContent = lensProfile?.matched ? `Matched: ${lensProfile.cameraName} — ${lensProfile.lensName}` : 'No matching profile — using manual sliders only.';
}
const saveEdits = debounce(async () => {
  const id = S.activeId; if (!id) return;
  await api.send('/api/image/' + id, 'PATCH', { edits: S.edits }).catch(e => toast('Save failed: ' + e.message));
  const im = S.byId.get(id); if (im) im.edited = isEdited(S.edits);
  await pushEditedThumb(id);
  refreshCell(id);
}, 600);

/** Render the current develop state at thumbnail size and hand it to the
 *  backend, so the library stops showing the untouched original. Cheap: it
 *  reuses the preview texture already on the GPU, no full-res decode. */
async function pushEditedThumb(id) {
  const im = S.byId.get(id);
  if (!im || !engine || S.activeId !== id) return;
  try {
    if (!im.edited) { im.esig = ''; return; }
    const c = S.edits.crop || { x: 0, y: 0, w: 1, h: 1 };
    let ow = Math.round(c.w * engine.w), oh = Math.round(c.h * engine.h);
    if (!ow || !oh) return;
    const k = 480 / Math.max(ow, oh);
    if (k < 1) { ow = Math.max(1, Math.round(ow * k)); oh = Math.max(1, Math.round(oh * k)); }
    const px = engine.render({ edits: S.edits, hasCurve: S.hasCurve, view: { x: 0, y: 0, sx: ow, sy: oh }, outW: ow, outH: oh, toPixels: true, lensProfile: lensProfile && S.edits.lens.autoProfile ? lensProfile : null, cameraMatrix: cameraMatrix });
    const cv = document.createElement('canvas'); cv.width = ow; cv.height = oh;
    const g = cv.getContext('2d'); const idata = g.createImageData(ow, oh); const row = ow * 4;
    for (let y = 0; y < oh; y++) idata.data.set(px.subarray((oh - 1 - y) * row, (oh - y) * row), y * row);
    g.putImageData(idata, 0, 0);
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.86));
    const fd = new FormData(); fd.append('file', blob, 'thumb.jpg');
    const r = await fetch(`/api/image/${id}/thumb`, { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({}));
    if (j.sig) im.esig = j.sig;          // drives the <img> cache-buster
    requestRender();                      // the offscreen render clobbered the view
  } catch (e) { /* a stale thumbnail is not worth interrupting the edit for */ }
}
/** commit: push to history & save */
function commit(label) {
  S.history = S.history.slice(0, S.histIdx + 1); S.history.push({ label, edits: deepClone(S.edits) }); S.histIdx = S.history.length - 1;
  if (S.history.length > 200) { S.history.shift(); S.histIdx--; }
  renderHistory(); renderSnapshots(); saveEdits();
}
function restore(idx) {
  S.histIdx = idx; S.edits = deepClone(S.history[idx].edits);
  const needsHeal = JSON.stringify(S.edits.heal.strokes) !== healAppliedSig;
  if (needsHeal) { healCanvas = null; syncHeal(true).then(async () => { await syncClone(); maybeUseCleanTexture(); syncUI(); requestRender(); }); }
  else { cloneCanvas = null; syncClone().then(() => { maybeUseCleanTexture(); syncUI(); requestRender(); }); }
  saveEdits(); renderHistory(); renderSnapshots();
}
function renderHistory() {
  const l = $('#historyList'); l.innerHTML = '';
  S.history.map((h, i) => ({ h, i })).reverse().forEach(({ h, i }) => { const b = document.createElement('button'); b.textContent = h.label; b.className = i === S.histIdx ? 'on' : ''; b.onclick = () => restore(i); l.append(b); });
}
function renderSnapshots() {
  const l = $('#snapshotList'); l.innerHTML = '';
  S.edits.snapshots.forEach((snap, i) => {
    const b = document.createElement('button'); b.textContent = snap.name;
    b.onclick = async () => {
      S.edits = mergeDefaults({ ...deepClone(snap.edits), snapshots: S.edits.snapshots });
      await syncHeal(true); await syncClone(); maybeUseCleanTexture(); syncUI();
      commit('Restore snapshot: ' + snap.name); requestRender();
    };
    l.append(b);
    const del = document.createElement('button'); del.textContent = '×'; del.title = 'Delete snapshot'; del.className = 'del';
    del.onclick = e => { e.stopPropagation(); S.edits.snapshots.splice(i, 1); commit('Delete snapshot: ' + snap.name); renderSnapshots(); };
    l.append(del);
  });
}
function bindSnapshots() {
  $('#saveSnapshotBtn').onclick = e => { e.stopPropagation(); askName('Save snapshot', 'Snapshot name', '', name => {
    const snap = deepClone(S.edits); delete snap.snapshots;
    S.edits.snapshots.push({ name, created: Date.now(), edits: snap });
    commit('Snapshot: ' + name); renderSnapshots();
  }); };
}
function undo() { if (S.histIdx > 0) restore(S.histIdx - 1); }
function redo() { if (S.histIdx < S.history.length - 1) restore(S.histIdx + 1); }

// ---------------------------------------------------------------------------
// sliders & panels
// ---------------------------------------------------------------------------
function buildSliders() {
  $$('.sl').forEach(sl => {
    const rng = $('input[type=range]', sl), val = $('.val', sl); rng.min = sl.dataset.min; rng.max = sl.dataset.max; rng.step = sl.dataset.step;
    const path = sl.dataset.path, mpath = sl.dataset.mask, defv = path ? getPath(DEFAULT_EDITS(), path) : (mpath === 'amount' ? 100 : mpath === 'range.hi' ? 100 : mpath === 'range.smooth' ? 20 : 0);
    sl.dataset.def = defv;
    const apply = (v, final) => { v = +v; sl.classList.toggle('changed', v !== +defv); val.value = fmtVal(v, sl.dataset.step); rng.value = v; if (path) setPath(S.edits, path, v); else if (S.activeMask) { setPath(S.activeMask, mpath, v); } if (path === 'crop.angle' && final) fitCropToBounds(); if (path === 'presence.denoise' && final && v > 0) ensureDenoise(); if (final) commit(`${$('label', sl).textContent}: ${fmtVal(v, sl.dataset.step)}`); requestRender(); if (path === 'crop.angle') drawCropOverlay(); };
    rng.oninput = () => { if (mpath) S.maskSliding = true; apply(rng.value, false); }; rng.onchange = () => { S.maskSliding = false; apply(rng.value, true); };
    if (mpath) rng.addEventListener('pointerup', () => { if (S.maskSliding) { S.maskSliding = false; requestRender(); } });
    val.onchange = () => apply(clamp(parseFloat(val.value) || 0, +rng.min, +rng.max), true);
    $('label', sl).ondblclick = () => apply(defv, true);
    sl.addEventListener('wheel', e => { if (document.activeElement === val) return; e.preventDefault(); const st = +sl.dataset.step * (e.shiftKey ? 10 : 1); apply(clamp(+rng.value - Math.sign(e.deltaY) * st, +rng.min, +rng.max), true); }, { passive: false });
    rng.addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.stopPropagation(); } });
  });
  $$('[data-reset]').forEach(b => b.onclick = e => { e.stopPropagation(); const k = b.dataset.reset, d = DEFAULT_EDITS(); if (k === 'basic') { S.edits.wb = d.wb; S.edits.tone = d.tone; S.edits.presence = d.presence; } else S.edits[k] = d[k]; if (k === 'curve') updateCurveTexture(); syncUI(); commit('Reset ' + k); requestRender(); });
}
const fmtVal = (v, step) => { const dec = (String(step).split('.')[1] || '').length; const s = v.toFixed(dec); return (v > 0 && dec === 0 ? '+' : v > 0 ? '+' : '') + s; };
function syncUI() {
  $$('.sl[data-path]').forEach(sl => { const v = getPath(S.edits, sl.dataset.path); $('input[type=range]', sl).value = v; $('.val', sl).value = fmtVal(+v, sl.dataset.step); sl.classList.toggle('changed', +v !== +sl.dataset.def); });
  $$('#treatment button').forEach(b => b.classList.toggle('on', (S.edits.presence.saturation <= -100) === (b.dataset.v === 'bw')));
  $$('#aspects .chip').forEach(b => b.classList.toggle('on', b.dataset.v === S.edits.crop.aspect));
  $('#flipH').classList.toggle('on', S.edits.crop.flipH); $('#flipV').classList.toggle('on', S.edits.crop.flipV);
  $('#lensAutoProfile').checked = S.edits.lens.autoProfile;
  syncHsl(); drawCurve(); drawWheels(); updateCurveTexture(); renderMaskList(); syncMaskEditor(); markActivePreset();
}
function buildHsl() {
  const box = $('#hslSliders'); box.innerHTML = '';
  HSL_NAMES.forEach((n, i) => { const sl = document.createElement('div'); sl.className = 'sl'; sl.innerHTML = `<label><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${HSL_COLORS[i]};margin-right:7px;vertical-align:0"></i>${n}</label><input class="val"><input type="range" min="-100" max="100" step="1">`; box.append(sl);
    const rng = $('input[type=range]', sl), val = $('.val', sl);
    const apply = (v, final) => { v = +v; S.edits.hsl[S.hslMode][i] = v; rng.value = v; val.value = fmtVal(v, 1); sl.classList.toggle('changed', v !== 0); if (final) commit(`${n} ${S.hslMode}: ${fmtVal(v, 1)}`); requestRender(); };
    rng.oninput = () => apply(rng.value, false); rng.onchange = () => apply(rng.value, true); val.onchange = () => apply(clamp(parseFloat(val.value) || 0, -100, 100), true); $('label', sl).ondblclick = () => apply(0, true);
  });
  $('#hslMode').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.hslMode = b.dataset.v; $$('#hslMode button').forEach(x => x.classList.toggle('on', x === b)); syncHsl(); };
}
function syncHsl() { $$('#hslSliders .sl').forEach((sl, i) => { const v = S.edits.hsl[S.hslMode][i]; $('input[type=range]', sl).value = v; $('.val', sl).value = fmtVal(v, 1); sl.classList.toggle('changed', v !== 0); }); }

function bindDevelop() {
  $('#treatment').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.edits.presence.saturation = b.dataset.v === 'bw' ? -100 : 0; syncUI(); commit(b.dataset.v === 'bw' ? 'Black & white' : 'Colour'); requestRender(); };
  $('#wbShot').onclick = () => { S.edits.wb = { temp: 0, tint: 0 }; syncUI(); commit('WB: as shot'); requestRender(); };
  $('#wbAuto').onclick = () => { const m = meanColor(); applyNeutral(m); commit('WB: auto'); };
  $('#wbPick').onclick = () => { S.wbPicking = !S.wbPicking; glCanvas.classList.toggle('pick', S.wbPicking); $('#wbPick').classList.toggle('on', S.wbPicking); };
  $('#autoBtn').onclick = autoTone;
  $('#beforeBtn').onclick = () => toggleBefore();
  $('#lensAutoProfile').onclick = e => { S.edits.lens.autoProfile = e.target.checked; commit('Auto lens correction: ' + (e.target.checked ? 'on' : 'off')); requestRender(); };
  $('#clipS').onclick = $('#clipH').onclick = () => toggleClip();
  $$('.tools [data-tool]').forEach(b => b.onclick = () => setTool(S.tool === b.dataset.tool ? null : b.dataset.tool));
  $$('.loupe-bar .zoom button').forEach(b => b.onclick = () => setZoom(b.dataset.z));
  $('#savePresetBtn').onclick = e => { e.stopPropagation(); askName('Save preset', 'Preset name', '', async (name, folder) => { const s = deepClone(S.edits); delete s.preset; delete s.crop; delete s.masks; delete s.heal; delete s.clone; delete s.snapshots; await api.send('/api/presets', 'POST', { name, grp: folder, settings: s }); refreshPresets(); toast('Preset saved'); }, { folder: true, folderVal: 'User' }); };
  $('#resetAllBtn').onclick = e => { e.stopPropagation(); S.edits = DEFAULT_EDITS(); maskCanvases.clear(); healCanvas = null; cloneCanvas = null; syncHeal(true).then(async () => { await syncClone(); maybeUseCleanTexture(); syncUI(); commit('Reset all'); requestRender(); }); };
  $('#copyBtn').onclick = () => { S.copied = deepClone(S.edits); delete S.copied.preset; delete S.copied.crop; delete S.copied.masks; delete S.copied.heal; delete S.copied.clone; delete S.copied.snapshots; toast('Settings copied'); };
  $('#pasteBtn').onclick = pasteSettings;
  $('#syncBtn').onclick = async () => { const ids = targets().filter(i => i !== S.activeId); if (!ids.length) return toast('Select other photos in the filmstrip (Ctrl/Shift-click)'); const s = deepClone(S.edits); delete s.preset; delete s.crop; delete s.masks; delete s.heal; delete s.clone; delete s.snapshots; for (const id of ids) { const full = await api.get('/api/image/' + id); const e = mergeDefaults(full.edits); Object.assign(e, s); await api.send('/api/image/' + id, 'PATCH', { edits: e }); S.byId.get(id).edited = true; } toast(`Synced to ${ids.length} photo${ids.length > 1 ? 's' : ''}`); };
}
function pasteSettings() { if (!S.copied) return toast('Nothing copied yet'); Object.assign(S.edits, deepClone(S.copied)); syncUI(); ensureDenoise(); commit('Paste settings'); requestRender(); }
async function refreshPresets() {
  S.presets = [...BUILTIN_PRESETS, ...await api.get('/api/presets')]; const l = $('#presetList'); l.innerHTML = '';
  const collapsed = JSON.parse(localStorage.getItem('presetFoldersCollapsed') || '{}');
  let grp = null, box = null;
  for (const p of S.presets) {
    if (p.grp !== grp) {
      grp = p.grp;
      const det = document.createElement('details'); det.className = 'preset-folder'; det.open = !collapsed[grp];
      det.ontoggle = () => { collapsed[grp] = !det.open; localStorage.setItem('presetFoldersCollapsed', JSON.stringify(collapsed)); };
      const sum = document.createElement('summary'); sum.className = 'subhead'; sum.style.padding = '0 2px'; sum.textContent = grp;
      det.append(sum); l.append(det); box = det;
    }
    const d = document.createElement('div'); d.className = 'preset'; d.dataset.name = p.name; d.title = p.desc ? p.desc + ' — click to apply, click again to remove' : 'Click to apply, click again to remove';
    d.innerHTML = `<span>${esc(p.name)}</span>${p.id ? '<span class="x">×</span>' : ''}`;
    d.onclick = e => { if (e.target.classList.contains('x')) { fetch('/api/presets/' + p.id, { method: 'DELETE' }).then(refreshPresets); return; } applyPreset(p); };
    d.onmouseenter = () => startPresetPreview(p); d.onmouseleave = endPresetPreview;
    box.append(d);
  }
  markActivePreset();
  const bp = $('#batchPreset');
  if (bp) bp.innerHTML = '<option value="">Apply a preset\u2026</option>' +
    S.presets.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('');
}
function applyPreset(p) {
  endPresetPreview();
  const same = p && S.edits.preset?.name === p.name;
  S.edits = withPreset(S.edits, same ? null : p);
  syncUI(); ensureDenoise(); commit(same ? 'Preset removed: ' + p.name : 'Preset: ' + p.name); requestRender(); markActivePreset();
}
function markActivePreset() { const n = S.edits?.preset?.name; $$('#presetList .preset').forEach(d => d.classList.toggle('on', d.dataset.name === n)); }
// Hovering a preset previews it on the photo without touching the edit or history.
function startPresetPreview(p) {
  if (S.module !== 'develop' || !previewImg) return;
  S.previewEdits = withPreset(S.edits, S.edits.preset?.name === p.name ? null : p);
  updateCurveTexture(S.previewEdits); $('#presetPreviewTag').textContent = 'Preview: ' + p.name; $('#presetPreviewTag').classList.remove('hidden'); requestRender();
}
function endPresetPreview() {
  if (!S.previewEdits) return; S.previewEdits = null; updateCurveTexture(); $('#presetPreviewTag').classList.add('hidden'); requestRender();
}

// ---- auto tone / WB -----------------------------------------------------------
function samplePreview(n = 96) { const c = document.createElement('canvas'); c.width = n; c.height = Math.max(1, Math.round(n * previewImg.height / previewImg.width)); c.getContext('2d').drawImage(previewImg, 0, 0, c.width, c.height); return c.getContext('2d').getImageData(0, 0, c.width, c.height).data; }
function meanColor() { const d = samplePreview(); let r = 0, g = 0, b = 0, n = 0; for (let i = 0; i < d.length; i += 4) { const L = (d[i] + d[i + 1] + d[i + 2]) / 3; if (L < 20 || L > 240) continue; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; } return n ? [r / n, g / n, b / n] : [128, 128, 128]; }
function applyNeutral([r, g, b]) { const avg = (r + g + b) / 3; const temp = clamp(((b - r) / avg) * 110, -100, 100); const tint = clamp(((r + b) / 2 - g) / avg * 180, -100, 100); S.edits.wb = { temp: Math.round(temp), tint: Math.round(tint) }; syncUI(); requestRender(); }
function autoTone() {
  const d = samplePreview(160); const lum = []; for (let i = 0; i < d.length; i += 4) lum.push((d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8); lum.sort((a, b) => a - b);
  const q = p => lum[Math.floor(p * (lum.length - 1))] / 255; const med = q(0.5), lo = q(0.01), hi = q(0.99);
  const t = S.edits.tone; t.exposure = +clamp(Math.log2(0.42 / Math.max(med, 0.02)) * 0.6, -2.5, 2.5).toFixed(2);
  t.blacks = Math.round(clamp((0.04 - lo) * 250, -60, 60)); t.whites = Math.round(clamp((0.96 - hi) * 160, -60, 60));
  t.highlights = Math.round(clamp((0.85 - hi) * 120 - 10, -70, 20)); t.shadows = Math.round(clamp((0.2 - lo) * 100 + 10, -20, 60)); t.contrast = 8;
  S.edits.presence.vibrance = Math.max(S.edits.presence.vibrance, 10); syncUI(); commit('Auto tone'); requestRender();
}

// ---------------------------------------------------------------------------
// tone curve
// ---------------------------------------------------------------------------
const curveC = $('#curve'); let curveDrag = null;
function buildCurve() {
  $('#curveChan').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.curveChan = b.dataset.v; $$('#curveChan button').forEach(x => x.classList.toggle('on', x === b)); drawCurve(); };
  const pos = e => { const r = curveC.getBoundingClientRect(); return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp(1 - (e.clientY - r.top) / r.height, 0, 1)]; };
  curveC.onpointerdown = e => { const [x, y] = pos(e); const pts = S.edits.curve[S.curveChan]; let best = -1, bd = 0.04; pts.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = i; } });
    if (e.detail === 2 && best >= 0 && best !== 0 && best !== pts.length - 1) { pts.splice(best, 1); drawCurve(); updateCurveTexture(); commit('Curve point removed'); requestRender(); return; }
    if (best < 0) { pts.push([x, y]); pts.sort((a, b) => a[0] - b[0]); best = pts.findIndex(p => p[0] === x && p[1] === y); }
    curveDrag = best; curveC.setPointerCapture(e.pointerId); };
  curveC.onpointermove = e => { if (curveDrag == null) return; const pts = S.edits.curve[S.curveChan]; let [x, y] = pos(e); const i = curveDrag; if (i === 0) x = 0; else if (i === pts.length - 1) x = 1; else x = clamp(x, pts[i - 1][0] + 0.01, pts[i + 1][0] - 0.01); pts[i] = [x, y]; drawCurve(); updateCurveTexture(); requestRender(); };
  curveC.onpointerup = () => { if (curveDrag != null) { curveDrag = null; commit('Tone curve'); } };
}
function drawCurve() {
  const dpr = devicePixelRatio || 1; const w = curveC.clientWidth || 260; curveC.width = w * dpr; curveC.height = w * dpr; const g = curveC.getContext('2d'); g.scale(dpr, dpr);
  g.clearRect(0, 0, w, w); g.strokeStyle = '#2a2c31'; g.lineWidth = 1; for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(i * w / 4, 0); g.lineTo(i * w / 4, w); g.moveTo(0, i * w / 4); g.lineTo(w, i * w / 4); g.stroke(); }
  g.beginPath(); g.moveTo(0, w); g.lineTo(w, 0); g.stroke();
  // histogram ghost
  if (S.lastHisto) { const h = S.lastHisto.l, mx = Math.max(1, ...h); g.fillStyle = 'rgba(200,200,200,.10)'; g.beginPath(); g.moveTo(0, w); for (let i = 0; i < 256; i++) g.lineTo(i / 255 * w, w - Math.sqrt(h[i] / mx) * w * 0.9); g.lineTo(w, w); g.fill(); }
  const colors = { rgb: '#d8d5ce', r: '#e06b5f', g: '#6fc06a', b: '#6a95e0' };
  for (const ch of ['r', 'g', 'b', 'rgb']) { if (ch !== S.curveChan && JSON.stringify(S.edits.curve[ch]) === JSON.stringify([[0, 0], [1, 1]])) continue; const lut = curveLut(S.edits.curve[ch]); g.strokeStyle = colors[ch]; g.globalAlpha = ch === S.curveChan ? 1 : 0.35; g.lineWidth = ch === S.curveChan ? 1.6 : 1; g.beginPath(); for (let i = 0; i < 256; i++) { const x = i / 255 * w, y = w - lut[i] / 255 * w; i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); g.globalAlpha = 1; }
  for (const [x, y] of S.edits.curve[S.curveChan]) { g.fillStyle = '#fff'; g.beginPath(); g.arc(x * w, w - y * w, 4, 0, 7); g.fill(); g.strokeStyle = '#000'; g.lineWidth = 1; g.stroke(); }
}
function updateCurveTexture(edits = S.edits) {
  const ident = JSON.stringify([[0, 0], [1, 1]]); S.hasCurve = ['rgb', 'r', 'g', 'b'].some(c => JSON.stringify(edits.curve[c]) !== ident);
  if (!S.hasCurve) return;
  const m = curveLut(edits.curve.rgb), r = curveLut(edits.curve.r), gg = curveLut(edits.curve.g), b = curveLut(edits.curve.b); const lut = new Uint8Array(1024);
  for (let i = 0; i < 256; i++) { lut[i * 4] = r[i]; lut[i * 4 + 1] = gg[i]; lut[i * 4 + 2] = b[i]; lut[i * 4 + 3] = m[i]; } engine.setCurve(lut);
}

// ---------------------------------------------------------------------------
// colour grading wheels
// ---------------------------------------------------------------------------
function buildWheels() {
  $$('[data-wheel]').forEach(c => {
    const key = c.dataset.wheel; let drag = false;
    const set = (e, final) => { const r = c.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width * 2 - 1, y = (e.clientY - r.top) / r.height * 2 - 1; const d = Math.min(1, Math.hypot(x, y)); let h = Math.atan2(y, x) * 180 / Math.PI; h = (h + 360) % 360; S.edits.grading[key].h = Math.round(h); S.edits.grading[key].s = Math.round(d * 100); drawWheels(); requestRender(); if (final) commit(`Grade ${key}`); };
    c.onpointerdown = e => { drag = true; c.setPointerCapture(e.pointerId); set(e, false); }; c.onpointermove = e => drag && set(e, false); c.onpointerup = e => { drag = false; set(e, true); };
    c.ondblclick = () => { S.edits.grading[key].s = 0; drawWheels(); commit(`Grade ${key} reset`); requestRender(); };
  });
}
function drawWheels() {
  $$('[data-wheel]').forEach(c => {
    const dpr = devicePixelRatio || 1; const w = c.clientWidth || 80; c.width = c.height = w * dpr; const g = c.getContext('2d'); g.scale(dpr, dpr); const R = w / 2;
    const grad = g.createConicGradient(0, R, R); for (let i = 0; i <= 12; i++) grad.addColorStop(i / 12, `hsl(${i * 30},70%,55%)`); g.fillStyle = grad; g.beginPath(); g.arc(R, R, R, 0, 7); g.fill();
    const rad = g.createRadialGradient(R, R, 0, R, R, R); rad.addColorStop(0, 'rgba(40,41,45,1)'); rad.addColorStop(1, 'rgba(40,41,45,0)'); g.fillStyle = rad; g.fillRect(0, 0, w, w);
    const v = S.edits.grading[c.dataset.wheel]; const a = v.h * Math.PI / 180, d = v.s / 100 * R; g.beginPath(); g.arc(R + Math.cos(a) * d, R + Math.sin(a) * d, 4, 0, 7); g.fillStyle = '#fff'; g.fill(); g.strokeStyle = '#000'; g.stroke();
  });
}

// ---------------------------------------------------------------------------
// view / rendering
// ---------------------------------------------------------------------------
let renderQueued = false, histoT = 0;
function requestRender() { if (renderQueued || S.module !== 'develop' || !previewImg) return; renderQueued = true; requestAnimationFrame(doRender); }
function viewParams() {
  const dpr = devicePixelRatio || 1; const cw = glCanvas.clientWidth * dpr, ch = glCanvas.clientHeight * dpr;
  const W = engine.w, H = engine.h, c = S.edits.crop; const cropMode = S.tool === 'crop';
  const iw = cropMode ? W : c.w * W, ih = cropMode ? H : c.h * H; // content size in source px
  const origW = S.byId.get(S.activeId)?.width || W; const unit = dpr * origW / W; // display px per preview px at 1:1
  const fitZ = Math.min(cw / iw, ch / ih) * 0.96; const z = S.zoom === 'fit' ? fitZ : +S.zoom * unit;
  const sx = iw * z, sy = ih * z;
  let x = (cw - sx) / 2 + S.pan.x * dpr, y = (ch - sy) / 2 + S.pan.y * dpr;
  if (sx <= cw) x = (cw - sx) / 2; else x = clamp(x, cw - sx, 0); if (sy <= ch) y = (ch - sy) / 2; else y = clamp(y, ch - sy, 0);
  return { x, y, sx, sy, cw, ch, z, fitZ, dpr, cropMode, unit };
}
function doRender() {
  renderQueued = false; if (!previewImg) return;
  const v = viewParams(); if (glCanvas.width !== v.cw || glCanvas.height !== v.ch) { glCanvas.width = v.cw; glCanvas.height = v.ch; }
  engine.render({ edits: S.previewEdits || S.edits, hasCurve: S.hasCurve, view: v, outW: v.cw, outH: v.ch, cropMode: v.cropMode, before: S.before, clip: S.clip, showMaskId: S.tool === 'mask' && S.maskOverlay && !S.maskSliding && S.activeMask ? S.activeMask.id : (S.tool === 'heal' ? '__heal__' : null), lensProfile: lensProfile && S.edits.lens.autoProfile ? lensProfile : null, cameraMatrix: cameraMatrix });
  $('#zoomPct').textContent = Math.round(v.z / v.unit * 100) + '%';
  drawOverlay(v);
  const now = performance.now(); if (now - histoT > 120) { histoT = now; S.lastHisto = engine.histogram(v.cw, v.ch); drawHisto(); }
  if (S.info) drawInfo();
}
function drawHisto() {
  const c = $('#histo'), h = S.lastHisto; if (!h) return; const dpr = devicePixelRatio || 1; const w = c.clientWidth, hh = c.clientHeight; c.width = w * dpr; c.height = hh * dpr; const g = c.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, hh);
  const mx = Math.max(1, ...h.r, ...h.g, ...h.b) * 0.92; g.globalCompositeOperation = 'screen';
  for (const [k, col] of [['r', 'rgba(220,80,70,.75)'], ['g', 'rgba(90,190,90,.75)'], ['b', 'rgba(90,130,230,.75)']]) { g.fillStyle = col; g.beginPath(); g.moveTo(0, hh); for (let i = 0; i < 256; i++) g.lineTo(i / 255 * w, hh - Math.min(1, h[k][i] / mx) * hh); g.lineTo(w, hh); g.fill(); }
  g.globalCompositeOperation = 'source-over'; g.fillStyle = 'rgba(255,255,255,.15)'; g.beginPath(); g.moveTo(0, hh); for (let i = 0; i < 256; i++) g.lineTo(i / 255 * w, hh - Math.min(1, h.l[i] / mx) * hh); g.lineTo(w, hh); g.fill();
  const cs = (h.l[0] + h.l[1]) / Math.max(1, h.n), chp = (h.l[255] + h.l[254]) / Math.max(1, h.n);
  $('#clipS').style.borderColor = cs > 0.002 ? '#6a95e0' : ''; $('#clipH').style.borderColor = chp > 0.002 ? '#e06b5f' : '';
  const im = S.byId.get(S.activeId); $('#histoMeta').innerHTML = im ? `<span>${im.iso ? 'ISO ' + esc(im.iso) : ''}</span><span>${im.focal ? esc(im.focal) + ' mm' : ''}</span><span>${im.aperture ? 'f/' + esc(im.aperture) : ''}</span><span>${im.shutter ? esc(im.shutter) + ' s' : ''}</span>` : '';
}
function drawInfo() { const im = S.byId.get(S.activeId); const m = fmtMeta(im); $('#info').innerHTML = `<b>${esc(im.filename)}</b><br>${esc(m.Camera)} · ${esc(m.Lens)}<br>${esc(m.Exposure)}<br>${esc(m.Dimensions)} · ${esc(m.Captured)}`; }
function setZoom(z) { S.zoom = z; S.pan = { x: 0, y: 0 }; $$('.loupe-bar .zoom button').forEach(b => b.classList.toggle('on', b.dataset.z === String(z))); requestRender(); }
function toggleBefore() { S.before = !S.before; $('#beforeBtn').classList.toggle('on', S.before); requestRender(); }
function toggleClip() { S.clip = !S.clip; $('#clipS').classList.toggle('on', S.clip); $('#clipH').classList.toggle('on', S.clip); requestRender(); }

// ---- coordinate transforms (mirror of the shader) -----------------------------
const rot = (x, y, a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
function screenToImage(px, py, v) { // canvas css px -> image uv (y down), respecting crop/rotation/flip
  const c = S.edits.crop, A = engine.w / engine.h, a = c.angle * Math.PI / 180; const dpr = v.dpr;
  let cu = (px * dpr - v.x) / v.sx, cv = (py * dpr - v.y) / v.sy; let pi, pj;
  if (v.cropMode) { pi = cu; pj = cv; } else { pi = c.x + cu * c.w; pj = c.y + cv * c.h; }
  let dx = (pi - 0.5) * A, dy = pj - 0.5; [dx, dy] = rot(dx, dy, a); let ux = 0.5 + dx / A, uy = 0.5 + dy;
  if (c.flipH) ux = 1 - ux; if (c.flipV) uy = 1 - uy; return [ux, uy];
}
function imageToScreen(ux, uy, v) {
  const c = S.edits.crop, A = engine.w / engine.h, a = c.angle * Math.PI / 180; if (c.flipH) ux = 1 - ux; if (c.flipV) uy = 1 - uy;
  let dx = (ux - 0.5) * A, dy = uy - 0.5; [dx, dy] = rot(dx, dy, -a); const pi = 0.5 + dx / A, pj = 0.5 + dy;
  const cu = v.cropMode ? pi : (pi - c.x) / c.w, cv = v.cropMode ? pj : (pj - c.y) / c.h; return [(v.x + cu * v.sx) / v.dpr, (v.y + cv * v.sy) / v.dpr];
}

// ---------------------------------------------------------------------------
// canvas interaction: pan, zoom, wb picker, mask creation, brush
// ---------------------------------------------------------------------------
function bindCanvas() {
  let last = null, strokeActive = false, healActive = false, refineActive = false, cloneActive = false;
  glCanvas.addEventListener('pointerdown', e => {
    if (e.button === 2) return; // right button opens the photo menu, never pans or paints
    const v = viewParams(); const [ux, uy] = screenToImage(e.offsetX, e.offsetY, v);
    if (S.wbPicking) { pickWB(e); return; }
    if (S.colorPicking) { pickColor(e, ux, uy); return; }
    if (S.tool === 'heal' && !S.healBusy) { healActive = true; glCanvas.setPointerCapture(e.pointerId); healDab(ux, uy, true); return; }
    if (S.tool === 'clone' && e.altKey) { S.cloneSource = [ux, uy]; const cs = $('#clonesource'); cs.style.display = 'block'; cs.style.left = e.offsetX + 'px'; cs.style.top = e.offsetY + 'px'; cloneStatus('Source set — paint to clone'); requestRender(); return; }
    if (S.tool === 'clone') { cloneActive = true; glCanvas.setPointerCapture(e.pointerId); cloneDab(ux, uy, true); return; }
    if (S.tool === 'mask' && S.activeMask && S.refineMode) { refineActive = true; glCanvas.setPointerCapture(e.pointerId); refineDab(ux, uy, true); return; }
    if (S.tool === 'mask' && S.activeMask) {
      const m = S.activeMask;
      if (m.type === 'brush') { strokeActive = true; glCanvas.setPointerCapture(e.pointerId); brushDab(ux, uy, true); return; }
      if (m.type === 'linear' && m.pending) { m.params.x0 = ux; m.params.y0 = uy; m.params.x1 = ux; m.params.y1 = uy; S.dragging = { kind: 'newLinear' }; glCanvas.setPointerCapture(e.pointerId); return; }
      if (m.type === 'radial' && m.pending) { m.params.cx = ux; m.params.cy = uy; m.params.rx = 0.01; m.params.ry = 0.01; S.dragging = { kind: 'newRadial' }; glCanvas.setPointerCapture(e.pointerId); return; }
    }
    last = { x: e.clientX, y: e.clientY }; glCanvas.classList.add('grabbing'); glCanvas.setPointerCapture(e.pointerId);
  });
  glCanvas.addEventListener('pointermove', e => {
    const v = viewParams(); const bc = $('#brushcursor');
    if (S.tool === 'mask' && S.refineMode && S.activeMask) { bc.style.display = 'block'; const r = S.refineBrush.size / 100 * v.sx / v.dpr; bc.style.left = e.offsetX + 'px'; bc.style.top = e.offsetY + 'px'; bc.style.width = bc.style.height = r * 2 + 'px'; bc.style.setProperty('--feather', (r * S.refineBrush.feather / 100) + 'px'); bc.classList.toggle('erase', S.refineMode === 'subtract'); }
    else if (S.tool === 'mask' && S.activeMask?.type === 'brush') { bc.style.display = 'block'; bc.classList.remove('erase'); const r = S.brush.size / 100 * v.sx / v.dpr; bc.style.left = e.offsetX + 'px'; bc.style.top = e.offsetY + 'px'; bc.style.width = bc.style.height = r * 2 + 'px'; bc.style.setProperty('--feather', (r * S.brush.feather / 100) + 'px'); }
    else if (S.tool === 'heal') { bc.style.display = 'block'; bc.classList.remove('erase'); const r = S.healBrush.size / 100 * v.sx / v.dpr; bc.style.left = e.offsetX + 'px'; bc.style.top = e.offsetY + 'px'; bc.style.width = bc.style.height = r * 2 + 'px'; bc.style.setProperty('--feather', (r * S.healBrush.feather / 100) + 'px'); }
    else if (S.tool === 'clone') { bc.style.display = 'block'; bc.classList.remove('erase'); const r = S.cloneBrush.size / 100 * v.sx / v.dpr; bc.style.left = e.offsetX + 'px'; bc.style.top = e.offsetY + 'px'; bc.style.width = bc.style.height = r * 2 + 'px'; bc.style.setProperty('--feather', (r * S.cloneBrush.feather / 100) + 'px'); }
    else bc.style.display = 'none';
    if (refineActive) { const [ux, uy] = screenToImage(e.offsetX, e.offsetY, v); refineDab(ux, uy, false); return; }
    if (healActive) { const [ux, uy] = screenToImage(e.offsetX, e.offsetY, v); healDab(ux, uy, false); return; }
    if (cloneActive) { const [ux, uy] = screenToImage(e.offsetX, e.offsetY, v); cloneDab(ux, uy, false); if (curCloneStroke) { const offX = curCloneStroke.source[0] - curCloneStroke.pts[0][0], offY = curCloneStroke.source[1] - curCloneStroke.pts[0][1]; const [sx, sy] = imageToScreen(ux + offX, uy + offY, v); const cs = $('#clonesource'); cs.style.left = sx + 'px'; cs.style.top = sy + 'px'; } return; }
    if (strokeActive) { const [ux, uy] = screenToImage(e.offsetX, e.offsetY, v); brushDab(ux, uy, false); return; }
    if (S.dragging?.kind === 'newLinear') { const [ux, uy] = screenToImage(e.offsetX, e.offsetY, v); S.activeMask.params.x1 = ux; S.activeMask.params.y1 = uy; requestRender(); return; }
    if (S.dragging?.kind === 'newRadial') { const [ux, uy] = screenToImage(e.offsetX, e.offsetY, v); const p = S.activeMask.params; const A = engine.w / engine.h; p.rx = Math.max(0.005, Math.abs(ux - p.cx)) ; p.ry = Math.max(0.005, Math.abs(uy - p.cy)); if (!e.shiftKey) { const r = Math.hypot((ux - p.cx) * A, uy - p.cy); p.rx = r / A; p.ry = r; } requestRender(); return; }
    if (!last) return; S.pan.x += e.clientX - last.x; S.pan.y += e.clientY - last.y; last = { x: e.clientX, y: e.clientY }; requestRender();
  });
  const up = e => { if (refineActive) { refineActive = false; commit('Mask refine: ' + (curRefineStroke.mode === 'subtract' ? 'subtract' : 'add')); } if (healActive) { healActive = false; syncHeal(true).then(() => commit('Remove object')); } if (cloneActive) { cloneActive = false; if (curCloneStroke) { commit('Clone stamp'); rebuildMaskTextures(); ensureDenoise(); } } if (strokeActive) { strokeActive = false; commit('Brush stroke'); } if (S.dragging) { S.activeMask.pending = false; S.dragging = null; commit('Mask added'); renderMaskList(); requestRender(); } last = null; glCanvas.classList.remove('grabbing'); };
  glCanvas.addEventListener('pointerup', up); glCanvas.addEventListener('pointercancel', up); glCanvas.addEventListener('pointerleave', () => { $('#brushcursor').style.display = 'none'; });
  glCanvas.addEventListener('wheel', e => { e.preventDefault(); if (S.tool === 'mask' && S.refineMode && S.activeMask) { S.refineBrush.size = clamp(S.refineBrush.size * (e.deltaY > 0 ? 0.9 : 1.1), 0.5, 60); const sl = $('#refSize'); if (sl) { $('input[type=range]', sl).value = S.refineBrush.size; $('.val', sl).value = S.refineBrush.size.toFixed(1); } glCanvas.dispatchEvent(new PointerEvent('pointermove', { clientX: e.clientX, clientY: e.clientY })); return; } if (S.tool === 'mask' && S.activeMask?.type === 'brush') { S.brush.size = clamp(S.brush.size * (e.deltaY > 0 ? 0.9 : 1.1), 0.5, 60); syncBrushBar(); glCanvas.dispatchEvent(new PointerEvent('pointermove', { clientX: e.clientX, clientY: e.clientY })); return; } if (S.tool === 'heal') { S.healBrush.size = clamp(S.healBrush.size * (e.deltaY > 0 ? 0.9 : 1.1), 0.5, 60); const sl = $('#hSize'); if (sl) { $('input[type=range]', sl).value = S.healBrush.size; $('.val', sl).value = S.healBrush.size.toFixed(1); } glCanvas.dispatchEvent(new PointerEvent('pointermove', { clientX: e.clientX, clientY: e.clientY })); return; } if (S.tool === 'clone') { S.cloneBrush.size = clamp(S.cloneBrush.size * (e.deltaY > 0 ? 0.9 : 1.1), 0.5, 60); const sl = $('#cSize'); if (sl) { $('input[type=range]', sl).value = S.cloneBrush.size; $('.val', sl).value = S.cloneBrush.size.toFixed(1); } glCanvas.dispatchEvent(new PointerEvent('pointermove', { clientX: e.clientX, clientY: e.clientY })); return; } const vp = viewParams(); const z = vp.z / vp.unit; const nz = clamp(z * (e.deltaY > 0 ? 0.8 : 1.25), 0.05, 8); S.zoom = nz.toFixed(3); $$('.loupe-bar .zoom button').forEach(b => b.classList.remove('on')); requestRender(); }, { passive: false });
  glCanvas.addEventListener('dblclick', () => setZoom(S.zoom === 'fit' ? '1' : 'fit'));
  // right-click the photo itself for the photo menu (tools that paint keep the canvas to themselves)
  glCanvas.addEventListener('contextmenu', e => { const im = S.byId.get(S.activeId); if (!im || ['heal', 'clone'].includes(S.tool)) return; photoMenu(e, im); });
}
function readCanvasPixel(e) { const gl = engine.gl; const dpr = devicePixelRatio || 1; const px = new Uint8Array(4); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(Math.round(e.offsetX * dpr), Math.round(glCanvas.height - e.offsetY * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; }
function pickWB(e) {
  // sample a small neighbourhood from the *original* preview at this spot
  const v = viewParams(); const [ux, uy] = screenToImage(e.offsetX, e.offsetY, v); const c = document.createElement('canvas'); c.width = c.height = 9; const g = c.getContext('2d');
  g.drawImage(previewImg, ux * previewImg.width - 4, uy * previewImg.height - 4, 9, 9, 0, 0, 9, 9); const d = g.getImageData(0, 0, 9, 9).data; let r = 0, gg = 0, b = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
  applyNeutral([r, gg, b]); commit('WB: picked'); S.wbPicking = false; glCanvas.classList.remove('pick'); $('#wbPick').classList.remove('on');
}
function pickColor(e, ux, uy) {
  const px = readCanvasPixel(e); const [r, g, b] = [px[0] / 255, px[1] / 255, px[2] / 255]; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0; const d = mx - mn; if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h = (h * 60 + 360) % 360; }
  S.activeMask.colorRange = { enabled: true, h: Math.round(h), s: Math.round((mx ? d / mx : 0) * 100), v: Math.round(mx * 100), tol: S.activeMask.colorRange?.tol ?? 30 }; S.colorPicking = false; glCanvas.classList.remove('pick'); commit('Colour range picked'); syncMaskEditor(); requestRender();
}

// ---------------------------------------------------------------------------
// masks
// ---------------------------------------------------------------------------
function bindMasks() {
  $$('.addmask button').forEach(b => b.onclick = () => addMask(b.dataset.add));
  // One click to make the subject pop: a Subject mask with local sharpening and
  // texture, so the bird's feathers get crisp while the background stays smooth.
  $('#sharpenSubjectBtn').onclick = () => {
    if (!S.health.ai) return toast('Sharpen subject needs the AI masks: ./run.sh --with-ai');
    addMask('subject', { name: 'Subject sharpness', adj: { sharpness: 45, texture: 25, clarity: 10 } });
  };
  $('#maskOverlayBtn').onclick = e => { e.stopPropagation(); setMaskOverlay(!S.maskOverlay); };
  $('#maskOverlayOn').onchange = () => setMaskOverlay($('#maskOverlayOn').checked);
  setMaskOverlay(S.maskOverlay);
  $('#maskInvert').onchange = () => { if (!S.activeMask) return; S.activeMask.invert = $('#maskInvert').checked; commit('Mask inverted'); requestRender(); };
  $('#maskRangeOn').onchange = () => { if (!S.activeMask) return; S.activeMask.range = { ...(S.activeMask.range || { lo: 0, hi: 100, smooth: 20 }), enabled: $('#maskRangeOn').checked }; syncMaskEditor(); commit('Luminance range'); requestRender(); };
  $('#refAdd').onclick = () => { S.refineMode = S.refineMode === 'add' ? null : 'add'; syncRefineButtons(); };
  $('#refSub').onclick = () => { S.refineMode = S.refineMode === 'subtract' ? null : 'subtract'; syncRefineButtons(); };
  $('#refClear').onclick = () => { const m = S.activeMask; if (!m || !m.refine.strokes.length) return; m.refine.strokes = []; refineCanvases.delete(m.id); engine.setMaskTexture(m.id + '_refine', refineCanvasBuild(m, true)); commit('Mask refine cleared'); requestRender(); };
  for (const [id, k] of [['refSize', 'size'], ['refFeather', 'feather']]) {
    const sl = $('#' + id), r = $('input[type=range]', sl), v = $('.val', sl);
    r.value = S.refineBrush[k]; v.value = S.refineBrush[k];
    const ap = x => { S.refineBrush[k] = +x; r.value = x; v.value = x; };
    r.oninput = () => ap(r.value); v.onchange = () => ap(clamp(parseFloat(v.value) || 1, +r.min, +r.max));
  }
}
/** The red overlay shows where a mask applies, but hides what its adjustments do —
 *  so it can be switched off (button, checkbox or O), and it steps aside on its own
 *  while a mask slider is being dragged. */
function setMaskOverlay(on) {
  S.maskOverlay = on; try { localStorage.setItem('mantiphy.maskOverlay', on ? '1' : '0'); } catch { }
  $('#maskOverlayBtn').textContent = 'Overlay: ' + (on ? 'on' : 'off'); $('#maskOverlayOn').checked = on; requestRender();
}
function syncRefineButtons() { $('#refAdd').classList.toggle('on', S.refineMode === 'add'); $('#refSub').classList.toggle('on', S.refineMode === 'subtract'); }

// ---------------------------------------------------------------------------
// object removal (paint-out, backed by local LaMa inpainting)
// ---------------------------------------------------------------------------
function bindHeal() {
  for (const [id, k] of [['hSize', 'size'], ['hFeather', 'feather']]) {
    const sl = $('#' + id), r = $('input[type=range]', sl), v = $('.val', sl);
    r.value = S.healBrush[k]; v.value = S.healBrush[k];
    const ap = x => { S.healBrush[k] = +x; r.value = x; v.value = x; };
    r.oninput = () => ap(r.value); v.onchange = () => ap(clamp(parseFloat(v.value) || 1, +r.min, +r.max));
  }
  $('#healClearBtn').onclick = e => { e.stopPropagation(); if (!S.edits.heal.strokes.length) return; S.edits.heal.strokes = []; healCanvas = null; syncHeal(true).then(() => { maybeUseCleanTexture(); commit('Remove: cleared'); requestRender(); }); };
}
function bindClone() {
  for (const [id, k] of [['cSize', 'size'], ['cFeather', 'feather'], ['cFlow', 'flow']]) {
    const sl = $('#' + id), r = $('input[type=range]', sl), v = $('.val', sl);
    r.value = S.cloneBrush[k]; v.value = S.cloneBrush[k];
    const ap = x => { S.cloneBrush[k] = +x; r.value = x; v.value = x; };
    r.oninput = () => ap(r.value); v.onchange = () => ap(clamp(parseFloat(v.value) || 1, +r.min, +r.max));
  }
  $('#cloneClearBtn').onclick = async e => { e.stopPropagation(); if (!S.edits.clone.strokes.length) return; S.edits.clone.strokes = []; S.cloneSource = null; $('#clonesource').style.display = 'none'; cloneCanvas = null; await syncClone(); maybeUseCleanTexture(); commit('Clone: cleared'); requestRender(); };
}
function healStatus(text) { const el = $('#healStatus'); if (el) { el.textContent = text; el.classList.toggle('on', text !== 'Ready'); } }
/** Rebuild the paint-out mask canvas (image space, full preview resolution) from the stroke list. */
function healCanvasBuild(rebuild = false) {
  const w = origPreview.width, h = origPreview.height;
  if (!healCanvas || healCanvas.width !== w || healCanvas.height !== h) { healCanvas = document.createElement('canvas'); healCanvas.width = w; healCanvas.height = h; rebuild = true; }
  if (rebuild) { const g = healCanvas.getContext('2d'); g.clearRect(0, 0, w, h); g.fillStyle = '#000'; g.fillRect(0, 0, w, h); for (const s of S.edits.heal.strokes) for (const p of s.pts) dab(g, p[0], p[1], s, w, h); }
  return healCanvas;
}
function healDab(ux, uy, start) {
  const c = healCanvasBuild(); const g = c.getContext('2d'); const w = c.width, h = c.height;
  if (start) { curHealStroke = { size: S.healBrush.size, feather: S.healBrush.feather, flow: 100, erase: false, pts: [] }; S.edits.heal.strokes.push(curHealStroke); }
  const lastP = curHealStroke.pts[curHealStroke.pts.length - 1]; const step = S.healBrush.size / 100 * 0.25;
  if (lastP && Math.hypot(ux - lastP[0], (uy - lastP[1]) * h / w) < step) return;
  if (lastP) { const n = Math.ceil(Math.hypot(ux - lastP[0], (uy - lastP[1]) * h / w) / step); for (let i = 1; i <= n; i++) { const p = [lastP[0] + (ux - lastP[0]) * i / n, lastP[1] + (uy - lastP[1]) * i / n]; curHealStroke.pts.push(p); dab(g, p[0], p[1], curHealStroke, w, h); } }
  else { curHealStroke.pts.push([ux, uy]); dab(g, ux, uy, curHealStroke, w, h); }
  engine.setMaskTexture('__heal__', c); requestRender(); // live red preview only — nothing is actually inpainted until the brush lifts
}
/** Send the current heal mask to the backend and swap the engine source for the result.
 *  No-op (and skips the network round-trip) if the stroke list hasn't changed since the last call. */
async function syncHeal(busy) {
  const sig = JSON.stringify(S.edits.heal.strokes);
  if (sig === healAppliedSig) return;
  if (!S.edits.heal.strokes.length) {
    previewImg = origPreview; healedPreview = previewImg; engine.setImage(previewImg, true); await rebuildMaskTextures(); await ensureDenoise(); healAppliedSig = sig; healStatus('Ready'); return;
  }
  if (busy) { $('#spinner').style.display = 'block'; healStatus('Healing…'); }
  S.healBusy = true;
  try {
    const c = healCanvasBuild(true);
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    const fd = new FormData(); fd.append('mask', blob, 'mask.png');
    const r = await fetch(`/api/image/${S.activeId}/inpaint?res=preview`, { method: 'POST', body: fd });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'Inpainting failed');
    const healed = await loadImg(URL.createObjectURL(await r.blob()));
    previewImg = healed; healedPreview = previewImg; engine.setImage(previewImg, true); await rebuildMaskTextures(); await ensureDenoise(); healAppliedSig = sig; healStatus('Ready');
  } catch (e) { toast(e.message); healStatus('Error — try again'); }
  S.healBusy = false; if (busy) $('#spinner').style.display = 'none';
}
function cloneStatus(text) { const el = $('#cloneStatus'); if (el) el.textContent = text; }
/** Rebuild the clone-stamp working canvas (image space, full preview
 *  resolution) from the stroke list, drawn on top of whatever previewImg
 *  currently holds (already reflects heal, if any — see syncClone()). */
function cloneCanvasBuild(rebuild = false) {
  const w = origPreview.width, h = origPreview.height;
  if (!cloneCanvas || cloneCanvas.width !== w || cloneCanvas.height !== h) { cloneCanvas = document.createElement('canvas'); cloneCanvas.width = w; cloneCanvas.height = h; rebuild = true; }
  if (rebuild) {
    const g = cloneCanvas.getContext('2d');
    g.clearRect(0, 0, w, h); g.drawImage(healedPreview, 0, 0, w, h);
    for (const s of S.edits.clone.strokes) for (const p of s.pts) cloneStamp(cloneCanvas, healedPreview, p, s, w, h);
  }
  return cloneCanvas;
}
/** Composite one dab of source pixels onto `dst`, sampled from `src`
 *  and translated by the stroke's fixed offset (source point minus the
 *  stroke's first painted point — the "aligned" clone-stamp offset),
 *  masked through the same feathered brush shape dab() already draws
 *  for heal/mask strokes.
 *
 *  dab() always resets globalCompositeOperation to 'source-over' before
 *  it draws (see dab()'s own body), so it can't be used directly as a
 *  'destination-in' mask on the same context we're compositing onto —
 *  it has to build the mask on its OWN scratch canvas first, and only
 *  then use that finished mask to clip a second scratch canvas holding
 *  the translated source pixels, before compositing the result onto
 *  `dst`. Two reused scratch canvases (not reallocated per dab) keep
 *  this cheap during a fast paint drag. */
let _cloneMaskScratch = null, _clonePatchScratch = null;
function cloneStamp(dst, src, p, s, w, h) {
  if (!_cloneMaskScratch || _cloneMaskScratch.width !== w || _cloneMaskScratch.height !== h) {
    _cloneMaskScratch = document.createElement('canvas'); _cloneMaskScratch.width = w; _cloneMaskScratch.height = h;
    _clonePatchScratch = document.createElement('canvas'); _clonePatchScratch.width = w; _clonePatchScratch.height = h;
  }
  const mg = _cloneMaskScratch.getContext('2d'); mg.clearRect(0, 0, w, h); dab(mg, p[0], p[1], s, w, h);
  const offX = (s.source[0] - s.pts[0][0]) * w, offY = (s.source[1] - s.pts[0][1]) * h;
  const pg = _clonePatchScratch.getContext('2d'); pg.clearRect(0, 0, w, h); pg.globalCompositeOperation = 'source-over';
  pg.drawImage(src, -offX, -offY, w, h);
  pg.globalCompositeOperation = 'destination-in'; pg.drawImage(_cloneMaskScratch, 0, 0);
  const g = dst.getContext('2d'); g.globalCompositeOperation = 'source-over'; g.drawImage(_clonePatchScratch, 0, 0);
}
/** Paint one dab of the clone-stamp brush at image-UV point (ux, uy).
 *  start=true begins a new stroke (requires S.cloneSource to already be
 *  set via Alt-click — Task 2's job — otherwise this is a no-op with a
 *  status hint). Mirrors healDab()'s interpolated-stepping shape. */
function cloneDab(ux, uy, start) {
  if (start) {
    if (!S.cloneSource) { curCloneStroke = null; cloneStatus('Alt-click to set a source point'); return; }
    curCloneStroke = { size: S.cloneBrush.size, feather: S.cloneBrush.feather, flow: S.cloneBrush.flow, source: S.cloneSource, erase: false, pts: [] };
    S.edits.clone.strokes.push(curCloneStroke);
  }
  if (!curCloneStroke) return;
  const c = cloneCanvasBuild(); const w = c.width, h = c.height;
  const lastP = curCloneStroke.pts[curCloneStroke.pts.length - 1]; const step = curCloneStroke.size / 100 * 0.25;
  if (lastP && Math.hypot(ux - lastP[0], (uy - lastP[1]) * h / w) < step) return;
  if (lastP) { const n = Math.ceil(Math.hypot(ux - lastP[0], (uy - lastP[1]) * h / w) / step); for (let i = 1; i <= n; i++) { const p = [lastP[0] + (ux - lastP[0]) * i / n, lastP[1] + (uy - lastP[1]) * i / n]; curCloneStroke.pts.push(p); cloneStamp(c, healedPreview, p, curCloneStroke, w, h); } }
  else { curCloneStroke.pts.push([ux, uy]); cloneStamp(c, healedPreview, [ux, uy], curCloneStroke, w, h); }
  engine.setImage(c, true); requestRender();
  cloneStatus('Cloning…');
}
/** Apply S.edits.clone.strokes on top of the current previewImg (which
 *  already reflects heal, if any — call this AFTER syncHeal() resolves,
 *  never before). Synchronous, unlike syncHeal() — no network call. */
async function syncClone() {
  if (!S.edits.clone.strokes.length) { cloneCanvas = null; previewImg = healedPreview; engine.setImage(previewImg, true); await rebuildMaskTextures(); await ensureDenoise(); cloneStatus('Ready'); return; }
  previewImg = cloneCanvasBuild(true); engine.setImage(previewImg, true); await rebuildMaskTextures(); await ensureDenoise();
  cloneStatus('Ready');
}
/** Build the two-channel refine canvas for a mask: R = painted-in (add), G = painted-out (subtract). */
function refineCanvasBuild(m, rebuild = false, w = engine.w, h = engine.h) {
  let c = refineCanvases.get(m.id);
  if (!c || c.width !== w || c.height !== h) { c = document.createElement('canvas'); c.width = w; c.height = h; refineCanvases.set(m.id, c); rebuild = true; }
  if (rebuild) { const g = c.getContext('2d'); g.clearRect(0, 0, w, h); g.globalCompositeOperation = 'lighter'; for (const s of m.refine.strokes) for (const p of s.pts) dabRG(g, p[0], p[1], s, w, h); }
  return c;
}
function dabRG(g, ux, uy, s, w, h) {
  const r = s.size / 100 * w; const x = ux * w, y = uy * h;
  const grd = g.createRadialGradient(x, y, r * (1 - s.feather / 100), x, y, r);
  const col = s.mode === 'subtract' ? '0,255,0' : '255,0,0';
  grd.addColorStop(0, `rgba(${col},0.35)`); grd.addColorStop(1, `rgba(${col},0)`);
  g.globalCompositeOperation = 'lighter'; g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
}
function refineDab(ux, uy, start) {
  const m = S.activeMask; const c = refineCanvasBuild(m); const g = c.getContext('2d'); const w = c.width, h = c.height;
  if (start) { curRefineStroke = { mode: S.refineMode, size: S.refineBrush.size, feather: S.refineBrush.feather, pts: [] }; m.refine.strokes.push(curRefineStroke); }
  const lastP = curRefineStroke.pts[curRefineStroke.pts.length - 1]; const step = S.refineBrush.size / 100 * 0.25;
  if (lastP && Math.hypot(ux - lastP[0], (uy - lastP[1]) * h / w) < step) return;
  if (lastP) { const n = Math.ceil(Math.hypot(ux - lastP[0], (uy - lastP[1]) * h / w) / step); for (let i = 1; i <= n; i++) { const p = [lastP[0] + (ux - lastP[0]) * i / n, lastP[1] + (uy - lastP[1]) * i / n]; curRefineStroke.pts.push(p); dabRG(g, p[0], p[1], curRefineStroke, w, h); } }
  else { curRefineStroke.pts.push([ux, uy]); dabRG(g, ux, uy, curRefineStroke, w, h); }
  engine.setMaskTexture(m.id + '_refine', c); requestRender();
}
async function addMask(kind, init) {
  if (!previewImg) return;
  const m = { id: uid(), type: kind, name: kind[0].toUpperCase() + kind.slice(1), enabled: true, invert: false, amount: 100, params: {}, adj: MASK_ADJ(), refine: { strokes: [] } };
  if (kind === 'linear') { m.params = { x0: 0.5, y0: 0.2, x1: 0.5, y1: 0.6 }; m.pending = true; toast('Drag on the photo to place the gradient'); }
  if (kind === 'radial') { m.params = { cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.2, angle: 0, feather: 50 }; m.pending = true; toast('Drag from the centre outwards (Shift for an ellipse)'); }
  if (kind === 'brush') { m.params = { strokes: [] }; toast('Paint on the photo · scroll to resize · Alt to erase'); }
  if (kind === 'range') { m.name = 'Luminance'; m.range = { enabled: true, lo: 60, hi: 100, smooth: 20 }; }
  if (kind === 'color') { m.type = 'range'; m.name = 'Colour'; m.colorRange = { enabled: true, h: 0, s: 50, v: 50, tol: 30 }; S.colorPicking = true; glCanvas.classList.add('pick'); toast('Click a colour in the photo'); }
  if (['subject', 'sky', 'background', 'people'].includes(kind)) { m.type = 'ai'; m.params = { kind }; m.name = kind === 'sky' ? 'Sky' : kind[0].toUpperCase() + kind.slice(1) + ' (AI)'; $('#spinner').style.display = 'block'; try { await loadAiMask(m); } catch (e) { toast(e.message); $('#spinner').style.display = 'none'; return; } $('#spinner').style.display = 'none'; }
  if (init) { if (init.name) m.name = init.name; Object.assign(m.adj, init.adj || {}); }
  S.edits.masks.push(m); S.activeMask = m; S.refineMode = null; setTool('mask'); renderMaskList(); syncMaskEditor(); if (!m.pending && m.type !== 'brush') commit('Mask added'); requestRender();
}
const maskAlphaImages = new Map(); // mask.id -> HTMLImageElement, kept for sky masks only (auto light-match sampling)
async function loadAiMask(m) {
  const r = await fetch(`/api/image/${S.activeId}/aimask?kind=${m.params.kind}&quality=${m.params.quality || 'standard'}`, { method: 'POST' }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'AI mask failed');
  const img = await loadImg(URL.createObjectURL(await r.blob())); engine.setMaskTexture(m.id, img);
  if (m.params.kind === 'sky') maskAlphaImages.set(m.id, img);
}
/** Fetch the AI-denoised preview for the active photo, once, and bind it as a GPU texture.
    Safe to call repeatedly: a no-op once `engine.denoised` is already set for the current image
    (which `engine.setImage` always resets to null, so this re-fetches after any photo/heal change —
    cheaply, since the backend caches the result by iid+mtime+res). */
async function ensureDenoise() {
  if (S.edits.presence.denoise <= 0 || engine.denoised || !S.activeId) return;
  if (S.edits.heal.strokes.length > 0 || S.edits.clone.strokes.length > 0) { toast('AI denoise unavailable while object removal or clone stamp is active on this photo'); return; }
  const id = S.activeId;
  if (denoisePending && denoisePending.id === id) return denoisePending.promise;
  $('#spinner').style.display = 'block';
  const promise = (async () => {
    try {
      const r = await fetch(`/api/image/${id}/denoise?res=preview`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'AI denoise failed');
      const sigma = +r.headers.get('X-Noise-Sigma') || 0;
      const img = await loadImg(URL.createObjectURL(await r.blob()));
      if (S.activeId !== id) return; // user switched photos while this was in flight
      engine.setDenoised(img, sigma);
    } catch (e) {
      toast(e.message);
      setPath(S.edits, 'presence.denoise', 0);
      syncUI();
      commit('AI denoise: reset to 0');
    }
    requestRender();
  })();
  denoisePending = { id, promise };
  try { await promise; } finally { if (denoisePending && denoisePending.id === id) { denoisePending = null; $('#spinner').style.display = 'none'; } }
}
async function rebuildMaskTextures() {
  for (const m of S.edits.masks) {
    if (m.autoSkyMatch) { /* mirrors its companion sky mask's alpha — synced below, not re-detected */ }
    else if (m.type === 'brush') { const c = brushCanvas(m, true); engine.setMaskTexture(m.id, c); } else if (m.type === 'ai') { try { await loadAiMask(m); } catch (e) { toast(e.message); } }
    if (m.sky?.assetId && !engine.skyTextures.has(m.sky.assetId)) { try { const img = await loadImg(`/api/skies/${m.sky.assetId}?res=full`); engine.setSkyTexture(m.sky.assetId, img); } catch (e) { toast('Could not load sky: ' + e.message); } }
    if (m.refine?.strokes?.length) engine.setMaskTexture(m.id + '_refine', refineCanvasBuild(m, true));
  }
  const am = S.edits.masks.find(x => x.autoSkyMatch);
  if (am) {
    const srcId = am.mirrorId || S.edits.masks.find(x => x.type === 'ai' && x.params?.kind === 'sky' && !x.autoSkyMatch && x.sky?.autoMatch)?.id;
    const src = srcId && maskAlphaImages.get(srcId);
    if (src) engine.setMaskTexture(am.id, src);
  }
}
function brushCanvas(m, rebuild = false, w = engine.w, h = engine.h) {
  let c = maskCanvases.get(m.id); if (!c || c.width !== w || c.height !== h) { c = document.createElement('canvas'); c.width = w; c.height = h; maskCanvases.set(m.id, c); rebuild = true; }
  if (rebuild) { const g = c.getContext('2d'); g.clearRect(0, 0, w, h); g.fillStyle = '#000'; g.fillRect(0, 0, w, h); for (const s of m.params.strokes) for (const p of s.pts) dab(g, p[0], p[1], s, w, h); }
  return c;
}
function dab(g, ux, uy, s, w, h) {
  const r = s.size / 100 * w; const x = ux * w, y = uy * h; const grd = g.createRadialGradient(x, y, r * (1 - s.feather / 100), x, y, r);
  const a = s.flow / 100; grd.addColorStop(0, s.erase ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a})`); grd.addColorStop(1, s.erase ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0)');
  g.globalCompositeOperation = 'source-over'; g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
}
let curStroke = null;
function brushDab(ux, uy, start) {
  const m = S.activeMask; const c = brushCanvas(m); const g = c.getContext('2d');
  if (start) { curStroke = { size: S.brush.size, feather: S.brush.feather, flow: S.brush.flow * 0.35, erase: S.brush.erase, pts: [] }; m.params.strokes.push(curStroke); }
  const lastP = curStroke.pts[curStroke.pts.length - 1]; const step = S.brush.size / 100 * 0.25;
  if (lastP && Math.hypot(ux - lastP[0], (uy - lastP[1]) * engine.h / engine.w) < step) return;
  if (lastP) { const n = Math.ceil(Math.hypot(ux - lastP[0], (uy - lastP[1]) * engine.h / engine.w) / step); for (let i = 1; i <= n; i++) { const p = [lastP[0] + (ux - lastP[0]) * i / n, lastP[1] + (uy - lastP[1]) * i / n]; curStroke.pts.push(p); dab(g, p[0], p[1], curStroke, c.width, c.height); } }
  else { curStroke.pts.push([ux, uy]); dab(g, ux, uy, curStroke, c.width, c.height); }
  engine.setMaskTexture(m.id, c); requestRender();
}
function renderMaskList() {
  const l = $('#maskList'); l.innerHTML = '';
  for (const m of S.edits.masks) {
    const d = document.createElement('div'); d.className = 'maskitem' + (m === S.activeMask ? ' on' : ''); d.innerHTML = `<input type="checkbox" ${m.enabled !== false ? 'checked' : ''} title="Enable"><span class="sw"></span><span class="nm">${esc(m.name)}</span><span class="x" title="Delete">×</span>`;
    d.onclick = e => { if (e.target.type === 'checkbox') { m.enabled = e.target.checked; commit('Mask ' + (m.enabled ? 'on' : 'off')); requestRender(); return; } if (e.target.classList.contains('x')) { S.edits.masks = S.edits.masks.filter(x => x !== m); if (m.type === 'ai' && m.params?.kind === 'sky' && !m.autoSkyMatch) S.edits.masks = S.edits.masks.filter(x => !x.autoSkyMatch); if (S.activeMask === m) { S.activeMask = null; S.refineMode = null; } commit('Mask deleted'); renderMaskList(); syncMaskEditor(); requestRender(); return; } S.activeMask = m; S.refineMode = null; setTool('mask'); renderMaskList(); syncMaskEditor(); requestRender(); };
    $('.nm', d).ondblclick = () => askName('Rename mask', 'Name', m.name, n => { m.name = n; renderMaskList(); commit('Mask renamed'); });
    l.append(d);
  }
}
function syncMaskEditor() {
  const m = S.activeMask; $('#maskEditor').classList.toggle('hidden', !m); if (!m) return;
  $$('#maskEditor .sl[data-mask]').forEach(sl => { const v = getPath(m, sl.dataset.mask) ?? +sl.dataset.def; $('input[type=range]', sl).value = v; $('.val', sl).value = fmtVal(+v, sl.dataset.step); sl.classList.toggle('changed', +v !== +sl.dataset.def); });
  $('#maskInvert').checked = !!m.invert; $('#maskRangeOn').checked = !!m.range?.enabled; $('#maskRangeSliders').classList.toggle('hidden', !m.range?.enabled);
  syncRefineButtons();
  for (const [id, k] of [['refSize', 'size'], ['refFeather', 'feather']]) { const sl = $('#' + id); if (sl) { $('input[type=range]', sl).value = S.refineBrush[k]; $('.val', sl).value = S.refineBrush[k]; } }
  $('#refClear').disabled = !m.refine.strokes.length;
  const g = $('#maskGeom'); g.innerHTML = '';
  if (m.type === 'brush') { g.innerHTML = `<div class="subhead">Brush</div><div class="brushbar"><span class="seg"><button id="bPaint" class="${S.brush.erase ? '' : 'on'}">Paint</button><button id="bErase" class="${S.brush.erase ? 'on' : ''}">Erase</button></span><button class="chip" id="bClear">Clear strokes</button></div>
    <div class="sl" id="bSize"><label>Size</label><input class="val"><input type="range" min="0.5" max="60" step="0.5"></div><div class="sl" id="bFeather"><label>Feather</label><input class="val"><input type="range" min="0" max="100" step="1"></div><div class="sl" id="bFlow"><label>Flow</label><input class="val"><input type="range" min="1" max="100" step="1"></div>`;
    $('#bPaint').onclick = () => { S.brush.erase = false; syncMaskEditor(); }; $('#bErase').onclick = () => { S.brush.erase = true; syncMaskEditor(); }; $('#bClear').onclick = () => { m.params.strokes = []; engine.setMaskTexture(m.id, brushCanvas(m, true)); commit('Brush cleared'); requestRender(); };
    for (const [id, k] of [['bSize', 'size'], ['bFeather', 'feather'], ['bFlow', 'flow']]) { const sl = $('#' + id), r = $('input[type=range]', sl), v = $('.val', sl); r.value = S.brush[k]; v.value = S.brush[k]; r.oninput = () => { S.brush[k] = +r.value; v.value = r.value; }; }
  }
  if (m.type === 'radial') { g.innerHTML = `<div class="subhead">Shape</div><div class="sl" data-g="feather" data-min="0" data-max="100" data-step="1"><label>Feather</label><input class="val"><input type="range"></div><div class="sl" data-g="angle" data-min="-90" data-max="90" data-step="1"><label>Rotate</label><input class="val"><input type="range"></div><div class="sl" data-g="rx" data-min="0.01" data-max="1" data-step="0.01"><label>Width</label><input class="val"><input type="range"></div><div class="sl" data-g="ry" data-min="0.01" data-max="1" data-step="0.01"><label>Height</label><input class="val"><input type="range"></div>`; }
  if (m.colorRange) { g.innerHTML = `<div class="subhead">Colour range</div><div class="row"><button class="chip" id="cPick">Pick colour</button><span class="chip" style="background:hsl(${+m.colorRange.h || 0},${+m.colorRange.s || 0}%,${(+m.colorRange.v || 0) / 2}%)">&nbsp;&nbsp;&nbsp;</span></div><div class="sl" data-g="colorRange.tol" data-min="1" data-max="100" data-step="1"><label>Tolerance</label><input class="val"><input type="range"></div>`; $('#cPick').onclick = () => { S.colorPicking = true; glCanvas.classList.add('pick'); }; }
  if (m.type === 'ai' && m.params?.kind === 'sky' && !m.autoSkyMatch) {
    let html = `<div class="subhead">Sky look</div><div class="row" style="flex-wrap:wrap;gap:6px">${SKY_LOOKS.map((s, i) => `<button class="chip" data-sky="${i}">${s.name}</button>`).join('')}</div>`;
    html += `<div class="subhead">Replace sky</div>`;
    if (!S.skyLibrary) { html += `<div class="hint">Loading sky library…</div>`; ensureSkyLibrary().then(() => { if (S.activeMask === m) syncMaskEditor(); }); }
    else html += `<div class="skygrid">${S.skyLibrary.map(s => `<img class="skythumb${m.sky?.assetId === s.id ? ' on' : ''}" data-skyid="${esc(s.id)}" title="${esc(s.name)}" src="/api/skies/${encodeURIComponent(s.id)}?res=thumb" loading="lazy">`).join('')}</div>`;
    g.innerHTML = html;
    $$('[data-sky]', g).forEach(b => b.onclick = () => { const look = SKY_LOOKS[+b.dataset.sky]; m.adj = { ...MASK_ADJ(), ...look.adj }; syncMaskEditor(); commit('Sky look: ' + look.name); requestRender(); });
    $$('[data-skyid]', g).forEach(img => img.onclick = () => pickSky(m, img.dataset.skyid));
    if (m.sky) {
      g.insertAdjacentHTML('beforeend', `<div class="sl" data-g="sky.scale" data-min="50" data-max="200" data-step="1"><label>Scale</label><input class="val"><input type="range"></div>
        <div class="sl" data-g="sky.offsetX" data-min="-100" data-max="100" data-step="1"><label>Position X</label><input class="val"><input type="range"></div>
        <div class="sl" data-g="sky.offsetY" data-min="-100" data-max="100" data-step="1"><label>Position Y</label><input class="val"><input type="range"></div>
        <div class="row"><label class="chip"><input type="checkbox" id="skyFlip" ${m.sky.flipH ? 'checked' : ''}> Flip</label>
        <label class="chip"><input type="checkbox" id="skyAutoMatch" ${m.sky.autoMatch ? 'checked' : ''}> Auto match light</label></div>
        <button class="chip" id="skyRemove">Remove replacement</button>`);
      $('#skyFlip').onclick = e => { m.sky.flipH = e.target.checked; commit('Sky flip'); requestRender(); };
      $('#skyAutoMatch').onclick = async e => { m.sky.autoMatch = e.target.checked; if (m.sky.autoMatch) await applySkyMatch(m); else removeSkyMatchMask(); syncMaskEditor(); commit('Auto match light: ' + (m.sky.autoMatch ? 'on' : 'off')); requestRender(); };
      $('#skyRemove').onclick = () => { m.sky = null; removeSkyMatchMask(); renderMaskList(); syncMaskEditor(); commit('Sky replacement removed'); requestRender(); };
    }
  }
  if (m.type === 'ai' && m.params.kind !== 'sky') {
    const hq = m.params.quality === 'hq';
    g.insertAdjacentHTML('afterbegin', `<div class="row"><label class="chip" title="BiRefNet: the most precise cut-out for hair, fur and feathers. Downloads ~1 GB the first time; much faster with the GPU (./run.sh --with-ai-gpu)."><input type="checkbox" id="maskHq" ${hq ? 'checked' : ''}> High quality edges (BiRefNet)</label></div>`);
    $('#maskHq').onchange = async e => {
      m.params.quality = e.target.checked ? 'hq' : 'standard';
      $('#spinner').style.display = 'block'; status(e.target.checked ? 'Computing high-quality mask (first time downloads ~1 GB)\u2026' : '');
      try { await loadAiMask(m); commit('Mask quality: ' + (e.target.checked ? 'high' : 'standard')); }
      catch (err) { toast(err.message); m.params.quality = 'standard'; e.target.checked = false; }
      $('#spinner').style.display = 'none'; status(''); requestRender();
    };
  }
  if (m.type === 'ai') {
    // AI masks come from a low-resolution model: let the user pull the edge in
    // (so a sky stops eating a ridge) or out, and soften the transition.
    if (!m.edge) m.edge = { shift: 0, soft: 0 };
    g.insertAdjacentHTML('afterbegin', `<div class="subhead">Edge</div>
      <div class="sl" data-g="edge.shift" data-min="-100" data-max="100" data-step="1" title="Negative pulls the mask's edge in, positive pushes it out"><label>Contract · Expand</label><input class="val"><input type="range"></div>
      <div class="sl" data-g="edge.soft" data-min="0" data-max="100" data-step="1" title="Blend the mask's edge more gradually"><label>Soften edge</label><input class="val"><input type="range"></div>`);
  }
  $$('.sl[data-g]', g).forEach(sl => { const rng = $('input[type=range]', sl), val = $('.val', sl); rng.min = sl.dataset.min; rng.max = sl.dataset.max; rng.step = sl.dataset.step; const path = sl.dataset.g.includes('.') ? sl.dataset.g : 'params.' + sl.dataset.g; const v = getPath(m, path); rng.value = v; val.value = fmtVal(+v, sl.dataset.step);
    const ap = (x, f) => { setPath(m, path, +x); rng.value = x; val.value = fmtVal(+x, sl.dataset.step); requestRender(); if (f) commit('Mask shape'); }; rng.oninput = () => ap(rng.value, false); rng.onchange = () => ap(rng.value, true); val.onchange = () => ap(clamp(parseFloat(val.value) || 0, +rng.min, +rng.max), true); });
  if (m.type === 'brush') glCanvas.classList.add('brush'); else glCanvas.classList.remove('brush');
}
async function ensureSkyLibrary() {
  if (S.skyLibrary) return;
  try { S.skyLibrary = await api.get('/api/skies'); } catch (e) { toast('Could not load sky library: ' + e.message); S.skyLibrary = []; }
}
async function pickSky(m, assetId) {
  const prevSky = m.sky ? deepClone(m.sky) : null;
  m.sky = { assetId, scale: 100, offsetX: 0, offsetY: 0, flipH: false, autoMatch: true };
  syncMaskEditor();
  try {
    const img = await loadImg(`/api/skies/${assetId}?res=full`);
    engine.setSkyTexture(assetId, img);
    if (m.sky.autoMatch) await applySkyMatch(m);
    commit('Sky replaced'); requestRender();
  } catch (e) { toast('Could not load sky image: ' + e.message); m.sky = prevSky; syncMaskEditor(); }
}
/** Client-side heuristic: nudge the foreground's WB/exposure toward what the
 *  new sky implies, by comparing the new sky's average colour against the old
 *  sky's average colour (sampled from the current photo, weighted by the sky
 *  mask's own alpha). Writes the result into a second, auto-managed, inverted
 *  copy of the sky mask — a completely ordinary mask afterward, editable like
 *  any other. Mirrors the sign convention of the existing WB-from-colour
 *  helper `applyNeutral()` above, just applied to a colour delta instead of
 *  an absolute cast. */
async function applySkyMatch(m) {
  const alphaImg = maskAlphaImages.get(m.id);
  if (!alphaImg || !previewImg) return;
  const n = 64;
  const ac = document.createElement('canvas'); ac.width = n; ac.height = n;
  ac.getContext('2d').drawImage(alphaImg, 0, 0, n, n);
  const alpha = ac.getContext('2d').getImageData(0, 0, n, n).data;
  const pc = document.createElement('canvas'); pc.width = n; pc.height = n;
  pc.getContext('2d').drawImage(previewImg, 0, 0, n, n);
  const px = pc.getContext('2d').getImageData(0, 0, n, n).data;
  let wsum = 0, or = 0, og = 0, ob = 0;
  for (let i = 0; i < n * n; i++) { const w = alpha[i * 4] / 255; wsum += w; or += px[i * 4] * w; og += px[i * 4 + 1] * w; ob += px[i * 4 + 2] * w; }
  if (wsum < n * n * 0.02) { removeSkyMatchMask(); return; } // not enough sky sampled — skip rather than guess from noise
  const oldSky = [or / wsum, og / wsum, ob / wsum];

  const skyImg = await loadImg(`/api/skies/${m.sky.assetId}?res=thumb`);
  const sc = document.createElement('canvas'); sc.width = n; sc.height = n;
  sc.getContext('2d').drawImage(skyImg, 0, 0, n, n);
  const spx = sc.getContext('2d').getImageData(0, 0, n, n).data;
  let sr = 0, sg = 0, sb = 0;
  for (let i = 0; i < n * n; i++) { sr += spx[i * 4]; sg += spx[i * 4 + 1]; sb += spx[i * 4 + 2]; }
  const newSky = [sr / (n * n), sg / (n * n), sb / (n * n)];

  const dR = newSky[0] - oldSky[0], dG = newSky[1] - oldSky[1], dB = newSky[2] - oldSky[2];
  const avg = Math.max((oldSky[0] + oldSky[1] + oldSky[2]) / 3, 1);
  const temp = clamp(((dB - dR) / avg) * 110 * 0.35, -40, 40);
  const tint = clamp((((dR + dB) / 2 - dG) / avg) * 180 * 0.35, -40, 40);
  const dLum = (dR * 0.2126 + dG * 0.7152 + dB * 0.0722) / 255;
  const exposure = clamp(dLum * 1.2 * 0.35, -0.6, 0.6);

  let am = S.edits.masks.find(x => x.autoSkyMatch);
  if (!am) {
    am = { id: uid(), type: 'ai', name: 'Sky match (auto)', enabled: true, invert: true, amount: 100, params: { kind: 'sky' }, adj: MASK_ADJ(), refine: { strokes: [] }, autoSkyMatch: true };
    S.edits.masks.push(am); renderMaskList();
  }
  am.mirrorId = m.id; engine.setMaskTexture(am.id, alphaImg);
  am.adj = { ...MASK_ADJ(), temp, tint, exposure };
}
function removeSkyMatchMask() {
  const am = S.edits.masks.find(x => x.autoSkyMatch);
  if (am) { S.edits.masks = S.edits.masks.filter(x => x !== am); renderMaskList(); }
}
function syncBrushBar() { const sl = $('#bSize'); if (sl) { $('input[type=range]', sl).value = S.brush.size; $('.val', sl).value = S.brush.size.toFixed(1); } }

// ---------------------------------------------------------------------------
// tools & overlay (crop box, mask pins)
// ---------------------------------------------------------------------------
function setTool(t) {
  if (S.tool === 'crop' && t !== 'crop') { fitCropToBounds(); }
  S.tool = t; $$('.tools [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  $('#pCrop').classList.toggle('hidden', t !== 'crop'); $('#pMasks').classList.toggle('hidden', t !== 'mask'); $('#pHeal').classList.toggle('hidden', t !== 'heal'); $('#pClone').classList.toggle('hidden', t !== 'clone');
  if (t !== 'mask' && t !== 'heal' && t !== 'clone') { glCanvas.classList.remove('brush'); $('#brushcursor').style.display = 'none'; }
  glCanvas.classList.toggle('brush', t === 'heal' || t === 'clone');
  if (t !== 'mask') S.refineMode = null;
  if (t === 'crop') { S.zoom = 'fit'; S.pan = { x: 0, y: 0 }; }
  if (t !== 'clone') { S.cloneSource = null; $('#clonesource').style.display = 'none'; }
  $('#overlay').innerHTML = ''; delete $('#overlay').dataset.key; requestRender();
}
function buildAspects() {
  const list = [['original', 'Original'], ['free', 'Free'], ['1:1', '1 : 1'], ['4:5', '4 : 5'], ['5:7', '5 : 7'], ['2:3', '2 : 3'], ['16:9', '16 : 9']];
  $('#aspects').innerHTML = list.map(([v, l]) => `<button class="chip" data-v="${v}">${l}</button>`).join('');
  $('#aspects').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; setAspect(b.dataset.v); };
}
function aspectRatio(a) { const c = S.edits.crop; if (a === 'free') return null; if (a === 'original') return engine.w / engine.h; const [x, y] = a.split(':').map(Number); const r = x / y; return c.w * engine.w > c.h * engine.h ? Math.max(r, 1 / r) : Math.min(r, 1 / r); }
function setAspect(a) { const c = S.edits.crop; c.aspect = a; const r = aspectRatio(a); if (r) { const cx = c.x + c.w / 2, cy = c.y + c.h / 2; const curPx = c.w * engine.w, curPy = c.h * engine.h; let w = curPx, h = w / r; if (h > curPy) { h = curPy; w = h * r; } c.w = w / engine.w; c.h = h / engine.h; c.x = clamp(cx - c.w / 2, 0, 1 - c.w); c.y = clamp(cy - c.h / 2, 0, 1 - c.h); } fitCropToBounds(); syncUI(); commit('Aspect ' + a); requestRender(); }
function bindCrop() {
  $('#flipH').onclick = () => { S.edits.crop.flipH = !S.edits.crop.flipH; syncUI(); commit('Flip horizontal'); requestRender(); };
  $('#flipV').onclick = () => { S.edits.crop.flipV = !S.edits.crop.flipV; syncUI(); commit('Flip vertical'); requestRender(); };
  $('#rot90').onclick = () => { const c = S.edits.crop; c.angle = ((c.angle + 90 + 180) % 360) - 180; const r = 1 / ((c.w * engine.w) / (c.h * engine.h)); const cx = c.x + c.w / 2, cy = c.y + c.h / 2; let wpx = Math.min(engine.h, engine.w) * 0.9; c.w = wpx / engine.w; c.h = wpx / r / engine.h; if (c.h > 1) { c.h = 1; c.w = (engine.h * r) / engine.w; } c.x = clamp(cx - c.w / 2, 0, 1 - c.w); c.y = clamp(cy - c.h / 2, 0, 1 - c.h); c.aspect = 'free'; fitCropToBounds(); syncUI(); commit('Rotate 90°'); requestRender(); };
  $('#cropDone').onclick = () => setTool(null);
}
/** is a rect (in rotated-image uv) entirely inside the rotated source image? */
function rectInside(x, y, w, h) {
  const A = engine.w / engine.h, a = S.edits.crop.angle * Math.PI / 180;
  for (const [px, py] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) { let dx = (px - 0.5) * A, dy = py - 0.5; [dx, dy] = rot(dx, dy, a); const ux = 0.5 + dx / A, uy = 0.5 + dy; if (ux < -0.002 || ux > 1.002 || uy < -0.002 || uy > 1.002) return false; }
  return true;
}
function fitCropToBounds() {
  const c = S.edits.crop; if (rectInside(c.x, c.y, c.w, c.h)) return;
  const cx = c.x + c.w / 2, cy = c.y + c.h / 2; let lo = 0.05, hi = 1; for (let i = 0; i < 30; i++) { const s = (lo + hi) / 2; if (rectInside(cx - c.w * s / 2, cy - c.h * s / 2, c.w * s, c.h * s)) lo = s; else hi = s; }
  c.w *= lo; c.h *= lo; c.x = cx - c.w / 2; c.y = cy - c.h / 2;
}
function drawOverlay(v) { const o = $('#overlay'); if (S.tool === 'mask' && S.activeMask) { drawMaskOverlay(v); return; } delete o.dataset.key; if (S.tool === 'crop') drawCropOverlay(v); else o.innerHTML = ''; }
function drawCropOverlay(v = viewParams()) {
  const o = $('#overlay'); const c = S.edits.crop; const L = (v.x + c.x * v.sx) / v.dpr, T = (v.y + c.y * v.sy) / v.dpr, Wd = c.w * v.sx / v.dpr, Hd = c.h * v.sy / v.dpr;
  let box = $('.cropbox', o); if (!box) { o.innerHTML = '<div class="cropbox"></div>' + ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(h => `<div class="handle" data-h="${h}"></div>`).join(''); box = $('.cropbox', o); bindCropHandles(); }
  Object.assign(box.style, { left: L + 'px', top: T + 'px', width: Wd + 'px', height: Hd + 'px' });
  const P = { nw: [L, T], n: [L + Wd / 2, T], ne: [L + Wd, T], e: [L + Wd, T + Hd / 2], se: [L + Wd, T + Hd], s: [L + Wd / 2, T + Hd], sw: [L, T + Hd], w: [L, T + Hd / 2] };
  $$('.handle', o).forEach(h => { const [x, y] = P[h.dataset.h]; h.style.left = x + 'px'; h.style.top = y + 'px'; h.style.cursor = h.dataset.h + '-resize'; });
}
function bindCropHandles() {
  const o = $('#overlay'); let drag = null;
  const down = e => { const v = viewParams(); drag = { h: e.target.dataset.h || 'move', sx: e.clientX, sy: e.clientY, c: { ...S.edits.crop }, v }; e.target.setPointerCapture(e.pointerId); e.stopPropagation(); };
  const move = e => {
    if (!drag) return; const { h, c: c0, v } = drag; const c = S.edits.crop; const dx = (e.clientX - drag.sx) * v.dpr / v.sx, dy = (e.clientY - drag.sy) * v.dpr / v.sy; const r = aspectRatio(c.aspect); const A = engine.w / engine.h;
    let { x, y, w, hh } = { x: c0.x, y: c0.y, w: c0.w, hh: c0.h };
    if (h === 'move') { x = c0.x + dx; y = c0.y + dy; }
    else { if (h.includes('e')) w = c0.w + dx; if (h.includes('s')) hh = c0.h + dy; if (h.includes('w')) { w = c0.w - dx; x = c0.x + dx; } if (h.includes('n')) { hh = c0.h - dy; y = c0.y + dy; }
      if (r) { const byW = h === 'n' || h === 's' ? false : true; if (byW) { hh = (w * engine.w / r) / engine.h; if (h.includes('n')) y = c0.y + c0.h - hh; } else { w = (hh * engine.h * r) / engine.w; if (h.includes('w')) x = c0.x + c0.w - w; } } }
    w = clamp(w, 0.02, 1); hh = clamp(hh, 0.02, 1);
    const cand = { x, y, w, h: hh }; if (!rectInside(cand.x, cand.y, cand.w, cand.h)) { if (h === 'move') { x = clamp(x, 0, 1 - w); y = clamp(y, 0, 1 - hh); if (!rectInside(x, y, w, hh)) return; } else return; }
    Object.assign(c, { x, y, w, h: hh }); requestRender();
  };
  const up = () => { if (drag) { drag = null; commit('Crop'); } };
  $$('.handle,.cropbox', o).forEach(el => { el.onpointerdown = down; el.onpointermove = move; el.onpointerup = up; });
}
function drawMaskOverlay(v) {
  // The overlay is redrawn on every render, including the renders a handle drag itself
  // triggers. Rebuilding it with innerHTML destroyed the handle under the pointer, which
  // dropped its pointer capture after the first move — so a gradient could never be
  // dragged anywhere. Build the handles once per mask/type and only move them after.
  const o = $('#overlay'); const m = S.activeMask;
  const key = m.pending ? '' : m.id + ':' + m.type;
  if (o.dataset.key !== key) {
    o.dataset.key = key; o.innerHTML = '';
    if (m.type === 'linear' && !m.pending) {
      o.innerHTML = '<div class="line"></div><div class="line l0"></div><div class="line l1"></div><div class="pin" data-p="0" title="Drag to set where the effect is full"></div><div class="pin" data-p="1" title="Drag to set where the effect fades out"></div><div class="pin on center" data-p="c" title="Drag to move the whole gradient"></div>';
      const p = () => S.activeMask.params;
      pinDrag($('.pin[data-p="0"]', o), (ux, uy) => { p().x0 = ux; p().y0 = uy; });
      pinDrag($('.pin[data-p="1"]', o), (ux, uy) => { p().x1 = ux; p().y1 = uy; });
      pinDrag($('.pin[data-p="c"]', o), (ux, uy, st) => { const q = p(); const dx = ux - st.ux, dy = uy - st.uy; q.x0 = st.p.x0 + dx; q.y0 = st.p.y0 + dy; q.x1 = st.p.x1 + dx; q.y1 = st.p.y1 + dy; });
    } else if (m.type === 'radial' && !m.pending) {
      o.innerHTML = '<div class="ell"></div><div class="pin on center" data-p="c" title="Drag to move"></div><div class="pin sm" data-p="rx" title="Drag to resize"></div><div class="pin sm" data-p="ry" title="Drag to resize"></div>';
      const p = () => S.activeMask.params;
      pinDrag($('.pin[data-p="c"]', o), (ux, uy, st) => { p().cx = st.p.cx + ux - st.ux; p().cy = st.p.cy + uy - st.uy; });
      // resize along the ellipse's own (rotated) axes; Shift keeps it round
      const resize = axis => (ux, uy, st, ev) => { const q = p(); const A = engine.w / engine.h; const a = ((q.angle || 0)) * Math.PI / 180; const dx = (ux - q.cx) * A, dy = uy - q.cy; const along = axis === 'rx' ? dx * Math.cos(a) + dy * Math.sin(a) : -dx * Math.sin(a) + dy * Math.cos(a); const r = Math.max(0.005, Math.abs(along)); if (ev.shiftKey) { q.rx = r / A; q.ry = r; } else if (axis === 'rx') q.rx = r / A; else q.ry = r; };
      pinDrag($('.pin[data-p="rx"]', o), resize('rx')); pinDrag($('.pin[data-p="ry"]', o), resize('ry'));
    }
  }
  if (!key) return;
  const p = m.params; const ang = S.edits.crop.angle;
  const place = (sel, x, y) => { const el = $(sel, o); if (el) { el.style.left = x + 'px'; el.style.top = y + 'px'; } };
  if (m.type === 'linear') {
    const [ax, ay] = imageToScreen(p.x0, p.y0, v), [bx, by] = imageToScreen(p.x1, p.y1, v);
    const len = Math.hypot(bx - ax, by - ay), rot = Math.atan2(by - ay, bx - ax);
    const line = (sel, x, y, w, r) => { const el = $(sel, o); el.style.left = x + 'px'; el.style.top = y + 'px'; el.style.width = w + 'px'; el.style.transform = `rotate(${r}rad)`; };
    line('.line:not(.l0):not(.l1)', ax, ay, len, rot);
    // the two guide lines perpendicular to the gradient, like Lightroom's
    const nx = -Math.sin(rot), ny = Math.cos(rot), L = 2000;
    line('.line.l0', ax - nx * L, ay - ny * L, 2 * L, rot + Math.PI / 2);
    line('.line.l1', bx - nx * L, by - ny * L, 2 * L, rot + Math.PI / 2);
    place('.pin[data-p="0"]', ax, ay); place('.pin[data-p="1"]', bx, by); place('.pin[data-p="c"]', (ax + bx) / 2, (ay + by) / 2);
  } else if (m.type === 'radial') {
    const [cx, cy] = imageToScreen(p.cx, p.cy, v); const rw = p.rx * v.sx / v.dpr / S.edits.crop.w, rh = p.ry * v.sy / v.dpr / S.edits.crop.h;
    const el = $('.ell', o); el.style.left = cx + 'px'; el.style.top = cy + 'px'; el.style.width = rw * 2 + 'px'; el.style.height = rh * 2 + 'px';
    const a = ((p.angle || 0) - ang) * Math.PI / 180; el.style.transform = `translate(-50%,-50%) rotate(${a}rad)`;
    place('.pin[data-p="c"]', cx, cy);
    place('.pin[data-p="rx"]', cx + rw * Math.cos(a), cy + rw * Math.sin(a));
    place('.pin[data-p="ry"]', cx - rh * Math.sin(a), cy + rh * Math.cos(a));
  }
}
function pinDrag(el, fn) {
  el.onpointerdown = e => {
    e.stopPropagation(); e.preventDefault(); el.setPointerCapture(e.pointerId);
    const at = ev => { const v = viewParams(); const r = glCanvas.getBoundingClientRect(); return screenToImage(ev.clientX - r.left, ev.clientY - r.top, v); };
    const [ux0, uy0] = at(e); const st = { ux: ux0, uy: uy0, p: { ...S.activeMask.params } }; let moved = false;
    el.onpointermove = ev => { moved = true; const [ux, uy] = at(ev); fn(ux, uy, st, ev); requestRender(); };
    el.onpointerup = el.onpointercancel = () => { el.onpointermove = null; el.onpointerup = el.onpointercancel = null; if (moved) commit('Mask moved'); };
  };
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------
function bindExport() {
  $('#exportBtn').onclick = () => { const n = targets().length; if (!n) return toast('Select photos to export'); $('#expCount').textContent = `${n} photo${n > 1 ? 's' : ''}`; $('#expDest').value = localStorage.getItem('mantiphy.expDest') || '~/Pictures/Mantiphy Export'; $('#expDestMode').value = localStorage.getItem('mantiphy.expDestMode') || 'folder'; $('#expSubOn').checked = localStorage.getItem('mantiphy.expSubOn') === '1'; $('#expSub').value = localStorage.getItem('mantiphy.expSub') || 'Edited'; $('#expExisting').value = localStorage.getItem('mantiphy.expExisting') || 'ask'; $('#expDpi').value = localStorage.getItem('mantiphy.expDpi') || ''; $('#expMeta').value = localStorage.getItem('mantiphy.expMeta') || 'copy'; $('#expKeywords').checked = localStorage.getItem('mantiphy.expKeywords') === '1'; $('#expCopyright').value = localStorage.getItem('mantiphy.expCopyright') || ''; paintExportDest(); $('#dlgExport').showModal(); };
  $('#expSub').oninput = paintExportDest;
  const syncNameTemplate = () => {
    // The -edited suffix only exists to avoid colliding with the original.
    // Landing in a subfolder already separates them, so drop it there.
    const beside = $('#expDestMode').value === 'source' && !$('#expSubOn').checked;
    if (beside && $('#expName').value.trim() === '{name}') $('#expName').value = '{name}-edited';
    else if (!beside && $('#expName').value.trim() === '{name}-edited') $('#expName').value = '{name}';
  };
  $('#expDestMode').onchange = () => { syncNameTemplate(); paintExportDest(); };
  $('#expSubOn').onchange = () => { syncNameTemplate(); paintExportDest(); };
  $('#expGo').onclick = async () => {
    $('#dlgExport').close(); const ids = targets(); const opts = { dest: $('#expDest').value, destMode: $('#expDestMode').value, subfolder: $('#expSubOn').checked ? ($('#expSub').value.trim() || 'Edited') : '', onExisting: $('#expExisting').value, fmt: $('#expFmt').value, quality: +$('#expQ').value, long_edge: +$('#expEdge').value || 0, sharpen: +$('#expSharp').value, dpi: +$('#expDpi').value || 0, metaMode: $('#expMeta').value, includeKeywords: $('#expKeywords').checked, copyright: $('#expCopyright').value, name: $('#expName').value || '{name}' }; localStorage.setItem('mantiphy.expDest', opts.dest); localStorage.setItem('mantiphy.expDestMode', opts.destMode); localStorage.setItem('mantiphy.expSubOn', $('#expSubOn').checked ? '1' : '0'); localStorage.setItem('mantiphy.expSub', $('#expSub').value); localStorage.setItem('mantiphy.expExisting', opts.onExisting); localStorage.setItem('mantiphy.expDpi', opts.dpi || ''); localStorage.setItem('mantiphy.expMeta', opts.metaMode); localStorage.setItem('mantiphy.expKeywords', opts.includeKeywords ? '1' : '0'); localStorage.setItem('mantiphy.expCopyright', opts.copyright);
    const where = opts.destMode === 'source' ? 'next to their originals' : opts.dest;
    S.exportCancel = false; showExportProgress(ids.length, where);
    let done = 0, failed = 0, skipped = 0;
    for (const id of ids) {
      if (S.exportCancel) break;
      const im = S.byId.get(id);
      status(`Exporting ${done + 1}/${ids.length}…`);
      updateExportProgress(done, ids.length, im?.filename || '');
      try {
        let res = await exportOne(id, opts, done + 1);
        if (res?.skipped) skipped++;
      } catch (e) {
        if (e.clash) {
          // "Ask what to do" — resolve this one, optionally for all that follow.
          const choice = await askClash(e.message);
          if (choice === 'cancel') { S.exportCancel = true; done++; break; }
          if (choice.all) opts.onExisting = choice.action;
          try {
            const res = await exportOne(id, { ...opts, onExisting: choice.action }, done + 1);
            if (res?.skipped) skipped++;
          } catch (e2) { failed++; toast(`${im?.filename}: ${e2.message}`); }
        } else { failed++; toast(`${im?.filename}: ${e.message}`); }
      }
      done++;
    }
    status('');
    const ok = done - failed - skipped;
    const verb = S.exportCancel ? `Stopped after ${done} of ${ids.length}` : `Exported ${ok} photo${ok === 1 ? '' : 's'}`;
    const extra = `${skipped ? ` · ${skipped} skipped` : ''}${failed ? ` · ${failed} failed` : ''}`;
    finishExportProgress(verb + extra, failed > 0, done, ids.length);
    toast(`${verb} ${opts.destMode === 'source' ? 'next to their originals' : 'to ' + opts.dest}`);
    if (S.module === 'develop' && S.activeId) { const img = await loadImg('/api/image/' + S.activeId + '/preview'); previewImg = img; engine.setImage(img, true); await rebuildMaskTextures(); await ensureDenoise(); await maybeUseCleanTexture(); requestRender(); }
  };
}



function askClash(msg) {
  // Mirrors Lightroom's Existing Files prompt: three actions, plus "apply to all".
  return new Promise(resolve => {
    const dlg = $('#dlgClash');
    $('#clashMsg').textContent = msg;
    $('#clashAll').checked = false;
    const pick = action => { dlg.close(); resolve({ action, all: $('#clashAll').checked }); };
    $('#clashRename').onclick = () => pick('rename');
    $('#clashOver').onclick = () => pick('overwrite');
    $('#clashSkip').onclick = () => pick('skip');
    dlg.oncancel = () => resolve('cancel');   // Escape aborts the export
    dlg.showModal();
  });
}

function showExportProgress(total, where) {
  const el = $('#expProgress');
  el.classList.remove('hidden', 'done', 'failed');
  $('#epTitle').textContent = 'Exporting…';
  $('#epCancel').style.display = '';
  $('#epCancel').textContent = 'Cancel';
  $('#epCancel').onclick = () => { S.exportCancel = true; $('#epTitle').textContent = 'Finishing current photo…'; $('#epCancel').disabled = true; };
  $('#epCancel').disabled = false;
  $('#epDest').textContent = where;
  updateExportProgress(0, total, '');
}

function updateExportProgress(done, total, filename) {
  $('#epFill').style.width = (total ? (done / total) * 100 : 0) + '%';
  $('#epCount').textContent = `${done} / ${total}`;
  if (filename) $('#epTitle').textContent = `Exporting ${filename}`;
}

function finishExportProgress(msg, failed, done, total) {
  const el = $('#expProgress');
  el.classList.add(failed ? 'failed' : 'done');
  $('#epFill').style.width = (total ? (done / total) * 100 : 100) + '%';
  $('#epCount').textContent = `${done} / ${total}`;
  $('#epTitle').textContent = msg;
  $('#epCancel').textContent = 'Close';
  $('#epCancel').disabled = false;
  $('#epCancel').onclick = () => el.classList.add('hidden');
  // Leave it up long enough to be read, then get out of the way.
  setTimeout(() => el.classList.add('hidden'), failed ? 12000 : 5000);
}

function paintExportDest() {
  const source = $('#expDestMode').value === 'source';
  $('#expDestRow').style.display = source ? 'none' : '';
  $('#expSub').disabled = !$('#expSubOn').checked;
  const sub = $('#expSubOn').checked ? ($('#expSub').value.trim() || 'Edited') : '';
  $('#expHint').textContent = source
    ? (sub ? `Each photo goes into a "${sub}" subfolder of the folder it came from, so edits never mix with your originals.`
           : 'Each photo is written back into the folder it came from, beside the original.')
    : (sub ? `Everything goes into a "${sub}" subfolder of the destination.`
           : 'Pixels are rendered on your GPU with the exact preview pipeline, then saved by the backend with the original EXIF.');
}

async function exportOne(id, o, seq) {
  const im = S.byId.get(id); const full = await api.get('/api/image/' + id); const edits = mergeDefaults(full.edits);
  // 16-bit TIFF: a 16-bit source, float intermediates and float read-back, end to end.
  // Object removal / clone stamp paint on 8-bit canvases, so those photos use the 8-bit source.
  const deep = o.fmt === 'tiff16' && engine.float32 && !edits.heal.strokes.length && !edits.clone.strokes.length;
  if (o.fmt === 'tiff16' && !deep) toast(`${im.filename}: ${engine.float32 ? 'object removal / clone stamp are 8-bit, rendering from the 8-bit source' : 'this GPU cannot render in float, rendering at 8 bits'}`);
  let bmp = null;
  if (deep) {
    const fr = await fetch('/api/image/' + id + '/full16'); if (!fr.ok) throw new Error('16-bit decode failed');
    engine.setImage16(new Uint16Array(await fr.arrayBuffer(), 8), +fr.headers.get('X-Width'), +fr.headers.get('X-Height'), true);
  } else {
  const fr = await fetch('/api/image/' + id + '/full'); if (!fr.ok) throw new Error('Full-size decode failed'); bmp = await createImageBitmap(await fr.blob());
  if (edits.heal.strokes.length) {
    const mc = document.createElement('canvas'); mc.width = bmp.width; mc.height = bmp.height;
    const g = mc.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, mc.width, mc.height);
    for (const s of edits.heal.strokes) for (const p of s.pts) dab(g, p[0], p[1], s, mc.width, mc.height);
    const maskBlob = await new Promise(res => mc.toBlob(res, 'image/png'));
    const fd2 = new FormData(); fd2.append('mask', maskBlob, 'mask.png');
    const hr = await fetch(`/api/image/${id}/inpaint?res=full`, { method: 'POST', body: fd2 });
    if (hr.ok) { const healed = await createImageBitmap(await hr.blob()); bmp.close?.(); bmp = healed; }
    else toast(`Object removal failed for export (${im.filename}), exporting unhealed: ` + ((await hr.json().catch(() => ({}))).detail || hr.statusText));
  }
  if (edits.clone.strokes.length) {
    const cc = document.createElement('canvas'); cc.width = bmp.width; cc.height = bmp.height;
    const cg = cc.getContext('2d'); cg.drawImage(bmp, 0, 0);
    for (const s of edits.clone.strokes) for (const p of s.pts) cloneStamp(cc, bmp, p, s, cc.width, cc.height);
    bmp.close?.(); bmp = await createImageBitmap(cc);
  }
  engine.setImage(bmp, o.fmt === 'tiff16');
  }
  if (edits.presence.denoise > 0) {
    if (edits.heal.strokes.length > 0 || edits.clone.strokes.length > 0) {
      toast(`AI denoise skipped for export (${im.filename}): not yet compatible with object removal or clone stamp on the same photo`);
    } else {
      const dr = await fetch(`/api/image/${id}/denoise?res=full`, { method: 'POST' });
      if (dr.ok) { const sigma = +dr.headers.get('X-Noise-Sigma') || 0; engine.setDenoised(await loadImg(URL.createObjectURL(await dr.blob())), sigma); }
      else toast(`AI denoise failed for export (${im.filename}), exporting without denoise: ` + ((await dr.json().catch(() => ({}))).detail || dr.statusText));
    }
  }
  const savedEdits = S.edits, savedCurve = S.hasCurve; S.edits = edits; updateCurveTexture();
  for (const m of edits.masks) {
    if (m.type === 'brush') engine.setMaskTexture(m.id, brushCanvas(m, true, Math.min(engine.w, 4096), Math.round(Math.min(engine.w, 4096) * engine.h / engine.w)));
    else if (m.type === 'ai') { const r = await fetch(`/api/image/${id}/aimask?kind=${m.params.kind}&quality=${m.params.quality || 'standard'}`, { method: 'POST' }); if (r.ok) engine.setMaskTexture(m.id, await loadImg(URL.createObjectURL(await r.blob()))); }
    if (m.sky?.assetId && !engine.skyTextures.has(m.sky.assetId)) { try { const img = await loadImg(`/api/skies/${m.sky.assetId}?res=full`); engine.setSkyTexture(m.sky.assetId, img); } catch (e) { toast('Could not load sky: ' + e.message); } }
    if (m.refine?.strokes?.length) engine.setMaskTexture(m.id + '_refine', refineCanvasBuild(m, true, Math.min(engine.w, 4096), Math.round(Math.min(engine.w, 4096) * engine.h / engine.w)));
  }
  const c = edits.crop; let ow = Math.round(c.w * engine.w), oh = Math.round(c.h * engine.h);
  if (o.long_edge && Math.max(ow, oh) > o.long_edge) { const s = o.long_edge / Math.max(ow, oh); ow = Math.round(ow * s); oh = Math.round(oh * s); }
  const maxT = engine.gl.getParameter(engine.gl.MAX_TEXTURE_SIZE); if (Math.max(ow, oh) > maxT) { const s = maxT / Math.max(ow, oh); ow = Math.round(ow * s); oh = Math.round(oh * s); }
  const px = engine.render({ edits, hasCurve: S.hasCurve, view: { x: 0, y: 0, sx: ow, sy: oh }, outW: ow, outH: oh, toPixels: true, toFloat: o.fmt === 'tiff16' && engine.halfFloat, lensProfile: edits.lens.autoProfile ? await api.get('/api/image/' + id + '/lensprofile').catch(() => null) : null, cameraMatrix: await api.get('/api/image/' + id + '/cameraprofile').then(p => p.matched ? p.matrix.flat() : null).catch(() => null) });
  S.edits = savedEdits; S.hasCurve = savedCurve; updateCurveTexture(); bmp?.close?.();
  if (o.fmt === 'tiff16' && engine.halfFloat) return uploadTiff16(im, o, seq, ow, oh);
  // flip rows (GL origin is bottom-left) and encode
  const cv = document.createElement('canvas'); cv.width = ow; cv.height = oh; const g = cv.getContext('2d'); const idata = g.createImageData(ow, oh); const row = ow * 4;
  for (let y = 0; y < oh; y++) idata.data.set(px.subarray((oh - 1 - y) * row, (oh - y) * row), y * row); g.putImageData(idata, 0, 0);
  const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
  const fd = new FormData(); fd.append('file', blob, 'render.png'); fd.append('dest', o.destMode === 'source' ? im.folder : o.dest); fd.append('subfolder', o.subfolder || ''); fd.append('on_existing', o.onExisting || 'rename'); fd.append('filename', o.name.replace('{name}', im.filename.replace(/\.[^.]+$/, '')).replace('{seq}', String(seq).padStart(3, '0'))); fd.append('fmt', o.fmt); fd.append('quality', o.quality); fd.append('long_edge', 0); fd.append('sharpen', o.sharpen); fd.append('metadata_src', im.path);
  fd.append('dpi', o.dpi || 0); fd.append('metadata_mode', o.metaMode || 'copy'); fd.append('keywords', o.includeKeywords ? (im.keywords || '') : ''); fd.append('copyright', o.copyright || '');
  const r = await fetch('/api/export', { method: 'POST', body: fd });
  if (r.status === 409) { const e = new Error((await r.json().catch(() => ({}))).detail || 'File exists'); e.clash = true; throw e; }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'Export failed');
  return r.json();
}

/** Read the float render back in strips, flip it upright, quantise to 16 bits
 *  and hand it to the backend's TIFF writer. */
async function uploadTiff16(im, o, seq, ow, oh) {
  const rgb = new Uint16Array(ow * oh * 3), strip = 256, buf = new Float32Array(ow * strip * 4);
  for (let y = 0; y < oh; y += strip) {
    const n = Math.min(strip, oh - y); const f = n === strip ? buf : new Float32Array(ow * n * 4);
    engine.readFloatRows(y, n, ow, f);
    for (let r = 0; r < n; r++) {
      const dst = (oh - 1 - (y + r)) * ow * 3, src = r * ow * 4;
      for (let x = 0; x < ow; x++) { const s = src + x * 4, d = dst + x * 3;
        rgb[d] = Math.round(Math.min(Math.max(f[s], 0), 1) * 65535); rgb[d + 1] = Math.round(Math.min(Math.max(f[s + 1], 0), 1) * 65535); rgb[d + 2] = Math.round(Math.min(Math.max(f[s + 2], 0), 1) * 65535); }
    }
  }
  engine.releaseFloat();
  const fd = new FormData(); fd.append('file', new Blob([rgb.buffer]), 'render.rgb16'); fd.append('width', ow); fd.append('height', oh);
  fd.append('dest', o.destMode === 'source' ? im.folder : o.dest); fd.append('subfolder', o.subfolder || ''); fd.append('on_existing', o.onExisting || 'rename');
  fd.append('filename', o.name.replace('{name}', im.filename.replace(/\.[^.]+$/, '')).replace('{seq}', String(seq).padStart(3, '0')));
  fd.append('sharpen', o.sharpen); fd.append('metadata_src', im.path); fd.append('dpi', o.dpi || 0); fd.append('metadata_mode', o.metaMode || 'copy'); fd.append('copyright', o.copyright || '');
  const r = await fetch('/api/export16', { method: 'POST', body: fd });
  if (r.status === 409) { const e = new Error((await r.json().catch(() => ({}))).detail || 'File exists'); e.clash = true; throw e; }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'Export failed');
  return r.json();
}

// ---------------------------------------------------------------------------
// slideshow
// ---------------------------------------------------------------------------
let ssIds = [], ssIdx = 0, ssDuration = 4, ssPlaying = true, ssTimer = null, ssNextFrame = null, ssActiveLayer = 0, ssHideT = null, ssActive = false;

let stackIds = [];
function openStackDialog(ids) {
  if (ids.length < 2) return toast('Select at least 2 photos to stack');
  stackIds = ids; $('#stackCount').textContent = `${ids.length} photos`;
  $('#dlgStack').showModal();
}
async function runStack() {
  const mode = $('input[name=stackMode]:checked').value, ids = stackIds;
  if (mode === 'median' && ids.length < 3) return toast('Removing moving objects needs at least 3 photos (ideally 8 or more)');
  $('#dlgStack').close();
  status(`Stacking ${ids.length} photos\u2026`); $('#spinner').style.display = 'block';
  try {
    const r = await api.send('/api/stack', 'POST', { ids, mode, align: $('#stackAlign').checked });
    await refreshImages(); refreshFolders();
    S.activeId = r.iid; S.selection = new Set([r.iid]);
    toast(`Stacked ${r.frames} photos \u2192 ${r.size[0]}\u00d7${r.size[1]}`);
    setModule('develop'); openInDevelop(r.iid);
  } catch (e) { toast('Stacking failed: ' + e.message); }
  status(''); $('#spinner').style.display = 'none';
}
function openSlideshowDialog(ids) {
  if (!ids.length) return;
  ssIds = ids;
  $('#slideCount').textContent = `${ids.length} photo${ids.length > 1 ? 's' : ''}`;
  $('#dlgSlideshow').showModal();
}

let ssRenderQueue = Promise.resolve();
function queueSlideshowRender(id) {
  const p = ssRenderQueue.then(() => renderSlideshowFrame(id));
  ssRenderQueue = p.then(() => {}, () => {});
  return p;
}

async function renderSlideshowFrame(id) {
  const full = await api.get('/api/image/' + id);
  const edits = mergeDefaults(full.edits);
  edits.masks = edits.masks.filter(m => m.type !== 'ai');
  const pr = await fetch('/api/image/' + id + '/preview');
  if (!pr.ok) throw new Error('Preview decode failed for ' + (S.byId.get(id)?.filename || id));
  const bmp = await createImageBitmap(await pr.blob());
  engine.setImage(bmp, false);
  const savedEdits = S.edits, savedCurve = S.hasCurve;
  let frame;
  try {
    S.edits = edits; updateCurveTexture();
    for (const m of edits.masks) {
      if (m.type === 'brush') engine.setMaskTexture(m.id, brushCanvas(m, true, Math.min(engine.w, 4096), Math.round(Math.min(engine.w, 4096) * engine.h / engine.w)));
      if (m.refine?.strokes?.length) engine.setMaskTexture(m.id + '_refine', refineCanvasBuild(m, true, Math.min(engine.w, 4096), Math.round(Math.min(engine.w, 4096) * engine.h / engine.w)));
    }
    const c = edits.crop;
    let ow = Math.round(c.w * engine.w), oh = Math.round(c.h * engine.h);
    const maxT = engine.gl.getParameter(engine.gl.MAX_TEXTURE_SIZE);
    if (Math.max(ow, oh) > maxT) { const s = maxT / Math.max(ow, oh); ow = Math.round(ow * s); oh = Math.round(oh * s); }
    glCanvas.width = ow; glCanvas.height = oh;
    engine.render({
      edits, hasCurve: S.hasCurve, view: { x: 0, y: 0, sx: ow, sy: oh }, outW: ow, outH: oh,
      cropMode: false, before: false, clip: false, showMaskId: null,
      lensProfile: edits.lens.autoProfile ? await api.get('/api/image/' + id + '/lensprofile').catch(() => null) : null,
      cameraMatrix: await api.get('/api/image/' + id + '/cameraprofile').then(p => p.matched ? p.matrix.flat() : null).catch(() => null),
    });
    frame = await createImageBitmap(glCanvas);
  } finally {
    S.edits = savedEdits; S.hasCurve = savedCurve; updateCurveTexture();
    bmp.close?.();
  }
  return frame;
}

function ssShow(layerIdx, bitmap) {
  const layers = [$('#ssLayerA'), $('#ssLayerB')];
  const el = layers[layerIdx];
  el.innerHTML = '';
  const cnv = document.createElement('canvas'); cnv.width = bitmap.width; cnv.height = bitmap.height;
  cnv.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();
  el.appendChild(cnv);
  el.classList.remove('kb');
  void el.offsetWidth;
  el.style.setProperty('--ss-dur', ssDuration + 's');
  el.classList.add('on', 'kb');
  layers[1 - layerIdx].classList.remove('on');
}

async function ssPreloadNext() {
  if (ssIds.length < 2) return;
  const capturedIdx = ssIdx;
  const nextId = ssIds[(capturedIdx + 1) % ssIds.length];
  let frame;
  try { frame = await queueSlideshowRender(nextId); }
  catch (e) { toast('Slideshow: ' + e.message); return; }
  if (!ssActive || capturedIdx !== ssIdx) { frame.close?.(); return; }
  if (ssNextFrame) ssNextFrame.close?.();
  ssNextFrame = frame;
}

function ssScheduleNext() {
  clearTimeout(ssTimer);
  if (!ssActive || !ssPlaying) return;
  ssTimer = setTimeout(() => ssAdvance(1), ssDuration * 1000);
}

async function ssAdvance(dir) {
  clearTimeout(ssTimer);
  ssIdx = (ssIdx + dir + ssIds.length) % ssIds.length;
  ssActiveLayer = 1 - ssActiveLayer;
  let frame;
  if (dir === 1 && ssNextFrame) { frame = ssNextFrame; ssNextFrame = null; }
  else {
    if (ssNextFrame) { ssNextFrame.close?.(); ssNextFrame = null; }
    try { frame = await queueSlideshowRender(ssIds[ssIdx]); }
    catch (e) { toast('Slideshow: ' + e.message); ssActiveLayer = 1 - ssActiveLayer; if (ssActive) ssScheduleNext(); return; }
  }
  if (!ssActive) { frame.close?.(); return; }
  ssShow(ssActiveLayer, frame);
  ssScheduleNext();
  ssPreloadNext();
}

function ssJump(dir) { ssAdvance(dir); }

function ssTogglePlay() {
  ssPlaying = !ssPlaying;
  $('#ssPlay use').setAttribute('href', ssPlaying ? '#i-pause' : '#i-play');
  if (ssPlaying) ssScheduleNext(); else clearTimeout(ssTimer);
}

async function startSlideshow(ids, durationSec) {
  if (!ids.length) return;
  let first;
  try { first = await queueSlideshowRender(ids[0]); }
  catch (e) { toast('Slideshow: ' + e.message); return; }
  ssIds = ids; ssIdx = 0; ssDuration = durationSec; ssPlaying = true; ssActiveLayer = 0; ssNextFrame = null; ssActive = true;
  $('#ssLayerA').classList.remove('on', 'kb'); $('#ssLayerB').classList.remove('on', 'kb');
  ssShow(0, first);
  $('#slideshowView').classList.remove('hidden');
  $('#ssPlay use').setAttribute('href', '#i-pause');
  ssPreloadNext();
  ssScheduleNext();
}

function stopSlideshow() {
  ssActive = false; ssPlaying = false;
  clearTimeout(ssTimer); ssTimer = null;
  if (ssNextFrame) { ssNextFrame.close?.(); ssNextFrame = null; }
  $('#slideshowView').classList.add('hidden');
  $('#ssLayerA').innerHTML = ''; $('#ssLayerB').innerHTML = '';
}

function bindSlideshow() {
  $('#stackGo').onclick = runStack;
  $('#slideGo').onclick = () => { $('#dlgSlideshow').close(); startSlideshow(ssIds, +$('#slideDuration').value); };
  $('#ssPrev').onclick = () => ssJump(-1);
  $('#ssNext').onclick = () => ssJump(1);
  $('#ssPlay').onclick = () => ssTogglePlay();
  $('#ssExit').onclick = () => stopSlideshow();
  $('#slideshowView').onmousemove = () => {
    $('#ssBar').classList.add('show');
    clearTimeout(ssHideT);
    ssHideT = setTimeout(() => $('#ssBar').classList.remove('show'), 2500);
  };
}

// ---------------------------------------------------------------------------
// keyboard
// ---------------------------------------------------------------------------
const KEYS = [['G', 'Library grid'], ['D', 'Develop'], ['← →', 'Previous / next photo'], ['1–5 / 0', 'Rating'], ['P / X / U', 'Pick / reject / unflag'], ['6–9', 'Colour label'], ['R', 'Crop tool'], ['M', 'Masks'], ['O', 'Show / hide mask overlay'], ['H', 'Remove object'], ['C', 'Clone stamp'], ['\\', 'Before / after'], ['J', 'Clipping warnings'], ['I', 'Info overlay'], ['Space', 'Toggle fit / 1:1'], ['Ctrl Z / Ctrl Shift Z', 'Undo / redo'], ['Ctrl C / Ctrl V', 'Copy / paste settings'], ['Ctrl Shift E', 'Export'], ['Ctrl A', 'Select all'], ['Esc', 'Close tool / deselect'], ['Alt + brush', 'Erase'], ['Alt-click (Clone tool)', 'Set clone source'], ['Double-click slider name', 'Reset slider'], ['Scroll on slider', 'Nudge (Shift ×10)'], ['Space / ← → / Esc (during Slideshow)', 'Pause / prev-next / exit']];
function buildKeys() { $('#keysList').innerHTML = KEYS.map(([k, d]) => `<div><span>${d}</span><span class="kbd">${k}</span></div>`).join(''); }
function onKey(e) {
  if (!$('#slideshowView').classList.contains('hidden')) {
    if (e.key === 'Escape') { stopSlideshow(); return; }
    if (e.key === ' ') { e.preventDefault(); ssTogglePlay(); return; }
    if (e.key === 'ArrowLeft') { ssJump(-1); return; }
    if (e.key === 'ArrowRight') { ssJump(1); return; }
    return;
  }
  if (e.target?.matches?.('input,textarea,select') || document.querySelector('dialog[open]')) { if (e.key === 'Escape') e.target.blur?.(); return; }
  const k = e.key, ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (ctrl && k.toLowerCase() === 'c') { if (S.module === 'develop') { $('#copyBtn').click(); e.preventDefault(); } return; }
  if (ctrl && k.toLowerCase() === 'v') { if (S.module === 'develop') { pasteSettings(); e.preventDefault(); } return; }
  if (ctrl && e.shiftKey && k.toLowerCase() === 'e') { e.preventDefault(); $('#exportBtn').click(); return; }
  if (ctrl && k.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return; }
  if (ctrl) return;
  if (k === 'Alt' && S.tool === 'mask') { S.brush.erase = true; syncMaskEditor(); window.addEventListener('keyup', () => { S.brush.erase = false; syncMaskEditor(); }, { once: true }); }
  const nav = d => { const ids = S.images.map(i => i.id); const i = ids.indexOf(S.activeId); const n = ids[clamp(i + d, 0, ids.length - 1)]; if (!n || n === S.activeId) return; selectImage(n); if (S.module === 'develop') openInDevelop(n); else $(`#grid .cell[data-id="${n}"]`)?.scrollIntoView({ block: 'nearest' }); };
  switch (k) {
    case 'g': case 'G': setModule('library'); break; case 'd': case 'D': setModule('develop'); break;
    case 'ArrowLeft': nav(-1); e.preventDefault(); break; case 'ArrowRight': nav(1); e.preventDefault(); break;
    case '0': case '1': case '2': case '3': case '4': case '5': patchImages({ rating: +k }); break;
    case '6': case '7': case '8': case '9': patchImages({ label: Object.keys(LABELS)[+k - 6] }); break;
    case 'p': case 'P': patchImages({ flag: 'pick' }); break; case 'x': case 'X': patchImages({ flag: 'reject' }); break; case 'u': case 'U': patchImages({ flag: '' }); break;
    case 'r': case 'R': if (S.module === 'develop') setTool(S.tool === 'crop' ? null : 'crop'); break;
    case 'm': case 'M': if (S.module === 'develop') setTool(S.tool === 'mask' ? null : 'mask'); break;
    case 'o': case 'O': if (S.module === 'develop' && S.tool === 'mask') setMaskOverlay(!S.maskOverlay); break;
    case 'h': case 'H': if (S.module === 'develop' && S.health.inpaint !== false) setTool(S.tool === 'heal' ? null : 'heal'); break;
    case 'c': case 'C': if (S.module === 'develop') setTool(S.tool === 'clone' ? null : 'clone'); break;
    case '\\': if (S.module === 'develop') toggleBefore(); break; case 'j': case 'J': if (S.module === 'develop') toggleClip(); break;
    case 'i': case 'I': S.info = !S.info; $('#info').classList.toggle('hidden', !S.info); if (S.info) drawInfo(); break;
    case ' ': if (S.module === 'develop') { e.preventDefault(); setZoom(S.zoom === 'fit' ? '1' : 'fit'); } break;
    case 'Escape': if (S.tool) setTool(null); else if (S.wbPicking || S.colorPicking) { S.wbPicking = S.colorPicking = false; glCanvas.classList.remove('pick'); } else { selectNone(); } break;
    case '?': $('#dlgKeys').showModal(); break;
  }
}

boot();

// ---------------------------------------------------------------------------
// drag & drop import
// ---------------------------------------------------------------------------
/** Absolute paths out of a drop.
 *
 *  A dropped folder gives no filesystem path through the File API — the browser
 *  deliberately hides it. File managers additionally publish the selection as
 *  text/uri-list (the XDND convention KDE, GNOME and macOS all follow), and
 *  that does carry the real path, which is what the backend needs to catalog
 *  photos where they already live rather than copying them anywhere. */
function pathsFromDrop(dt) {
  // Desktops disagree on which flavour carries the selection, so try each one
  // that is known to hold file URIs before giving up.
  let raw = '';
  for (const type of ['text/uri-list', 'text/x-moz-url', 'text/plain', 'STRING', 'UTF8_STRING']) {
    try { raw = dt.getData(type) || ''; } catch { raw = ''; }
    if (raw.includes('file://') || raw.trimStart().startsWith('/')) break;
  }
  const out = [];
  for (const line of raw.split(/[\r\n]+/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.startsWith('/')) { out.push(t); continue; }   // a bare absolute path
    if (!t.startsWith('file://')) continue;
    let rest = t.slice('file://'.length);
    const cut = rest.indexOf('/');          // strip an (optional) host segment
    rest = cut >= 0 ? rest.slice(cut) : rest;
    try { out.push(decodeURIComponent(rest)); } catch { out.push(rest); }
  }
  return [...new Set(out)];
}

function bindDrop() {
  const zone = $('#dropzone');
  const carries = e => { const t = e.dataTransfer?.types; return !!t && ([...t].includes('Files') || [...t].includes('text/uri-list')); };
  let depth = 0;
  const show = on => zone.classList.toggle('hidden', !on);

  window.addEventListener('dragenter', e => { if (!carries(e)) return; e.preventDefault(); depth++; show(true); });
  window.addEventListener('dragover', e => { if (!carries(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', e => { if (!carries(e)) return; depth = Math.max(0, depth - 1); if (!depth) show(false); });
  window.addEventListener('drop', async e => {
    if (!carries(e)) return;
    e.preventDefault(); depth = 0; show(false);
    const paths = pathsFromDrop(e.dataTransfer);
    if (!paths.length) return toast('No folder path in that drop — use Import instead');

    let added = 0, updated = 0, failed = 0, last = null;
    for (const [i, path] of paths.entries()) {
      status(`Importing ${i + 1}/${paths.length}…`);
      try {
        const r = await api.send('/api/import', 'POST', { path, recursive: true });
        added += r.added; updated += r.updated; last = r.folder || path;
      } catch (err) { failed++; toast(`${path}: ${err.message}`); }
    }
    status('');
    if (last) {
      S.folder = last; S.collection = null;
      localStorage.setItem('mantiphy.folder', last);
      await refreshFolders(); await refreshImages();
    }
    if (added || updated) toast(`Imported ${added} new, ${updated} updated`);
    else if (!failed) toast('Nothing new to import');
  });
}
