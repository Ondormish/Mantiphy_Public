/* Small helpers shared by the whole frontend: DOM lookup, the JSON API, object
   paths, toasts. No application state lives here. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = {
  async get(u) { const r = await fetch(u); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText); return r.json(); },
  async send(u, m, body) { const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText); return r.json(); },
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const deepClone = o => JSON.parse(JSON.stringify(o));
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const setPath = (o, p, v) => { const ks = p.split('.'); let c = o; for (let i = 0; i < ks.length - 1; i++) c = c[ks[i]] ??= {}; c[ks[ks.length - 1]] = v; };
const uid = () => Math.random().toString(36).slice(2, 9);
let toastT; const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200); };
const status = m => { $('#status').textContent = m || ''; };
const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Image failed to load')); i.src = src; });
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export { $, $$, api, clamp, deepClone, getPath, setPath, uid, toast, status, loadImg, debounce };
