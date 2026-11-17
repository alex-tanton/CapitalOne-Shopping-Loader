(function () {
  'use strict';
  if (window.__c1sLoaded) return;
  window.__c1sLoaded = true;

  const { normalize, query, SORTS, DEFAULT_FILTERS } = globalThis.C1S;

  // ── Configuration ──────────────────────────────────────────────────
  const API_PATH = '/api/v1/feed';
  const STORE_SETTINGS = 'c1s_settings';
  const STORE_CACHE = 'c1s_cache';
  const DEFAULT_SETTINGS = {
    maxPages: 20,        // pages of 25 offers each
    delayMs: 800,        // pause between page requests
    cacheMinutes: 20,    // links are signed by the site, so keep this short
    state: 'NC',         // sent in the request's location context
    zipcode: '27519'
  };
  const PAGE_LIMIT = 25;

  // ── State ──────────────────────────────────────────────────────────
  const S = {
    open: false,
    settings: { ...DEFAULT_SETTINGS },
    items: [],
    ids: new Set(),
    loading: false,
    abort: null,
    loadedAt: null,
    status: '',
    error: '',
    filters: { ...DEFAULT_FILTERS },
    sort: 'site'
  };

  // ── Helpers ────────────────────────────────────────────────────────
  const sleep = (ms, signal) => new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); });
  });

  function h(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'value') e.value = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    down: 'M7 10l5 5 5-5z',
    search: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    refresh: 'M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z',
    tune: 'M3 17v2h6v-2zM3 5v2h10V5zm10 16v-2h8v-2h-8v-2h-2v6zM7 9v2H3v2h4v2h2V9zm14 4v-2H11v2zm-6-4h2V7h4V5h-4V3h-2z'
  };
  function icon(name, size = 18) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size); s.setAttribute('height', size);
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', ICONS[name]); p.setAttribute('fill', 'currentColor');
    s.append(p);
    return s;
  }

  const money = n => n == null ? '' : '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const pct = n => n == null ? '' : (Math.round(n * 10) / 10) + '%';

  function timeLeft(ms) {
    const d = ms - Date.now();
    if (d <= 0) return 'Ended';
    const hrs = d / 3600000;
    if (hrs < 1) return 'Ends in ' + Math.max(1, Math.round(d / 60000)) + ' min';
    if (hrs < 48) return 'Ends in ' + Math.round(hrs) + ' hr';
    return 'Ends ' + new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function ago(ms) {
    const m = Math.round((Date.now() - ms) / 60000);
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' hr ago';
  }

  // ── Settings & cache (chrome.storage) ──────────────────────────────
  async function loadSettings() {
    try {
      const r = await chrome.storage.local.get(STORE_SETTINGS);
      S.settings = { ...DEFAULT_SETTINGS, ...(r[STORE_SETTINGS] || {}) };
    } catch { /* keep defaults */ }
  }
  async function saveSettings() {
    try { await chrome.storage.local.set({ [STORE_SETTINGS]: S.settings }); } catch {}
  }
  async function saveCache() {
    try { await chrome.storage.local.set({ [STORE_CACHE]: { ts: S.loadedAt, items: S.items } }); } catch {}
  }
  async function readCache() {
    try {
      const r = (await chrome.storage.local.get(STORE_CACHE))[STORE_CACHE];
      return r && Array.isArray(r.items) && r.items.length ? r : null;
    } catch { return null; }
  }

  // ── Feed requests ──────────────────────────────────────────────────
  function buildBody(token) {
    const ua = navigator.userAgent;
    const chrome_ = (ua.match(/Chrome\/(\d+)/) || [])[1] || '157';
    const osName = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown';
    const pagination = { limit: PAGE_LIMIT };
    if (token) pagination.nextPageToken = token;
    return {
      contentProps: { pagination },
      context: {
        device: { memory: String(navigator.deviceMemory || 8), concurrency: String(navigator.hardwareConcurrency || 8) },
        browser: { name: 'Chrome', version: chrome_, major: chrome_ },
        os: { name: osName, version: osName === 'Windows' ? '10' : '' },
        screen: { width: window.screen.width, height: window.screen.height, density: window.devicePixelRatio || 1 },
        locale: navigator.language || 'en-US',
        country: 'US',
        location: { state: S.settings.state, zipcode: S.settings.zipcode },
        page: { path: '/', url: location.origin + '/', referrer: '', search: '', title: document.title },
        userAgent: ua
      }
    };
  }

  async function fetchPage(token, signal) {
    for (let attempt = 0; ; attempt++) {
      let resp;
      try {
        resp = await fetch(API_PATH, {
          method: 'POST',
          credentials: 'include',
          signal,
          headers: { 'Content-Type': 'application/json', Accept: '*/*' },
          body: JSON.stringify(buildBody(token))
        });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw new Error('Network error. Check your connection and try again.');
      }
      if (resp.status === 429 && attempt < 3) {
        const wait = 15000 * (attempt + 1);
        setStatus(`Rate limited. Waiting ${wait / 1000}s before retrying…`);
        await sleep(wait, signal);
        continue;
      }
      return resp;
    }
  }

  // The first page of the home feed is server-rendered into the HTML, whose page-2 token we can read.
  function findEmbeddedToken() {
    const re = /nextPageToken\\*"\s*,\s*\\*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
    for (const s of document.scripts) {
      const m = !s.src && re.exec(s.textContent);
      if (m) return m[1];
    }
    return null;
  }

  function addItems(rawItems) {
    let added = 0;
    for (const raw of rawItems) {
      const it = normalize(raw);
      if (!it || S.ids.has(it.id)) continue;
      S.ids.add(it.id);
      S.items.push(it);
      added++;
    }
    return added;
  }

  async function loadAll() {
    if (S.loading) return;
    S.loading = true;
    S.error = '';
    S.items = [];
    S.ids = new Set();
    S.abort = new AbortController();
    const { signal } = S.abort;
    syncControls();

    let token = null;
    let usedFallback = false;
    try {
      for (let page = 1; page <= S.settings.maxPages; page++) {
        setStatus(`Loading page ${page} of up to ${S.settings.maxPages}…`);
        let resp = await fetchPage(token, signal);

        if (!resp.ok && page === 1 && !token) {
          // First page without a token was refused. Fall back to the token embedded in the page.
          const t = findEmbeddedToken();
          if (t) { token = t; usedFallback = true; resp = await fetchPage(token, signal); }
        }
        if (resp.status === 401 || resp.status === 403) throw new Error('The site refused the request (' + resp.status + '). Reload the page, make sure you are signed in, and try again.');
        if (!resp.ok) throw new Error('Feed request failed with HTTP ' + resp.status + '.');

        const data = await resp.json().catch(() => { throw new Error('The feed returned an unexpected response.'); });
        const items = Array.isArray(data.items) ? data.items : [];
        addItems(items);
        scheduleRender();

        const next = data.pagination && data.pagination.nextPageToken;
        if (!next || next === token || items.length === 0) break;
        token = next;
        await sleep(S.settings.delayMs, signal);
      }
      S.loadedAt = Date.now();
      setStatus(usedFallback ? 'Loaded. Offers from the first page were skipped (see README).' : '');
    } catch (e) {
      if (e.name === 'AbortError') {
        S.loadedAt = Date.now();
        setStatus('Stopped.');
      } else {
        S.error = e.message || String(e);
        setStatus('');
      }
    } finally {
      S.loading = false;
      S.abort = null;
      if (S.items.length) await saveCache();
      syncControls();
      scheduleRender();
    }
  }

  // ── Multi-select dropdown (optionally searchable) ──────────────────
  const openMenus = new Set();
  function closeMenus(except) {
    let closed = false;
    for (const m of [...openMenus]) if (m !== except) { m.close(); closed = true; }
    return closed;
  }
  document.addEventListener('pointerdown', e => {
    const path = e.composedPath();
    for (const m of [...openMenus]) if (!path.includes(m.el)) m.close();
  }, true);

  function multiSelect({ label, searchable, allText, onChange }) {
    let options = [];                 // [{ value, text }]
    const selected = new Set();
    const rows = new Map();           // value -> { row, box }

    const valueEl = h('span', { class: 'of-value' });
    const trigger = h('button', { class: 'of-control', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' }, valueEl, icon('down', 20));
    const search = searchable ? h('input', { class: 'ms-search', type: 'search', placeholder: 'Search ' + label.toLowerCase(), 'aria-label': 'Search ' + label.toLowerCase(), oninput: filterRows }) : null;
    const clear = h('button', { class: 'btn text', type: 'button', text: 'Clear', onclick: () => { selected.clear(); syncRows(); onChange([]); } });
    const summary = h('span', { class: 'ms-summary' });
    const list = h('div', { class: 'ms-list', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': label });
    const menu = h('div', { class: 'ms-menu' },
      search ? h('div', { class: 'ms-searchwrap' }, icon('search', 18), search) : null,
      list,
      h('div', { class: 'ms-foot' }, summary, clear));
    const el = h('div', { class: 'of ms' }, h('span', { class: 'of-label', text: label }), trigger, menu);

    const api = { el, open, close, setOptions, setSelected };
    trigger.addEventListener('click', () => (el.classList.contains('open') ? close() : open()));

    function open() {
      closeMenus(api);
      el.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      openMenus.add(api);
      if (search) { search.value = ''; filterRows(); setTimeout(() => search.focus(), 0); }
    }
    function close() {
      el.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      openMenus.delete(api);
    }

    function filterRows() {
      const q = search ? search.value.trim().toLowerCase() : '';
      let visible = 0;
      for (const o of options) {
        const r = rows.get(o.value);
        const show = !q || o.text.toLowerCase().includes(q);
        r.row.style.display = show ? '' : 'none';
        if (show) visible++;
      }
      list.dataset.empty = visible === 0 ? 'true' : 'false';
    }

    function syncRows() {
      for (const o of options) rows.get(o.value).box.checked = selected.has(o.value);
      const n = selected.size;
      const only = n === 1 ? options.find(o => selected.has(o.value)) : null;
      valueEl.textContent = n === 0 ? allText : n === 1 ? (only ? only.text : [...selected][0]) : n + ' selected';
      valueEl.classList.toggle('placeholder', n === 0);
      summary.textContent = n ? n + ' selected' : '';
      clear.disabled = n === 0;
    }

    function setOptions(next) {
      options = next;
      rows.clear();
      list.replaceChildren(...options.map(o => {
        const box = h('input', { type: 'checkbox', onchange: () => {
          if (box.checked) selected.add(o.value); else selected.delete(o.value);
          syncRows(); onChange([...selected]);
        } });
        const row = h('label', { class: 'ms-row', role: 'option' }, box, h('span', { text: o.text }));
        rows.set(o.value, { row, box });
        return row;
      }));
      syncRows();
      filterRows();
    }

    function setSelected(values) {
      selected.clear();
      values.forEach(v => selected.add(v));
      syncRows();
    }

    setOptions([]);
    return api;
  }

  // ── UI scaffold (Shadow DOM keeps our styles away from the site) ───
  const host = h('div', { id: 'c1s-host' });
  const root = host.attachShadow({ mode: 'open' });
  const R = {};   // element refs

  // Material Design 3 tokens: color roles, shape and type scale
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .ui {
      --primary: #0b5fa5; --on-primary: #ffffff;
      --primary-container: #d3e4ff; --on-primary-container: #001c38;
      --secondary-container: #d8e3f3; --on-secondary-container: #111c2b;
      --tertiary: #36695a; --tertiary-container: #dce8e1; --on-tertiary-container: #14291f;
      --error-container: #ffdad6; --on-error-container: #410002;
      --surface: #f8f9fe; --surface-low: #f2f3f9; --surface-container: #ecedf3; --surface-high: #e6e8ee;
      --on-surface: #191c20; --on-surface-variant: #43474e;
      --outline: #73777f; --outline-variant: #c3c7cf;
      --shadow: 0 1px 2px rgba(0,0,0,.3), 0 2px 6px 2px rgba(0,0,0,.15);
      --shadow-3: 0 1px 3px rgba(0,0,0,.3), 0 4px 8px 3px rgba(0,0,0,.15);
      font: 400 14px/20px Roboto, "Google Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      letter-spacing: .01em;
      color: var(--on-surface);
    }
    button, input, select { font: inherit; letter-spacing: inherit; color: inherit; }
    :focus-visible { outline: 3px solid var(--primary); outline-offset: 2px; }

    /* State layer (hover / pressed), as in M3 */
    .btn, .chip, .fab, .icon-btn, .ms-row { position: relative; overflow: hidden; }
    .btn::before, .chip::before, .fab::before, .icon-btn::before {
      content: ''; position: absolute; inset: 0; background: currentColor; opacity: 0; transition: opacity .15s;
    }
    .btn:hover::before, .chip:hover::before, .fab:hover::before, .icon-btn:hover::before { opacity: .08; }
    .btn:active::before, .chip:active::before, .fab:active::before, .icon-btn:active::before { opacity: .12; }
    @media (prefers-reduced-motion: reduce) { .btn::before, .chip::before { transition: none; } }

    /* Buttons */
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 40px; padding: 0 24px;
      border-radius: 20px; border: 0; background: transparent; font-weight: 500; cursor: pointer; white-space: nowrap;
    }
    .btn.filled { background: var(--primary); color: var(--on-primary); }
    .btn.tonal { background: var(--secondary-container); color: var(--on-secondary-container); }
    .btn.outlined { border: 1px solid var(--outline); color: var(--primary); }
    .btn.text { color: var(--primary); padding: 0 12px; }
    .btn[disabled] { cursor: default; opacity: .38; }
    .btn[disabled]::before { display: none; }
    .btn.filled[disabled], .btn.tonal[disabled] { background: color-mix(in srgb, var(--on-surface) 12%, transparent); color: var(--on-surface); opacity: .6; }
    .icon-btn {
      display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border: 0;
      border-radius: 50%; background: transparent; color: var(--on-surface-variant); cursor: pointer;
    }
    .fab {
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; height: 56px; padding: 0 20px; border: 0;
      border-radius: 16px; background: var(--primary-container); color: var(--on-primary-container);
      font-weight: 500; font-size: 14px; cursor: pointer; box-shadow: var(--shadow-3);
      display: inline-flex; align-items: center; gap: 12px;
    }

    /* Surface */
    .overlay { position: fixed; inset: 0; z-index: 2147483001; background: var(--surface); display: none; flex-direction: column; }
    .overlay.open { display: flex; }
    .appbar { display: flex; align-items: center; gap: 8px; min-height: 64px; padding: 8px 12px 8px 20px; background: var(--surface-container); flex-wrap: wrap; }
    .titles { margin-right: auto; display: flex; flex-direction: column; min-width: 0; }
    .titles h1 { margin: 0; font: 400 22px/28px Roboto, "Google Sans", ui-sans-serif, system-ui, sans-serif; letter-spacing: 0; }
    .count { font-size: 12px; line-height: 16px; color: var(--on-surface-variant); font-variant-numeric: tabular-nums; }

    /* Filters */
    .tools { position: relative; z-index: 5; padding: 20px 20px 12px; display: grid; gap: 16px; background: var(--surface); }
    .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
    .filters { flex-wrap: nowrap; }
    .of { position: relative; flex: 0 1 150px; min-width: 120px; }
    .of.grow { flex: 1 1 170px; min-width: 130px; }
    .of.sort { flex: 0 0 200px; }
    .of.narrow { flex: 0 0 112px; min-width: 100px; }
    .settings .of.narrow { flex: 0 0 120px; }
    @media (max-width: 1200px) { .filters { flex-wrap: wrap; } .of { flex-basis: 170px; } .of.grow { flex-basis: 220px; } }
    .of-label {
      position: absolute; top: -8px; left: 12px; padding: 0 4px; background: var(--surface); z-index: 1;
      font-size: 12px; line-height: 16px; color: var(--on-surface-variant); pointer-events: none;
    }
    .of:focus-within > .of-label, .of.open > .of-label { color: var(--primary); }
    .of input[type=text], .of input[type=number], .of input.field, .of select, .of-control {
      width: 100%; height: 48px; padding: 0 12px; border: 1px solid var(--outline); border-radius: 4px;
      background: transparent; color: var(--on-surface); text-align: left;
    }
    .of input.field.lead { padding-left: 40px; }
    .of .lead-icon { position: absolute; left: 12px; top: 14px; color: var(--on-surface-variant); pointer-events: none; }
    .of:focus-within input, .of:focus-within select, .of.open .of-control { border-color: var(--primary); box-shadow: inset 0 0 0 1px var(--primary); outline: none; }
    .of input:hover:not(:focus), .of select:hover:not(:focus), .of-control:hover { border-color: var(--on-surface); }
    .of select { appearance: none; padding-right: 36px; cursor: pointer; }
    .of select option { background: var(--surface); color: var(--on-surface); }
    .of .chev { position: absolute; right: 10px; top: 14px; pointer-events: none; color: var(--on-surface-variant); }
    .of-control { display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; }
    .of-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .of-value.placeholder { color: var(--on-surface-variant); }

    .ms-menu {
      display: none; position: absolute; top: calc(100% + 4px); left: 0; min-width: 100%; width: max-content; max-width: 340px;
      background: var(--surface-container); border-radius: 4px; box-shadow: var(--shadow-3); z-index: 20; padding: 8px 0 0;
    }
    .of.open .ms-menu { display: block; }
    .ms-searchwrap { display: flex; align-items: center; gap: 8px; margin: 0 12px 8px; padding: 0 12px; height: 40px; border-radius: 20px; background: var(--surface-high); color: var(--on-surface-variant); }
    .ms-search { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--on-surface); height: 100%; }
    .ms-list { max-height: 280px; overflow-y: auto; padding: 4px 0; min-width: 200px; }
    .ms-list[data-empty="true"]::after { content: 'No matches'; display: block; padding: 12px 16px; color: var(--on-surface-variant); }
    .ms-row { display: flex; align-items: center; gap: 12px; padding: 0 16px; height: 44px; cursor: pointer; }
    .ms-row:hover { background: color-mix(in srgb, var(--on-surface) 8%, transparent); }
    .ms-row input { width: 18px; height: 18px; margin: 0; accent-color: var(--primary); flex: none; }
    .ms-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ms-foot { display: flex; align-items: center; justify-content: space-between; padding: 4px 8px 4px 16px; border-top: 1px solid var(--outline-variant); }
    .ms-summary { color: var(--on-surface-variant); font-size: 12px; }

    .chips { display: flex; gap: 8px; flex-wrap: wrap; }
    .chip {
      display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px; border-radius: 8px; cursor: pointer;
      border: 1px solid var(--outline); background: transparent; color: var(--on-surface-variant); font-weight: 500;
    }
    .chip[aria-pressed="true"] { background: var(--secondary-container); color: var(--on-secondary-container); border-color: transparent; padding-left: 8px; }
    .chip.toggle { margin-left: 8px; }
    .chip small { font-size: 12px; font-weight: 400; opacity: .8; font-variant-numeric: tabular-nums; }

    .settings { display: none; gap: 12px; flex-wrap: wrap; align-items: center; padding: 16px; border-radius: 12px; background: var(--surface-low); }
    .settings.open { display: flex; }
    .settings .of-label { background: var(--surface-low); }

    .notice { margin: 0 20px 8px; padding: 12px 16px; border-radius: 12px; background: var(--secondary-container); color: var(--on-secondary-container); }
    .notice.err { background: var(--error-container); color: var(--on-error-container); }
    .progress { height: 4px; background: var(--secondary-container); overflow: hidden; }
    .progress > i { display: block; height: 100%; width: 35%; background: var(--primary); border-radius: 2px; animation: slide 1.2s ease-in-out infinite; }
    @media (prefers-reduced-motion: reduce) { .progress > i { animation: none; width: 100%; } }
    @keyframes slide { 0% { margin-left: -35%; } 100% { margin-left: 100%; } }

    /* Cards (outlined card, M3) */
    main { flex: 1; overflow-y: auto; padding: 8px 20px 48px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
    .card {
      display: flex; flex-direction: column; gap: 12px; padding: 16px; border-radius: 12px;
      background: var(--surface); border: 1px solid var(--outline-variant);
    }
    .card:hover { background: var(--surface-low); }
    .head { min-width: 0; }
    .merchant { font: 500 16px/24px Roboto, "Google Sans", ui-sans-serif, system-ui, sans-serif; letter-spacing: .01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .supporting { font-size: 12px; line-height: 16px; color: var(--on-surface-variant); }
    .title { color: var(--on-surface-variant); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 40px; }
    .reward { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-radius: 12px; background: var(--tertiary-container); color: var(--on-tertiary-container); }
    .reward .big { font: 500 28px/36px Roboto, "Google Sans", ui-sans-serif, system-ui, sans-serif; letter-spacing: 0; font-variant-numeric: tabular-nums; }
    .reward .detail { display: flex; flex-direction: column; font-size: 14px; line-height: 20px; }
    .reward .detail small { font-size: 12px; opacity: .85; font-variant-numeric: tabular-nums; }
    .price { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; font-variant-numeric: tabular-nums; }
    .price b { font-weight: 500; font-size: 16px; }
    .price s { color: var(--on-surface-variant); }
    .price .off { color: var(--tertiary); font-weight: 500; }
    .price .after { font-size: 12px; color: var(--on-surface-variant); }
    .note { font-size: 12px; line-height: 16px; color: var(--on-surface-variant); }
    .note.soon { color: var(--tertiary); font-weight: 500; }
    details { font-size: 12px; line-height: 16px; color: var(--on-surface-variant); }
    details summary { cursor: pointer; padding: 4px 0; }
    details p { margin: 4px 0 0; }
    .card .btn { margin-top: auto; text-decoration: none; width: 100%; }
    .empty { text-align: center; color: var(--on-surface-variant); padding: 64px 0; grid-column: 1 / -1; }
    @media (max-width: 640px) { .tools, main { padding-left: 12px; padding-right: 12px; } .notice { margin-left: 12px; margin-right: 12px; } .appbar { padding-left: 16px; } }
  `;

  function outlined(label, control, cls = '') {
    return h('div', { class: 'of ' + cls }, h('span', { class: 'of-label', text: label }), control);
  }

  function buildUI() {
    R.launcher = h('button', { class: 'fab', onclick: openOverlay }, icon('tune', 20), 'Offers explorer');

    R.count = h('span', { class: 'count' });
    R.reload = h('button', { class: 'btn filled', onclick: () => loadAll() }, icon('refresh', 18), 'Reload offers');
    R.stop = h('button', { class: 'btn outlined', text: 'Stop', onclick: () => S.abort && S.abort.abort() });
    R.gear = h('button', { class: 'btn text', text: 'Settings', onclick: () => R.settings.classList.toggle('open') });
    R.close = h('button', { class: 'icon-btn', 'aria-label': 'Close', title: 'Close', onclick: closeOverlay }, icon('close', 24));

    R.q = h('input', { class: 'field lead', type: 'text', autocomplete: 'off', placeholder: 'Name or keyword', oninput: e => setFilter({ q: e.target.value }) });
    R.sort = h('select', { onchange: e => { S.sort = e.target.value; scheduleRender(); } },
      Object.entries(SORTS).map(([k, v]) => h('option', { value: k, text: v.label })));

    R.kind = multiSelect({ label: 'Reward', allText: 'All rewards', onChange: v => setFilter({ kinds: v }) });
    R.kind.setOptions([{ value: 'bonus', text: 'Bonus on spend' }, { value: 'cashback', text: 'Cashback' }]);
    R.level = multiSelect({ label: 'Offer type', allText: 'All types', onChange: v => setFilter({ levels: v }) });
    R.level.setOptions([{ value: 'product', text: 'Product deals' }, { value: 'promotion', text: 'Promotions' }, { value: 'merchant', text: 'Store-wide' }]);
    R.merchant = multiSelect({ label: 'Merchant', allText: 'All merchants', searchable: true, onChange: v => setFilter({ merchants: v }) });
    R.merchantKey = '';

    R.minBonus = h('input', { class: 'field', type: 'number', min: '0', step: '1', placeholder: 'Any', oninput: e => setFilter({ minBonus: e.target.value === '' ? null : +e.target.value }) });
    R.maxSpend = h('input', { class: 'field', type: 'number', min: '0', step: '1', placeholder: 'Any', oninput: e => setFilter({ maxSpend: e.target.value === '' ? null : +e.target.value }) });
    R.chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Categories' });

    const mk = (label, val, type, min, max, step) => {
      const input = h('input', { type, min, max, step, value: val });
      return { el: outlined(label, input, 'narrow'), input };
    };
    R.setPages = mk('Max pages', S.settings.maxPages, 'number', 1, 200, 1);
    R.setDelay = mk('Delay (ms)', S.settings.delayMs, 'number', 200, 10000, 100);
    R.setCache = mk('Cache (min)', S.settings.cacheMinutes, 'number', 0, 240, 5);
    R.setState = mk('State', S.settings.state, 'text');
    R.setZip = mk('ZIP code', S.settings.zipcode, 'text');
    R.settings = h('div', { class: 'settings' }, R.setPages.el, R.setDelay.el, R.setCache.el, R.setState.el, R.setZip.el,
      h('button', { class: 'btn filled', text: 'Save settings', onclick: applySettings }));

    R.notice = h('div', { class: 'notice', style: 'display:none' });
    R.progress = h('div', { class: 'progress', style: 'display:none' }, h('i'));
    R.grid = h('div', { class: 'grid' });
    R.main = h('main', {}, R.grid);

    R.onePer = h('button', { class: 'chip toggle', type: 'button', 'aria-pressed': 'false', onclick: () => setFilter({ onePerMerchant: !S.filters.onePerMerchant }) });

    const tools = h('section', { class: 'tools' },
      h('div', { class: 'row filters' },
        h('div', { class: 'of grow' }, h('span', { class: 'of-label', text: 'Search' }), h('span', { class: 'lead-icon' }, icon('search', 20)), R.q),
        h('div', { class: 'of sort' }, h('span', { class: 'of-label', text: 'Sort by' }), R.sort, h('span', { class: 'chev' }, icon('down', 20))),
        R.kind.el, R.level.el, R.merchant.el,
        outlined('Min bonus ($)', R.minBonus, 'narrow'),
        outlined('Max spend ($)', R.maxSpend, 'narrow')),
      R.chips,
      R.settings);

    R.overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-label': 'Capital One Shopping offers' },
      h('header', { class: 'appbar' },
        h('div', { class: 'titles' }, h('h1', { text: 'Capital One Shopping' }), R.count),
        R.reload, R.stop, R.gear, R.close),
      tools, R.notice, R.progress, R.main);

    root.append(h('style', { text: CSS }), h('div', { class: 'ui' }, R.launcher, R.overlay));
  }

  // ── Actions ────────────────────────────────────────────────────────
  function setStatus(msg) { S.status = msg; syncNotice(); }

  function setFilter(patch) {
    Object.assign(S.filters, patch);
    scheduleRender();
  }

  async function applySettings() {
    const clamp = (v, lo, hi, d) => { v = parseInt(v, 10); return isNaN(v) ? d : Math.min(hi, Math.max(lo, v)); };
    S.settings.maxPages = clamp(R.setPages.input.value, 1, 200, DEFAULT_SETTINGS.maxPages);
    S.settings.delayMs = clamp(R.setDelay.input.value, 200, 10000, DEFAULT_SETTINGS.delayMs);
    S.settings.cacheMinutes = clamp(R.setCache.input.value, 0, 240, DEFAULT_SETTINGS.cacheMinutes);
    S.settings.state = (R.setState.input.value || '').trim().toUpperCase().slice(0, 2) || DEFAULT_SETTINGS.state;
    S.settings.zipcode = (R.setZip.input.value || '').trim().slice(0, 10) || DEFAULT_SETTINGS.zipcode;
    await saveSettings();
    R.settings.classList.remove('open');
    setStatus('Settings saved. Reload offers to apply them.');
  }

  async function openOverlay() {
    S.open = true;
    R.overlay.classList.add('open');
    document.documentElement.style.overflow = 'hidden';
    R.q.focus();
    if (S.items.length === 0 && !S.loading) {
      const c = await readCache();
      const fresh = c && (Date.now() - c.ts) < S.settings.cacheMinutes * 60000;
      if (fresh) {
        S.items = c.items; S.ids = new Set(c.items.map(i => i.id)); S.loadedAt = c.ts;
        scheduleRender();
      } else {
        loadAll();
      }
    }
    scheduleRender();
  }

  function closeOverlay() {
    closeMenus();
    S.open = false;
    R.overlay.classList.remove('open');
    document.documentElement.style.overflow = '';
  }

  // ── Rendering ──────────────────────────────────────────────────────
  let renderTimer = null;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = null; render(); }, 120);
  }

  function currentResults() { return query(S.items, S.filters, S.sort); }

  function syncControls() {
    R.reload.disabled = S.loading;
    R.stop.disabled = !S.loading;
    R.progress.style.display = S.loading ? 'block' : 'none';
    syncNotice();
  }

  function syncNotice() {
    const stale = S.loadedAt && !S.loading && (Date.now() - S.loadedAt) > S.settings.cacheMinutes * 60000;
    const msg = S.error || S.status ||
      (stale ? 'These offers were loaded ' + ago(S.loadedAt) + '. Reload to refresh the activation links.' : '');
    R.notice.textContent = msg;
    R.notice.className = 'notice' + (S.error ? ' err' : '');
    R.notice.style.display = msg ? 'block' : 'none';
  }

  function refreshOptions() {
    // Category chips: toggle several at once; counts reflect every other active filter.
    const base = query(S.items, { ...S.filters, labels: [] }, 'site');
    const counts = new Map();
    for (const i of base) counts.set(i.label, (counts.get(i.label) || 0) + 1);
    const labels = [...new Set(S.items.map(i => i.label))].sort();
    R.chips.replaceChildren(
      chip(null, 'All', base.length),
      ...labels.map(l => chip(l, l, counts.get(l) || 0)),
      R.onePer);

    R.onePer.replaceChildren(S.filters.onePerMerchant ? icon('check', 18) : '', 'One offer per merchant');
    R.onePer.setAttribute('aria-pressed', String(S.filters.onePerMerchant));

    // Merchant options only change when new merchants arrive, so an open menu keeps its scroll and search.
    const merchants = [...new Set(S.items.map(i => i.merchant))].sort((a, b) => a.localeCompare(b));
    const key = merchants.join('\u0001');
    if (key !== R.merchantKey) {
      R.merchantKey = key;
      R.merchant.setOptions(merchants.map(m => ({ value: m, text: m })));
      R.merchant.setSelected(S.filters.merchants);
    }
  }

  function chip(value, text, n) {
    const on = value === null ? S.filters.labels.length === 0 : S.filters.labels.includes(value);
    return h('button', {
      class: 'chip', type: 'button', 'aria-pressed': String(on),
      onclick: () => {
        if (value === null) return setFilter({ labels: [] });
        const cur = S.filters.labels;
        setFilter({ labels: cur.includes(value) ? cur.filter(x => x !== value) : [...cur, value] });
      }
    }, on ? icon('check', 18) : '', text, h('small', { text: String(n) }));
  }

  function card(i) {
    let reward;
    if (i.bonus != null) {
      reward = h('div', { class: 'reward' },
        h('div', { class: 'big', text: money(i.bonus) }),
        h('div', { class: 'detail' },
          h('span', { text: 'back on ' + money(i.bonusSpend) + ' spend' }),
          i.bonusRatio != null ? h('small', { text: pct(i.bonusRatio) + ' of spend' + (i.cashbackText ? ' · also ' + i.cashbackText + ' cashback' : '') }) : null));
    } else if (i.cashbackText) {
      reward = h('div', { class: 'reward' },
        h('div', { class: 'big', text: i.cashbackText.replace(/\s*back$/i, '') }),
        h('div', { class: 'detail' }, h('span', { text: 'cashback' }), i.maxPayout ? h('small', { text: 'up to ' + i.maxPayout + ' total' }) : null));
    } else {
      reward = h('div', { class: 'reward' }, h('div', { class: 'detail' }, h('span', { text: 'See offer details' })));
    }

    const tiers = i.tiers.length > 1
      ? h('div', { class: 'note', text: 'Tiers: ' + i.tiers.map(t => `${t.amountText} on ${t.spendText}`).join(', ') }) : null;

    const price = i.newPrice != null ? h('div', { class: 'price' },
      h('b', { text: money(i.newPrice) }),
      i.oldPrice != null ? h('s', { text: money(i.oldPrice) }) : null,
      i.percentOff != null ? h('span', { class: 'off', text: pct(i.percentOff) + ' off' }) : null,
      i.priceAfterRewards != null ? h('span', { class: 'after', text: money(i.priceAfterRewards) + ' after cashback' }) : null) : null;

    const soon = i.end != null && i.end > Date.now() && i.end - Date.now() <= 24 * 3600000;
    const notes = [];
    if (i.popularity != null) notes.push(i.popularity.toLocaleString() + ' popularity');
    if (i.end != null) notes.push(timeLeft(i.end));

    return h('article', { class: 'card' },
      h('div', { class: 'head' },
        h('div', { class: 'merchant', text: i.merchant, title: i.merchant }),
        h('div', { class: 'supporting', text: i.label })),
      h('div', { class: 'title', text: i.title, title: i.title }),
      reward, tiers, price,
      notes.length ? h('div', { class: 'note' + (soon ? ' soon' : ''), text: notes.join(' · ') }) : null,
      i.subtitle ? h('div', { class: 'note', text: i.subtitle }) : null,
      i.exclusions ? h('details', {}, h('summary', { text: 'Exclusions' }), h('p', { text: i.exclusions })) : null,
      h('a', { class: 'btn filled', href: i.href, target: '_blank', rel: 'noopener', text: i.cta }));
  }

  function render() {
    if (!R.overlay) return;
    syncControls();
    if (!S.open) return;
    refreshOptions();
    const res = currentResults();
    R.count.textContent = S.items.length
      ? `${res.length.toLocaleString()} of ${S.items.length.toLocaleString()} offers` + (S.loadedAt ? ' · loaded ' + ago(S.loadedAt) : '')
      : '';

    if (res.length === 0) {
      R.grid.replaceChildren(h('div', { class: 'empty', text: S.loading ? 'Loading offers…' : S.items.length ? 'No offers match these filters. Remove a filter to see more.' : 'No offers loaded yet. Select Reload offers.' }));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const i of res) frag.append(card(i));
    R.grid.replaceChildren(frag);
  }

  // ── Lifecycle: only active on the home feed (path "/") ─────────────
  function onHome() { return location.pathname === '/'; }

  function syncVisibility() {
    const home = onHome();
    host.style.display = home ? '' : 'none';
    if (!home && S.open) closeOverlay();
  }

  async function init() {
    await loadSettings();
    buildUI();
    document.documentElement.append(host);
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !S.open) return;
      if (!closeMenus()) closeOverlay();   // close an open dropdown first
    });
    syncVisibility();
    setInterval(syncVisibility, 700);   // the site is a single-page app, so watch for route changes
    syncControls();
  }

  init();
})();
