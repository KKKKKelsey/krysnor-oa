/* Krysnor OA — web page (step 2: sign-in, service reports, offline outbox).
 * Data lives in Kaixin's private Google Sheet; this page only talks to the Apps Script API.
 * Offline: the last synced data is kept on the device; new reports wait in an outbox and
 * upload by themselves when the connection comes back. */
(function () {
  'use strict';

  const CFG = window.OA_CONFIG || {};
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('oa.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('oa.' + k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
    del(k) { try { localStorage.removeItem('oa.' + k); } catch (e) { /* ignore */ } },
  };

  const state = {
    token: LS.get('token', null),        // { value, exp, email }
    me: LS.get('me', null),              // { user, oaName, rootFolderId }
    data: LS.get('data', null),          // bootstrap payload
    outbox: [],
    syncing: false,
    filters: { q: '', tech: '', type: '', follow: false },
    index: null,                         // company-sheet rows the user may see { version, items, sources }
    search: '',
    week: null,                          // Monday of the week shown in Schedule
  };

  // ───────── helpers ─────────
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const online = () => navigator.onLine;
  const can = (p) => !!(state.me && state.me.user && (state.me.user.isAdmin || state.me.user.permissions.indexOf(p) >= 0));
  const fmtDate = (v) => {
    if (!v) return '';
    const d = new Date(v); if (isNaN(d)) return String(v);
    return d.toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const ago = (v) => {
    if (!v) return 'never';
    const m = Math.round((Date.now() - new Date(v).getTime()) / 60000);
    if (m < 1) return 'now'; if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60); if (h < 24) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  };
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '').split('-')[0];
  function toast(msg) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 3200);
  }
  function banner(msg, isError) {
    const b = $('#banner');
    if (!msg) { b.hidden = true; return; }
    b.textContent = msg; b.className = 'banner' + (isError ? ' error' : ''); b.hidden = false;
  }
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  // ───────── outbox in IndexedDB (photos are too big for localStorage) ─────────
  const DB = {
    _db: null,
    open() {
      if (this._db) return Promise.resolve(this._db);
      return new Promise((res, rej) => {
        const r = indexedDB.open('krysnor-oa', 2);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'client_id' });
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        };
        r.onsuccess = () => { this._db = r.result; res(this._db); };
        r.onerror = () => rej(r.error);
      });
    },
    async tx(mode, fn, storeName) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const name = storeName || 'outbox';
        const t = db.transaction(name, mode); const store = t.objectStore(name);
        const out = fn(store);
        t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
        t.onerror = () => rej(t.error);
      });
    },
    all() { return this.tx('readonly', (s) => s.getAll()); },
    put(item) { return this.tx('readwrite', (s) => s.put(item)); },
    del(id) { return this.tx('readwrite', (s) => s.delete(id)); },
    getKv(k) { return this.tx('readonly', (s) => s.get(k), 'kv'); },
    setKv(k, v) { return this.tx('readwrite', (s) => s.put(v, k), 'kv'); },
  };
  async function loadOutbox() {
    try { state.outbox = (await DB.all()).sort((a, b) => a.created.localeCompare(b.created)); }
    catch (e) { state.outbox = []; }
    const c = $('#outbox-count'); c.textContent = state.outbox.length; c.hidden = !state.outbox.length;
  }

  // ───────── sign-in (Google Identity Services) ─────────
  function tokenValid() { return state.token && state.token.exp * 1000 > Date.now() + 60000; }
  function decodeJwt(t) {
    const p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(p + '==='.slice((p.length + 3) % 4)))));
  }
  function gisReady() { return !!(window.google && google.accounts && google.accounts.id && CFG.clientId); }
  let gisInitialised = false;
  function initGis() {
    if (gisInitialised || !gisReady()) return gisInitialised;
    google.accounts.id.initialize({
      client_id: CFG.clientId, auto_select: true, cancel_on_tap_outside: false,
      callback: (resp) => onCredential(resp.credential),
    });
    gisInitialised = true;
    return true;
  }
  async function onCredential(credential) {
    const p = decodeJwt(credential);
    state.token = { value: credential, exp: p.exp, email: p.email };
    LS.set('token', state.token);
    banner('');
    try {
      const me = await api('me');
      state.me = me; LS.set('me', me);
      await refreshData();
      renderChrome(); route();
      syncOutbox();
    } catch (e) {
      banner(e.message, true);
    }
  }
  function renewSignIn() {
    // Silent renewal when Google remembers the account; otherwise the button is shown.
    if (initGis()) google.accounts.id.prompt();
  }
  function signOut() {
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
    state.token = null; state.me = null; state.data = null;
    LS.del('token'); LS.del('me'); LS.del('data');
    $('#user-menu').hidden = true;
    renderChrome(); route();
  }

  // ───────── API ─────────
  async function api(action, payload) {
    if (!CFG.apiUrl) throw new Error('The OA is not connected yet (apiUrl missing in config.js).');
    if (!online()) throw new Error('You are offline.');
    if (!tokenValid()) { renewSignIn(); throw new Error('Please sign in again.'); }
    const res = await fetch(CFG.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // keeps the request "simple": no CORS preflight
      body: JSON.stringify({ token: state.token.value, action, payload: payload || {} }),
    });
    if (!res.ok) throw new Error('Server error ' + res.status);
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || 'Request failed');
    return body.data;
  }
  async function refreshData() {
    const d = await api('bootstrap');
    state.data = d; LS.set('data', d);
    if (!state.index) { try { state.index = (await DB.getKv('index')) || null; } catch (e) { state.index = null; } }
    if (!state.index || state.index.version !== d.indexVersion || !d.indexVersion) {
      try {
        const idx = await api('searchIndex');
        state.index = idx; await DB.setKv('index', idx);
      } catch (e) { /* keep the copy on this device */ }
    }
  }
  async function loadIndexFromDevice() {
    if (state.index) return;
    try { state.index = (await DB.getKv('index')) || null; } catch (e) { state.index = null; }
  }

  // ───────── sync ─────────
  async function syncOutbox() {
    if (state.syncing) return;
    await loadOutbox();
    if (!online() || !tokenValid() || !CFG.apiUrl) { renderSync(); return; }
    state.syncing = true; renderSync();
    let sent = 0;
    for (const item of state.outbox) {
      try {
        await api('createReport', item.payload);
        await DB.del(item.client_id); sent++;
      } catch (e) {
        item.error = e.message; item.tries = (item.tries || 0) + 1;
        await DB.put(item);
        if (/offline|sign in/i.test(e.message)) break;
      }
    }
    try { await refreshData(); } catch (e) { /* keep cached data */ }
    state.syncing = false;
    await loadOutbox();
    renderSync();
    if (sent) toast(sent + ' report' + (sent > 1 ? 's' : '') + ' uploaded');
    route();
  }

  // ───────── chrome (top bar, tabs) ─────────
  function renderSync() {
    const pill = $('#sync-pill'); const txt = $('#sync-text');
    pill.classList.toggle('online', online());
    pill.classList.toggle('busy', state.syncing);
    if (state.syncing) txt.textContent = 'Syncing…';
    else if (!online()) txt.textContent = 'Offline · ' + ago(state.data && state.data.syncedAt);
    else if (!tokenValid() && state.me) txt.textContent = 'Sign in to sync';
    else txt.textContent = 'Synced ' + ago(state.data && state.data.syncedAt);
  }
  function userColor(name) {
    const u = state.data && state.data.users.find((x) => x.name === name);
    return (u && u.color) || '#8A99A6';
  }
  function renderChrome() {
    const signedIn = !!state.me;
    $('#tabs').hidden = !signedIn;
    $('#tab-new').hidden = !can('report.create');
    $('#tab-sites').hidden = !can('site.create');
    const chip = $('#user-chip');
    chip.hidden = !signedIn;
    if (signedIn) {
      const u = state.me.user;
      chip.innerHTML = '<span class="avatar" style="background:' + esc(userColor(u.name)) + '">' +
        esc((u.name || '?').slice(0, 1)) + '</span>' + esc(u.name);
      $('#user-menu-text').textContent = u.email + ' · ' + u.roles.join(', ');
      $('#oa-name').textContent = state.me.oaName || 'Krysnor OA';
    }
    renderSync();
  }

  // ───────── views ─────────
  const view = () => $('#view');

  function renderSignIn() {
    view().innerHTML =
      '<div class="signin"><h1>Krysnor OA</h1>' +
      '<p class="muted">Sign in with the Google account Kaixin added for you. ' +
      'After the first sign-in this page also works without signal.</p>' +
      '<div id="gbtn"></div><p class="muted" id="signin-note"></p></div>';
    const note = $('#signin-note');
    if (!CFG.clientId || !CFG.apiUrl) { note.textContent = 'Not connected yet: config.js still needs apiUrl and clientId.'; return; }
    if (!online()) { note.textContent = 'You are offline. Connect once to sign in.'; return; }
    const tryRender = (n) => {
      if (initGis()) {
        google.accounts.id.renderButton($('#gbtn'), { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill' });
        google.accounts.id.prompt();
      } else if (n > 0) setTimeout(() => tryRender(n - 1), 300);
      else note.textContent = 'Google sign-in could not load. Check the connection and reload.';
    };
    tryRender(20);
  }

  function allReports() {
    const server = (state.data && state.data.reports) || [];
    const pending = state.outbox.map((o) => Object.assign({}, o.payload, {
      report_id: 'Waiting', pending: true, server_time: o.created, tech_name: state.me ? state.me.user.name : '',
      site_name: o.payload.site_name || siteName(o.payload.site_id), _client: o.client_id, error: o.error,
    }));
    return pending.concat(server.slice().sort((a, b) => String(b.server_time).localeCompare(String(a.server_time))));
  }
  function siteName(id) {
    const s = state.data && state.data.sites.find((x) => x.site_id === id);
    return s ? s.name : '';
  }

  function reportCard(r, corrections) {
    const href = r.pending ? '#/outbox' : '#/reports/' + encodeURIComponent(r.report_id);
    return '<a class="card" href="' + href + '">' +
      '<div class="card-top">' +
        (r.pending ? '<span class="chip pending">Waiting to upload</span>' : '<span class="ticket">' + esc(r.report_id) + '</span>') +
        '<span class="chip t-' + slug(r.call_type) + '">' + esc(r.call_type) + '</span>' +
        (isTrue(r.follow_up_needed) ? '<span class="chip flag">Follow-up</span>' : '') +
        (corrections ? '<span class="chip fix">' + corrections + ' correction' + (corrections > 1 ? 's' : '') + '</span>' : '') +
      '</div>' +
      '<div class="card-title">' + esc(r.site_name || '—') + '</div>' +
      '<div class="card-body">' + esc(r.work_done) + '</div>' +
      '<div class="card-meta"><span class="who"><i style="background:' + esc(userColor(r.tech_name)) + '"></i>' +
        esc(r.tech_name) + '</span><span class="mono">' + esc(fmtDate(r.server_time)) + '</span></div>' +
    '</a>';
  }
  const isTrue = (v) => v === true || String(v).toUpperCase() === 'TRUE';

  function renderReports() {
    if (!state.data) { view().innerHTML = '<div class="empty">No data on this device yet. Connect to the internet once to download it.</div>'; return; }
    const f = state.filters;
    const reports = allReports();
    const corrections = {};
    reports.forEach((r) => { if (r.amends_report_id) corrections[r.amends_report_id] = (corrections[r.amends_report_id] || 0) + 1; });
    const techs = Array.from(new Set(reports.map((r) => r.tech_name).filter(Boolean))).sort();
    const q = f.q.trim().toLowerCase();
    const shown = reports.filter((r) =>
      !r.amends_report_id &&
      (!f.tech || r.tech_name === f.tech) && (!f.type || r.call_type === f.type) &&
      (!f.follow || isTrue(r.follow_up_needed)) &&
      (!q || [r.report_id, r.site_name, r.problem_found, r.work_done, r.parts_used, r.tech_name].join(' ').toLowerCase().indexOf(q) >= 0));

    view().innerHTML =
      '<div class="filters">' +
        '<input id="f-q" class="search" type="search" placeholder="Search site, work, parts, SR number…" value="' + esc(f.q) + '">' +
        '<select id="f-tech"><option value="">All technicians</option>' +
          techs.map((t) => '<option' + (t === f.tech ? ' selected' : '') + '>' + esc(t) + '</option>').join('') + '</select>' +
        '<select id="f-type"><option value="">All call types</option>' +
          state.data.callTypes.map((t) => '<option' + (t === f.type ? ' selected' : '') + '>' + esc(t) + '</option>').join('') + '</select>' +
        '<label class="check"><input id="f-follow" type="checkbox"' + (f.follow ? ' checked' : '') + '> Follow-up needed only</label>' +
      '</div>' +
      '<div class="list">' + (shown.length ? shown.map((r) => reportCard(r, corrections[r.report_id])).join('')
        : '<div class="empty">' + (reports.length ? 'No reports match these filters.' :
          'No service reports yet.' + (can('report.create') ? ' Tap “New report” after a call.' : '')) + '</div>') + '</div>';

    $('#f-q').addEventListener('input', (e) => { f.q = e.target.value; renderReportsKeepFocus(); });
    $('#f-tech').addEventListener('change', (e) => { f.tech = e.target.value; renderReports(); });
    $('#f-type').addEventListener('change', (e) => { f.type = e.target.value; renderReports(); });
    $('#f-follow').addEventListener('change', (e) => { f.follow = e.target.checked; renderReports(); });
  }
  function renderReportsKeepFocus() {
    const pos = $('#f-q').selectionStart; renderReports();
    const q = $('#f-q'); q.focus(); q.setSelectionRange(pos, pos);
  }

  function renderDetail(id) {
    const reports = (state.data && state.data.reports) || [];
    const r = reports.find((x) => x.report_id === id);
    if (!r) { view().innerHTML = '<div class="empty">Report ' + esc(id) + ' is not on this device. Sync and try again.</div>'; return; }
    const fixes = reports.filter((x) => x.amends_report_id === id)
      .sort((a, b) => String(a.server_time).localeCompare(String(b.server_time)));
    const unit = state.data.units.find((u) => u.unit_id === r.unit_id);
    const row = (k, v) => v ? '<dt>' + k + '</dt><dd>' + esc(v) + '</dd>' : '';
    const mine = state.me && state.me.user.email === String(r.tech_email).toLowerCase();
    view().innerHTML =
      '<p><a href="#/reports">← All reports</a></p>' +
      '<h1><span class="ticket">' + esc(r.report_id) + '</span> ' + esc(r.site_name) + '</h1>' +
      (r.amends_report_id ? '<p class="muted">Correction to <a href="#/reports/' + encodeURIComponent(r.amends_report_id) + '">' + esc(r.amends_report_id) + '</a></p>' : '') +
      '<div class="stamp"><span>Received by server <strong>' + esc(fmtDate(r.server_time)) + '</strong> · cannot be changed</span>' +
        (r.device_time ? '<span class="muted">Written on phone ' + esc(fmtDate(r.device_time)) + '</span>' : '') + '</div>' +
      '<dl class="fields">' +
        row('Technician', r.tech_name) + row('Call type', r.call_type) +
        row('Unit', unit ? unit.label : r.unit_id) + row('Project', r.project_id) +
        row('On site', [r.arrived, r.left].filter(Boolean).join(' – ')) +
        row('Problem found', r.problem_found) + row('Work done', r.work_done) + row('Parts used', r.parts_used) +
        row('Follow-up', isTrue(r.follow_up_needed) ? ('Yes' + (r.follow_up_note ? ' — ' + r.follow_up_note : '')) : '') +
      '</dl>' +
      (r.photos_folder_url ? '<p><a class="btn" href="' + esc(r.photos_folder_url) + '" target="_blank" rel="noopener">Open photos in Drive</a></p>' : '') +
      (fixes.length ? '<h2>Corrections</h2><div class="list">' + fixes.map((x) => reportCard(x)).join('') + '</div>' : '') +
      ((mine && can('report.amend_own')) || (state.me && state.me.user.isAdmin)
        ? '<p class="actions"><a class="btn" href="#/new?amends=' + encodeURIComponent(r.report_id) + '">Add a correction</a></p>' : '') +
      (can('report.delete') ? '<h2>Delete</h2><div class="field" id="del-box">' +
        '<span class="muted">Hides this report' + (fixes.length ? ' and its corrections' : '') + ' for everyone. ' +
        'The sheet keeps the original and records who deleted it, when and why.</span>' +
        '<textarea id="del-reason" placeholder="Reason (required)" style="min-height:60px"></textarea>' +
        '<p class="muted" id="del-error" role="alert"></p>' +
        '<div class="actions"><button class="btn danger" type="button" id="del-btn">Delete report</button></div></div>' : '');
    const delBtn = $('#del-btn');
    if (delBtn) delBtn.addEventListener('click', async () => {
      const reason = $('#del-reason').value.trim(); const err = $('#del-error'); err.textContent = '';
      if (!reason) { err.textContent = 'Please write why this report is being deleted.'; return; }
      if (!delBtn.dataset.armed) {
        delBtn.dataset.armed = '1'; delBtn.textContent = 'Tap again to delete ' + r.report_id;
        setTimeout(() => { if (delBtn.isConnected) { delete delBtn.dataset.armed; delBtn.textContent = 'Delete report'; } }, 4000);
        return;
      }
      delBtn.disabled = true;
      try {
        await api('deleteReport', { report_id: r.report_id, reason });
        await refreshData(); toast(r.report_id + ' deleted'); location.hash = '#/reports';
      } catch (e) { err.textContent = e.message; delBtn.disabled = false; }
    });
  }

  // New report form
  let photoDrafts = [];
  function nowHHMM() { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function renderNew(params) {
    if (!can('report.create')) { view().innerHTML = '<div class="empty">Your role cannot write service reports.</div>'; return; }
    if (!state.data) { view().innerHTML = '<div class="empty">Connect once to download the site list, then you can write reports offline.</div>'; return; }
    const amends = params.get('amends') || '';
    const orig = amends && state.data.reports.find((x) => x.report_id === amends);
    photoDrafts = [];
    const sites = state.data.sites.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    view().innerHTML =
      '<h1>' + (amends ? 'Correction to <span class="ticket">' + esc(amends) + '</span>' : 'New service report') + '</h1>' +
      '<form class="stack" id="rf" novalidate>' +
        '<label class="field"><span>Site</span><select id="r-site" required><option value="">Choose a site…</option>' +
          sites.map((s) => '<option value="' + esc(s.site_id) + '"' + (orig && orig.site_id === s.site_id ? ' selected' : '') + '>' + esc(s.name) + (s.city ? ' · ' + esc(s.city) : '') + '</option>').join('') +
          '<option value="__other">Site not in the list…</option></select></label>' +
        '<label class="field" id="r-site-other-wrap" hidden><span>Site name and address</span><input id="r-site-other" type="text" value="' + esc(orig && !orig.site_id ? orig.site_name : '') + '"></label>' +
        '<div class="row2">' +
          '<label class="field"><span>Unit <small>(optional)</small></span><select id="r-unit"><option value="">—</option></select></label>' +
          '<label class="field"><span>Project <small>(optional)</small></span><select id="r-project"><option value="">—</option></select></label>' +
        '</div>' +
        '<label class="field"><span>Call type</span><select id="r-type" required><option value="">Choose…</option>' +
          state.data.callTypes.map((t) => '<option' + (orig && orig.call_type === t ? ' selected' : '') + '>' + esc(t) + '</option>').join('') + '</select></label>' +
        '<div class="row2">' +
          '<label class="field"><span>Arrived</span><input id="r-arr" type="time" value="' + esc(orig ? orig.arrived : '') + '"></label>' +
          '<label class="field"><span>Left</span><input id="r-left" type="time" value="' + esc(orig ? orig.left : nowHHMM()) + '"></label>' +
        '</div>' +
        '<label class="field"><span>Problem found</span><textarea id="r-problem">' + esc(orig ? orig.problem_found : '') + '</textarea></label>' +
        '<label class="field"><span>Work done</span><textarea id="r-work" required>' + esc(orig ? orig.work_done : '') + '</textarea></label>' +
        '<label class="field"><span>Parts used <small>(optional)</small></span><textarea id="r-parts" style="min-height:60px">' + esc(orig ? orig.parts_used : '') + '</textarea></label>' +
        '<label class="check-row"><input id="r-follow" type="checkbox"' + (orig && isTrue(orig.follow_up_needed) ? ' checked' : '') + '> Follow-up needed</label>' +
        '<label class="field" id="r-follow-wrap" hidden><span>What needs to happen next</span><textarea id="r-follow-note" style="min-height:60px">' + esc(orig ? orig.follow_up_note : '') + '</textarea></label>' +
        '<div class="field"><span>Photos <small>(optional)</small></span>' +
          '<input id="r-photos" type="file" accept="image/*" multiple>' +
          '<div class="thumbs" id="r-thumbs"></div></div>' +
        '<p class="muted" id="r-error" role="alert"></p>' +
        '<div class="actions"><button class="btn primary" type="submit">Save report</button>' +
          '<a class="btn ghost" href="#/reports">Cancel</a></div>' +
        '<p class="muted">Time is stamped automatically. Without signal the report is kept on this phone and uploads by itself later.</p>' +
      '</form>';

    const siteSel = $('#r-site');
    const fillDependents = () => {
      const sid = siteSel.value;
      $('#r-site-other-wrap').hidden = sid !== '__other';
      const units = state.data.units.filter((u) => u.site_id === sid);
      $('#r-unit').innerHTML = '<option value="">—</option>' + units.map((u) =>
        '<option value="' + esc(u.unit_id) + '"' + (orig && orig.unit_id === u.unit_id ? ' selected' : '') + '>' + esc(u.label) + '</option>').join('');
      const projects = state.data.projects.filter((p) => !sid || sid === '__other' || p.site_id === sid);
      $('#r-project').innerHTML = '<option value="">—</option>' + projects.map((p) =>
        '<option value="' + esc(p.project_id) + '"' + (orig && orig.project_id === p.project_id ? ' selected' : '') + '>' + esc(p.project_id + ' · ' + p.title) + '</option>').join('');
    };
    if (orig && !orig.site_id) siteSel.value = '__other';
    siteSel.addEventListener('change', fillDependents); fillDependents();
    const follow = $('#r-follow'); const fw = () => { $('#r-follow-wrap').hidden = !follow.checked; };
    follow.addEventListener('change', fw); fw();
    $('#r-photos').addEventListener('change', async (e) => {
      for (const file of Array.from(e.target.files)) {
        try { photoDrafts.push(await shrinkImage(file)); } catch (err) { toast('Could not read ' + file.name); }
      }
      e.target.value = ''; drawThumbs();
    });
    $('#rf').addEventListener('submit', (e) => { e.preventDefault(); saveReport(amends); });
  }
  function drawThumbs() {
    const box = $('#r-thumbs'); if (!box) return;
    box.innerHTML = photoDrafts.map((p, i) => '<figure><img src="' + p.dataUrl + '" alt="Photo ' + (i + 1) + '">' +
      '<button type="button" data-i="' + i + '" aria-label="Remove photo ' + (i + 1) + '">×</button></figure>').join('');
    box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { photoDrafts.splice(+b.dataset.i, 1); drawThumbs(); }));
  }
  // Phone photos are 3–8 MB; shrink to ≤1600 px JPEG so they upload over weak signal.
  function shrinkImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image(); const url = URL.createObjectURL(file);
      img.onload = () => {
        const max = 1600; const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        const dataUrl = c.toDataURL('image/jpeg', 0.8);
        resolve({ name: file.name.replace(/\.[^.]+$/, '') + '.jpg', mimeType: 'image/jpeg', dataUrl });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }
  async function saveReport(amends) {
    const err = $('#r-error');
    const sid = $('#r-site').value;
    const payload = {
      client_id: uuid(),
      device_time: new Date().toISOString(),
      site_id: sid && sid !== '__other' ? sid : '',
      site_name: sid === '__other' ? $('#r-site-other').value.trim() : siteName(sid),
      unit_id: $('#r-unit').value, project_id: $('#r-project').value,
      call_type: $('#r-type').value, arrived: $('#r-arr').value, left: $('#r-left').value,
      problem_found: $('#r-problem').value.trim(), work_done: $('#r-work').value.trim(),
      parts_used: $('#r-parts').value.trim(),
      follow_up_needed: $('#r-follow').checked, follow_up_note: $('#r-follow').checked ? $('#r-follow-note').value.trim() : '',
      amends_report_id: amends || '',
      photos: photoDrafts.map((p) => ({ name: p.name, mimeType: p.mimeType, base64: p.dataUrl.split(',')[1] })),
    };
    const missing = [];
    if (!payload.site_id && !payload.site_name) missing.push('site');
    if (!payload.call_type) missing.push('call type');
    if (!payload.work_done) missing.push('work done');
    if (missing.length) { err.textContent = 'Please fill in: ' + missing.join(', ') + '.'; return; }
    try {
      await DB.put({ client_id: payload.client_id, created: payload.device_time, payload, tries: 0 });
    } catch (e) {
      err.textContent = 'Could not save on this phone: ' + e.message; return;
    }
    await loadOutbox();
    toast(online() ? 'Saved. Uploading…' : 'Saved on this phone. It will upload when you have signal.');
    location.hash = '#/reports';
    syncOutbox();
  }

  async function renderOutbox() {
    await loadOutbox();
    const items = state.outbox;
    view().innerHTML = '<h1>Waiting to upload</h1>' +
      (items.length ? '<p class="muted">These reports are saved on this phone only. They upload automatically when there is signal' +
        (tokenValid() ? '.' : ' and you are signed in.') + '</p>' +
        '<div class="actions" style="margin-bottom:12px"><button class="btn primary" id="ob-sync" type="button"' + (online() ? '' : ' disabled') + '>Upload now</button></div>' +
        '<div class="list">' + items.map((o) =>
          '<div class="card"><div class="card-top"><span class="chip pending">Saved ' + esc(fmtDate(o.created)) + '</span>' +
          '<span class="chip">' + esc(o.payload.call_type) + '</span>' +
          (o.payload.photos.length ? '<span class="chip">' + o.payload.photos.length + ' photo(s)</span>' : '') + '</div>' +
          '<div class="card-title">' + esc(o.payload.site_name || siteName(o.payload.site_id)) + '</div>' +
          '<div class="card-body">' + esc(o.payload.work_done) + '</div>' +
          (o.error ? '<p class="muted" style="color:var(--crit)">Last attempt: ' + esc(o.error) + '</p>' : '') +
          '<div class="actions"><button class="btn danger" type="button" data-del="' + esc(o.client_id) + '">Delete from phone</button></div></div>'
        ).join('') + '</div>'
      : '<div class="empty">Nothing waiting. Every report on this phone has been uploaded.</div>');
    const s = $('#ob-sync'); if (s) s.addEventListener('click', () => { if (!tokenValid()) renewSignIn(); syncOutbox(); });
    view().querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.armed) { await DB.del(b.dataset.del); renderOutbox(); return; }
      b.dataset.armed = '1'; b.textContent = 'Tap again to delete for good';
      setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = 'Delete from phone'; } }, 4000);
    }));
  }

  function renderSites() {
    if (!can('site.create')) { view().innerHTML = '<div class="empty">Your role cannot add sites.</div>'; return; }
    const sites = (state.data && state.data.sites) || [];
    view().innerHTML = '<h1>Sites</h1>' +
      '<form class="stack" id="sf" novalidate>' +
        '<label class="field"><span>Site name</span><input id="s-name" type="text" required placeholder="e.g. 100 King St W"></label>' +
        '<label class="field"><span>Type</span><select id="s-seg">' +
          state.data.segments.map((s) => '<option value="' + esc(s.segment_id) + '">' + esc(s.name) + '</option>').join('') + '</select></label>' +
        '<div class="row2"><label class="field"><span>Address</span><input id="s-addr" type="text"></label>' +
          '<label class="field"><span>City</span><input id="s-city" type="text"></label></div>' +
        '<div class="row2"><label class="field"><span>Contact name</span><input id="s-cname" type="text"></label>' +
          '<label class="field"><span>Contact phone</span><input id="s-cphone" type="tel"></label></div>' +
        '<label class="field"><span>Contact email</span><input id="s-cemail" type="email"></label>' +
        '<p class="muted" id="s-error" role="alert"></p>' +
        '<div class="actions"><button class="btn primary" type="submit">Add site</button></div>' +
      '</form>' +
      '<h2>' + sites.length + ' sites</h2><div class="list">' +
        sites.map((s) => '<div class="card"><div class="card-top"><span class="ticket">' + esc(s.site_id) + '</span><span class="chip">' +
          esc(s.segment_id) + '</span></div><div class="card-title">' + esc(s.name) + '</div><div class="card-meta">' +
          esc([s.address, s.city].filter(Boolean).join(', ')) + '</div></div>').join('') + '</div>';
    $('#sf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#s-error'); err.textContent = '';
      try {
        await api('createSite', {
          name: $('#s-name').value, segment_id: $('#s-seg').value, address: $('#s-addr').value, city: $('#s-city').value,
          contact_name: $('#s-cname').value, contact_phone: $('#s-cphone').value, contact_email: $('#s-cemail').value,
        });
        await refreshData(); toast('Site added'); renderSites();
      } catch (ex) { err.textContent = ex.message; }
    });
  }

  // ───────── search across company sheets + OA reports ─────────
  const NOT_STREET = ['am','pm','weeks','week','days','day','stops','stop','floors','floor','cars','car','hours','hrs','hr',
    'years','year','months','month','units','unit','sets','set','crew','crews','and','the','for','to','of','min','mins','ext',
    'locks','lock','sec','phones','photos','invoice','invoices','yes','no','jan','feb','mar','apr','jun','jul','aug','sep',
    'sept','oct','nov','dec','january','february','march','april','june','july','august','september','october','november',
    'december','th','nd','rd','st','person','people','pcs','pc','ft','feet','mm','lbs','kg','fpm','hp','v'];
  // Same rule as the server: "260 Russel Hill Rd" and "260 Russell Hill" → "260 russ".
  function addrKey(text) {
    const s = String(text || '').replace(/_/g, ' ').replace(/\d{4}-\d{2}-\d{2}/g, ' ')
      .replace(/\b\d{1,2}([:.]\d{2})?\s*(am|pm)\b/gi, ' ').replace(/\d{1,2}:\d{2}/g, ' ').replace(/[#$]\s*\d+/g, ' ');
    const re = /(?:^|[^\d\w])(\d{1,5})[a-z]?[ \t]*[-,]?[ \t]+([A-Za-z][A-Za-z'.]*)(?:[ \t]+([A-Za-z][A-Za-z'.]*))?/gi;
    let m;
    while ((m = re.exec(s)) !== null) {
      let w = m[2].replace(/[.']/g, '').toLowerCase();
      if (/^(st|saint|mt|mount|ste)$/.test(w) && m[3]) w = w.slice(0, 2) + m[3].replace(/[.']/g, '').toLowerCase();
      if (w.length < 3 || NOT_STREET.indexOf(w) >= 0) continue;
      return m[1] + ' ' + w.slice(0, 4);
    }
    return '';
  }
  function reportItems() {
    return allReports().filter((r) => !r.pending).map((r) => ({
      id: 'R:' + r.report_id, src: 'REPORTS', kind: 'Service report', tab: '', title: r.report_id + ' · ' + (r.site_name || ''),
      addr: r.site_name || '', key: addrKey(r.site_name), date: String(r.server_time || '').slice(0, 10), person: r.tech_name,
      text: [r.call_type, r.problem_found, r.work_done, r.parts_used, r.follow_up_note].filter(Boolean).join('\n'),
      people: [], phones: [], emails: [], url: '#/reports/' + encodeURIComponent(r.report_id), internal: true,
    }));
  }
  function searchItems(q) {
    const items = ((state.index && state.index.items) || []).concat(reportItems());
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const digits = q.replace(/\D/g, '');
    const phoneQuery = digits.length >= 4 && digits.length >= q.replace(/\s/g, '').length - 4;
    const hits = [];
    items.forEach((it) => {
      let score = 0;
      if (phoneQuery) {
        if (it.phones.some((p) => p.indexOf(digits) >= 0)) score = 100;
        else if (String(it.text).replace(/\D/g, '').indexOf(digits) >= 0) score = 40;
      }
      if (!score) {
        const title = (it.title + ' ' + it.addr).toLowerCase();
        const hay = (title + ' ' + it.text + ' ' + it.people.join(' ') + ' ' + it.emails.join(' ') + ' ' + it.person + ' ' + it.kind).toLowerCase();
        if (!words.every((w) => hay.indexOf(w) >= 0)) return;
        score = words.every((w) => title.indexOf(w) >= 0) ? 60 : 20;
        if (it.emails.some((e) => e === q.toLowerCase().trim())) score = 100;
      }
      hits.push({ it, score });
    });
    // Group by building so one search shows the whole history of an address.
    const groups = {};
    hits.forEach((h) => {
      const k = h.it.key || ('~' + h.it.id);
      const g = groups[k] || (groups[k] = { key: k, items: [], score: 0, last: '' });
      g.items.push(h.it); g.score = Math.max(g.score, h.score);
      if (h.it.date > g.last) g.last = h.it.date;
    });
    // The monthly "maintenance to be done" list repeats each building every month: keep only the latest month up to today.
    const today = iso(new Date());
    Object.values(groups).forEach((g) => {
      const monthly = g.items.filter((i) => /maintenance to be done/i.test(i.kind));
      if (monthly.length < 2) return;
      const past = monthly.filter((i) => i.date <= today).sort((a, b) => b.date.localeCompare(a.date));
      const keep = past[0] || monthly.sort((a, b) => a.date.localeCompare(b.date))[0];
      g.items = g.items.filter((i) => !/maintenance to be done/i.test(i.kind) || i === keep);
    });
    return Object.values(groups).sort((a, b) => b.score - a.score || b.last.localeCompare(a.last))
      .map((g) => { g.items.sort((a, b) => String(b.date).localeCompare(String(a.date))); return g; });
  }
  function personColor(name) {
    const n = String(name || '').trim().toLowerCase();
    const u = state.data && state.data.users.find((x) => String(x.name).toLowerCase() === n);
    if (u && u.color) return u.color;
    const palette = ['#8C564B', '#17BECF', '#BCBD22', '#E377C2', '#7F7F7F', '#9467BD'];
    let h = 0; for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return palette[h % palette.length];
  }
  function contactLine(it) {
    const bits = [];
    it.people.slice(0, 3).forEach((p) => bits.push('<span>' + esc(p) + '</span>'));
    it.phones.slice(0, 3).forEach((p) => bits.push('<a href="tel:' + p + '">' + esc(p.replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3')) + '</a>'));
    it.emails.slice(0, 2).forEach((e) => bits.push('<a href="mailto:' + esc(e) + '">' + esc(e) + '</a>'));
    return bits.length ? '<div class="card-meta">' + bits.join('') + '</div>' : '';
  }
  function resultCard(it) {
    const open = it.internal ? '<a href="' + esc(it.url) + '">Open report</a>'
      : '<a href="' + esc(it.url) + '" target="_blank" rel="noopener">Open in sheet</a>';
    return '<div class="card">' +
      '<div class="card-top"><span class="chip">' + esc(it.kind) + '</span>' +
        (it.date ? '<span class="mono muted">' + esc(it.date) + '</span>' : '') +
        (it.person ? '<span class="who"><i style="background:' + esc(personColor(it.person)) + '"></i>' + esc(it.person) + '</span>' : '') + '</div>' +
      '<div class="card-title">' + esc(it.title) + '</div>' +
      '<div class="card-body">' + esc(it.text.split('\n').filter((l) => l !== it.title).join(' · ')) + '</div>' +
      contactLine(it) +
      '<div class="card-meta">' + open + '</div>' +
    '</div>';
  }
  function renderSearch() {
    const idx = state.index;
    const ready = idx && idx.items;
    view().innerHTML =
      '<div class="filters"><input id="s-q" class="search" type="search" autocomplete="off" ' +
        'placeholder="Address, name, phone or email…" value="' + esc(state.search) + '"></div>' +
      '<p class="muted" id="s-meta"></p><div class="list" id="s-results"></div>';
    const meta = $('#s-meta');
    if (!ready) meta.textContent = online() ? 'Downloading the company sheets…' : 'The company sheets are not on this device yet. Connect once to download them.';
    else meta.textContent = 'Searching ' + idx.items.length.toLocaleString() + ' rows from ' +
      idx.sources.map((x) => x.name).join(', ') + ' + service reports. Works offline.';
    const draw = () => {
      const q = state.search.trim(); const box = $('#s-results');
      if (q.length < 2) { box.innerHTML = '<div class="empty">Type at least 2 characters. Phone numbers work with or without spaces.</div>'; return; }
      const groups = searchItems(q);
      if (!groups.length) { box.innerHTML = '<div class="empty">Nothing found for “' + esc(q) + '”.</div>'; return; }
      const shown = groups.slice(0, 25);
      box.innerHTML = shown.map((g) => {
        const head = g.key.charAt(0) === '~' ? '' : (g.items.find((i) => i.addr) || g.items[0]);
        return '<section class="group">' +
          (head ? '<h2>' + esc(head.addr || head.title) + ' <span class="muted">· ' + g.items.length + ' record' + (g.items.length > 1 ? 's' : '') + '</span></h2>' : '') +
          g.items.slice(0, 12).map(resultCard).join('') +
          (g.items.length > 12 ? '<p class="muted">' + (g.items.length - 12) + ' more — refine the search to see them.</p>' : '') +
        '</section>';
      }).join('') + (groups.length > 25 ? '<p class="muted">Showing 25 of ' + groups.length + ' addresses.</p>' : '');
    };
    const input = $('#s-q');
    input.addEventListener('input', () => { state.search = input.value; draw(); });
    if (!state.search) input.focus();
    draw();
  }

  // ───────── schedule (week view from the K.E Schedule sheet) ─────────
  function mondayOf(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  function renderSchedule() {
    const items = ((state.index && state.index.items) || []);
    if (!state.week) state.week = mondayOf(new Date());
    const mon = state.week;
    const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return d; });
    const entries = items.filter((it) => it.kind === 'Schedule' && it.date);
    const byDay = {}; entries.forEach((e) => { (byDay[e.date] = byDay[e.date] || []).push(e); });
    const people = Array.from(new Set(entries.filter((e) => days.some((d) => iso(d) === e.date)).map((e) => e.person)));
    const monthKey = iso(mon).slice(0, 7);
    const due = items.filter((it) => /maintenance to be done/i.test(it.kind) && String(it.date).slice(0, 7) === monthKey);
    const fmt = (d) => d.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
    view().innerHTML =
      '<div class="weeknav"><button class="btn ghost" id="wk-prev" type="button" aria-label="Previous week">←</button>' +
        '<strong>' + esc(fmt(days[0])) + ' – ' + esc(fmt(days[6])) + '</strong>' +
        '<button class="btn ghost" id="wk-next" type="button" aria-label="Next week">→</button>' +
        '<button class="btn ghost" id="wk-today" type="button">Today</button></div>' +
      (people.length ? '<div class="legend">' + people.map((p) => '<span class="who"><i style="background:' + esc(personColor(p)) + '"></i>' + esc(p) + '</span>').join('') + '</div>' : '') +
      (!entries.length ? '<div class="empty">' + (state.index ? 'No schedule rows visible to you.' : 'Connect once to download the schedule.') + '</div>' : '') +
      '<div class="week">' + days.map((d) => {
        const list = (byDay[iso(d)] || []).slice().sort((a, b) => String(a.person).localeCompare(String(b.person)));
        const today = iso(d) === iso(new Date());
        if (!list.length && (d.getDay() === 0 || d.getDay() === 6)) return '';
        return '<section class="day' + (today ? ' today' : '') + '"><h2>' + esc(fmt(d)) + (today ? ' · today' : '') + '</h2>' +
          (list.length ? list.map((e) => '<a class="block" style="--c:' + esc(personColor(e.person)) + '" href="' + esc(e.url) + '" target="_blank" rel="noopener">' +
            '<span class="block-who">' + esc(e.person) + '</span><span class="block-text">' + esc(e.text) + '</span></a>').join('')
            : '<p class="muted">Nothing scheduled.</p>') + '</section>';
      }).join('') + '</div>' +
      (due.length ? '<h2>Maintenance due in ' + esc(mon.toLocaleDateString('en-CA', { month: 'long' })) + ' (' + due.length + ')</h2><div class="list">' +
        due.map((it) => '<div class="card"><div class="card-top"><span class="chip">' + esc(it.kind.replace(/maintenance to be done/i, '').replace(/^\W+|\W+$/g, '') || 'Maintenance') + '</span>' +
          (/completed|done/i.test(it.text) ? '<span class="chip t-ok">Done</span>' : '') + '</div>' +
          '<div class="card-title">' + esc(it.addr) + '</div>' +
          '<div class="card-body">' + esc(it.text.split('\n').slice(1).join(' · ')) + '</div>' + contactLine(it) + '</div>').join('') + '</div>' : '');
    $('#wk-prev').addEventListener('click', () => { const d = new Date(state.week); d.setDate(d.getDate() - 7); state.week = d; renderSchedule(); });
    $('#wk-next').addEventListener('click', () => { const d = new Date(state.week); d.setDate(d.getDate() + 7); state.week = d; renderSchedule(); });
    $('#wk-today').addEventListener('click', () => { state.week = mondayOf(new Date()); renderSchedule(); });
  }

  // ───────── router ─────────
  function route() {
    if (!state.me) { renderSignIn(); return; }
    const hash = location.hash || '#/search';
    const [path, query] = hash.slice(1).split('?');
    const parts = path.split('/').filter(Boolean);
    const tab = parts[0] || 'reports';
    document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    if (tab === 'search') renderSearch();
    else if (tab === 'schedule') renderSchedule();
    else if (tab === 'reports' && parts[1]) renderDetail(decodeURIComponent(parts[1]));
    else if (tab === 'new') renderNew(new URLSearchParams(query || ''));
    else if (tab === 'outbox') renderOutbox();
    else if (tab === 'sites') renderSites();
    else renderReports();
    window.scrollTo(0, 0);
  }

  // ───────── start ─────────
  window.addEventListener('hashchange', route);
  window.addEventListener('online', () => { renderSync(); syncOutbox(); });
  window.addEventListener('offline', renderSync);
  $('#sync-pill').addEventListener('click', () => { if (!tokenValid() && online()) renewSignIn(); syncOutbox(); });
  $('#user-chip').addEventListener('click', () => { $('#user-menu').hidden = false; });
  $('#close-menu').addEventListener('click', () => { $('#user-menu').hidden = true; });
  $('#sign-out').addEventListener('click', signOut);
  setInterval(() => { renderSync(); if (state.outbox.length) syncOutbox(); }, 60000);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  (async function start() {
    await loadOutbox();
    await loadIndexFromDevice();
    renderChrome(); route();
    if (state.me && online()) {
      if (tokenValid()) { try { await refreshData(); renderChrome(); route(); } catch (e) { banner(e.message, true); } syncOutbox(); }
      else setTimeout(renewSignIn, 800);
    }
  })();

  window.__oa = { state, DB, syncOutbox, onCredential };   // used by tests
})();
