// Mantiphy UI smoke tests. Started by run.sh, which provides a backend on a
// throwaway catalog (MANTIPHY_URL) holding the photos from fixtures.py.
// Each scenario is independent-ish and reports PASS/FAIL; the process exits
// non-zero if any failed. Uses software WebGL, so it runs headless anywhere.
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright'); }

const URL_ = process.env.MANTIPHY_URL || 'http://127.0.0.1:7899';
const TMP = process.env.MANTIPHY_TMP || '/tmp';
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const wait = ms => new Promise(r => setTimeout(r, ms));

const browser = await playwright.chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('dialog', d => d.accept());

async function library() {
  await page.goto(URL_); await wait(1500);
  if (!(await page.$('#grid .cell:visible'))) { await page.click('.tabs button[data-mod=library]'); await wait(600); }
}
async function cell(name) {
  for (const c of await page.$$('#grid .cell')) if ((await c.innerText()).includes(name)) return c;
  throw new Error('no grid cell for ' + name);
}
async function develop(name) { await library(); await (await cell(name)).dblclick(); await wait(2500); }
const canvasPixel = (fx, fy) => page.evaluate(([fx, fy]) => {
  const c = document.querySelector('#gl'); const g = c.getContext('webgl2'); const a = new Uint8Array(4);
  g.readPixels(Math.round(c.width * fx), Math.round(c.height * (1 - fy)), 1, 1, g.RGBA, g.UNSIGNED_BYTE, a); return [...a].slice(0, 3);
}, [fx, fy]);
const setSlider = (sel, v) => page.$eval(sel + ' input[type=range]', (r, v) => { r.value = v; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); }, v);
const pins = () => page.$$eval('#overlay .pin', ps => Object.fromEntries(ps.map(p => [p.dataset.p, [parseFloat(p.style.left), parseFloat(p.style.top)]])));
async function drag(sel, dx, dy) {
  const b = await (await page.$(sel)).boundingBox(); const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 10 }); await page.mouse.up(); await wait(300);
}

const scenarios = {
  async 'develop renders the photo'() {
    await develop('landscape');
    const sky = await canvasPixel(0.5, 0.25);
    assert(sky[2] > sky[0] + 40, 'sky should be blue, got ' + sky);
  },

  async 'linear gradient handles move the whole gradient'() {
    await develop('landscape');
    await page.click('[data-tool=mask]'); await page.click('[data-add=linear]'); await wait(200);
    await page.mouse.move(680, 250); await page.mouse.down(); await page.mouse.move(680, 400, { steps: 8 }); await page.mouse.up(); await wait(400);
    const a = await pins(); assert(a.c && a['0'] && a['1'], 'handles appear right after creating the gradient');
    await drag('#overlay .pin[data-p="c"]', 150, 120);
    const b = await pins();
    assert(Math.abs(b['0'][0] - a['0'][0] - 150) < 3 && Math.abs(b['1'][1] - a['1'][1] - 120) < 3, 'both ends follow the centre handle');
    await drag('#overlay .pin[data-p="1"]', 100, 0);
    const c = await pins(); assert(Math.abs(c['1'][0] - b['1'][0] - 100) < 3 && c['0'][0] === b['0'][0], 'an end handle moves on its own');
  },

  async 'mask overlay toggles with O and the checkbox'() {
    await develop('landscape');
    await page.click('[data-tool=mask]'); await page.click('#maskList > *:first-child'); await wait(300);
    const on = await canvasPixel(0.3, 0.2);
    await page.keyboard.press('o'); await wait(300);
    const off = await canvasPixel(0.3, 0.2);
    assert(on[0] > off[0] + 30, `red overlay should disappear (on ${on}, off ${off})`);
    await page.click('#maskOverlayOn'); await wait(300);
    assert((await canvasPixel(0.3, 0.2))[0] > off[0] + 30, 'checkbox brings it back');
  },

  async 'presets preview on hover, replace each other, and remove'() {
    await develop('landscape');
    const val = p => page.$eval(`.sl[data-path="${p}"] .val`, e => +e.value);
    const before = await canvasPixel(0.5, 0.25);
    await page.hover('.preset[data-name="Silver gelatin"]'); await wait(400);
    const hover = await canvasPixel(0.5, 0.25);
    assert(Math.abs(hover[0] - hover[2]) < 6, 'hover shows the B&W preview');
    assert((await val('presence.saturation')) === 0, 'hover does not change the sliders');
    await page.mouse.move(700, 500); await wait(300);
    assert(JSON.stringify(await canvasPixel(0.5, 0.25)) === JSON.stringify(before), 'leaving restores the photo');
    await page.click('.preset[data-name="Silver gelatin"]'); await wait(300);
    assert((await val('presence.saturation')) === -100, 'B&W applied');
    await page.click('.preset[data-name="Kodak Portra 400"]'); await wait(300);
    assert((await val('presence.saturation')) === -8, 'Portra replaces B&W instead of stacking on it');
    await page.click('.preset[data-name="Kodak Portra 400"]'); await wait(300);
    assert((await val('presence.saturation')) === 0 && !(await page.$('.preset.on')), 'clicking the active preset removes it');
  },

  async 'filmstrip thumbnail follows the edit and marks the photo edited'() {
    await develop('burst_0');   // landscape already carries edits from the scenarios above
    const active = '#filmstrip .fcell.active';
    const brightness = () => page.$eval(active + ' img', async img => {
      await img.decode(); const c = document.createElement('canvas'); c.width = c.height = 32;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, 32, 32);
      const d = g.getImageData(0, 0, 32, 32).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
      return s / (d.length / 4) / 3;
    });
    const before = await brightness();
    assert(!(await page.$(active + ' .fedited')), 'an untouched photo carries no edited mark');
    await setSlider('.sl[data-path="tone.exposure"]', 1.5); await wait(2500);
    assert(await page.$(active + ' .fedited'), 'the edited mark appears without leaving Develop');
    const after = await brightness();
    assert(after > before + 15, `the filmstrip thumbnail shows the brighter edit (${before.toFixed(0)} -> ${after.toFixed(0)})`);
    await setSlider('.sl[data-path="tone.exposure"]', 0); await wait(2500);
    assert(!(await page.$(active + ' .fedited')), 'resetting the edit clears the mark');
  },

  async 'photo menu is the same in the grid, the filmstrip and on the canvas'() {
    await library();
    await (await cell('landscape')).click({ button: 'right' }); await wait(200);
    const grid = await page.$$eval('#ctxmenu .mi', m => m.map(x => x.textContent));
    for (const want of ['Copy settings', 'Export', 'Duplicate', 'Remove 1 photo from library', 'Delete 1 photo from disk']) assert(grid.some(t => t.includes(want)), 'grid menu lacks ' + want);
    await page.keyboard.press('Escape'); await page.mouse.click(5, 5);
    await develop('landscape');
    await page.mouse.click(700, 450, { button: 'right' }); await wait(200);
    assert((await page.$$eval('#ctxmenu .mi', m => m.map(x => x.textContent))).some(t => t.includes('from disk')), 'canvas menu');
    await page.mouse.click(5, 5);
    const strip = await page.$$('#filmstrip .fcell'); await strip[0].click({ button: 'right' }); await wait(200);
    assert((await page.$$eval('#ctxmenu .mi', m => m.length)) > 4, 'filmstrip menu');
  },

  async 'stacking a burst removes the moving walker'() {
    await library();
    const burst = []; for (const c of await page.$$('#grid .cell')) if (/burst_\d\.jpg/.test(await c.innerText())) burst.push(c);
    assert(burst.length === 6, 'six burst frames, got ' + burst.length);
    await burst[0].click(); await page.keyboard.down('Shift'); await burst[5].click(); await page.keyboard.up('Shift');
    await burst[2].click({ button: 'right' }); await wait(200);
    await page.click('#ctxmenu .mi:has-text("Stack")'); await page.click('#stackGo');
    await page.waitForFunction(() => /_Clean\.tif$/.test(document.querySelector('#loupeName')?.textContent || ''), null, { timeout: 120000 });
    await wait(1500);
    // the walker is red at 20-35% width in frame 0: in the stack that area is plain ground
    for (const fx of [0.1, 0.25, 0.4, 0.55, 0.7]) { const p = await canvasPixel(fx, 0.8); assert(!(p[0] > 150 && p[1] < 90), `walker left at x=${fx}: ${p}`); }
  },

  async 'remove from library, re-import skips it, folder menu restores it'() {
    await library();
    const n0 = (await page.$$('#grid .cell')).length;
    await (await cell('burst_3.jpg')).click({ button: 'right' }); await wait(200);
    await page.click('#ctxmenu .mi:has-text("from library")'); await wait(1200);
    assert((await page.$$('#grid .cell')).length === n0 - 1, 'removed');
    await page.evaluate(p => fetch('/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) }), join(TMP, 'photos'));
    await library();
    assert((await page.$$('#grid .cell')).length === n0 - 1, 're-import must not bring it back');
    const node = (await page.$$('#folderTree .node')).pop(); await node.click({ button: 'right' }); await wait(500);
    await page.click('#ctxmenu .mi:has-text("Restore")'); await wait(1500);
    assert((await page.$$('#grid .cell')).length === n0, 'restored');
  },

  async 'export JPEG and 16-bit TIFF'() {
    const dest = join(TMP, 'export');
    for (const fmt of ['jpeg', 'tiff16']) {
      await develop('landscape');
      await page.click('#exportBtn'); await wait(300);
      await page.fill('#expDest', dest); await page.selectOption('#expDestMode', 'folder'); await page.selectOption('#expFmt', fmt);
      await page.click('#dlgExport footer .primary');
      await page.waitForFunction(() => /Exported/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 120000 });
    }
    const files = existsSync(dest) ? readdirSync(dest) : [];
    assert(files.some(f => f.endsWith('.jpg')) && files.some(f => f.endsWith('.tif')), 'exported files: ' + files);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(scenarios)) {
  const errs = pageErrors.length;
  try {
    await fn();
    if (pageErrors.length > errs) throw new Error('page error: ' + pageErrors.slice(errs).join(' | '));
    console.log('PASS', name);
  } catch (e) {
    failed++; console.log('FAIL', name, '—', e.message.split('\n')[0]);
    await page.screenshot({ path: join(TMP, 'fail-' + name.replace(/\W+/g, '_') + '.png') }).catch(() => {});
  }
}
await browser.close();
console.log(failed ? `${failed} scenario(s) failed` : 'all scenarios passed');
process.exit(failed ? 1 : 0);
