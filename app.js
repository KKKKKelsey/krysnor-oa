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
    tables: null,                        // raw company-sheet tables for the Tables page
    search: '',
    week: null,                          // Monday of the week shown in Schedule
    notes: LS.get('notes', null),
    work: null,                          // orders, prices, projects, mail (only the parts this role may see)
    month: LS.get('month', null),
    invoices: LS.get('invoices', null),  // every invoice to send: sent / not sent / coming up        // this month's maintenance + invoice checklist        // latest 9:00 notification batch { batch_at, batches, items }
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
    await loadNotes();
    await loadWork();
    renderChrome();
  }
  async function loadNotes() {
    try { state.notes = await api('notifications', {}); LS.set('notes', state.notes); } catch (e) { /* keep the copy on this device */ }
    renderBell();
  }
  async function loadIndexFromDevice() {
    if (state.index) return;
    try { state.index = (await DB.getKv('index')) || null; } catch (e) { state.index = null; }
  }

  // ───────── sync ─────────
  async function syncOutbox() {
    if (state.syncing) { state.syncAgain = true; return; }   // run once more when the current sync ends
    state.syncAgain = false;
    await loadOutbox();
    if (!online() || !tokenValid() || !CFG.apiUrl) { renderSync(); return; }
    state.syncing = true; renderSync();
    let sent = 0;
    for (const item of state.outbox) {
      try {
        const res = await api('createReport', item.payload);
        await DB.del(item.client_id); sent++;
        // Show the numbered report straight away, before the full refresh below finishes.
        if (res && res.report && state.data && !state.data.reports.some((x) => x.report_id === res.report.report_id)) state.data.reports.push(res.report);
      } catch (e) {
        item.error = e.message; item.tries = (item.tries || 0) + 1;
        await DB.put(item);
        if (/offline|sign in/i.test(e.message)) break;
      }
    }
    await loadOutbox();                 // clear the "Waiting" badge as soon as the uploads are done
    renderSync();
    try { await refreshData(); } catch (e) { /* keep cached data */ }
    state.syncing = false;
    renderSync();
    if (state.syncAgain) syncOutbox();
    if (sent) toast(sent + ' report' + (sent > 1 ? 's' : '') + ' uploaded');
    if (!state.touched) route();         // never wipe a form or a page the person is working in
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
    renderBell();
    $('#tab-month').hidden = !(state.month && state.month.items && state.month.items.length);
    $('#tab-orders').hidden = !can('order.view');
    $('#tab-prices').hidden = !can('order.view');
    $('#tab-invoices').hidden = !(state.invoices && state.invoices.items && state.invoices.items.length) && !can('order.view');
    $('#tab-projects').hidden = !can('project.view');
    $('#tab-mail').hidden = !can('mail.view');
    $('#tab-crm').hidden = !can('crm.view');
    $('#tab-tables').hidden = !(state.index && state.index.tableCount > 0);
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

  // ───────── notifications (the "!" in the top bar; refreshed by the server every day at 9:00) ─────────
  const openNotes = () => ((state.notes && state.notes.items) || []).filter((i) => i.status !== 'done');
  function renderBell() {
    const b = $('#bell'); if (!b) return;
    b.hidden = !state.me;
    const n = openNotes().length;
    const c = $('#bell-count'); c.textContent = n; c.hidden = !n;
    b.classList.toggle('hot', n > 0);
    b.title = n ? n + ' open reminder' + (n > 1 ? 's' : '') : 'Notifications';
  }
  const batchLabel = (b) => b ? new Date(b).toLocaleString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  function noteCard(i, live) {
    const done = i.status === 'done';
    return '<div class="card note' + (done ? ' done' : '') + '" data-task="' + esc(i.task_id) + '">' +
      '<div class="card-top"><span class="chip">' + esc(i.type || 'Task') + '</span>' +
        (done ? '<span class="chip t-ok">Done</span>' : '<span class="chip t-warn">Open</span>') + (i.task_id ? '<span class="ticket">' + esc(i.task_id) + '</span>' : '') + '</div>' +
      '<div class="card-title">' + esc(i.title) + '</div>' +
      '<div class="card-meta">' + (i.created_at ? 'Since ' + esc(fmtDate(i.created_at)) : '') +
        (done ? ' · done by ' + esc(String(i.done_by).split('@')[0]) + ' ' + esc(fmtDate(i.done_at)) + (i.note ? ' · ' + esc(i.note) : '') : '') + '</div>' +
      '<div class="actions">' + (i.link && /^https?:/.test(i.link) ? '<a class="btn ghost" href="' + esc(i.link) + '" target="_blank" rel="noopener">Open email</a>'
          : i.link ? '<a class="btn ghost" href="' + esc(i.link) + '">' + (i.group ? 'Open checklist' : 'Open') + '</a>'
          : i.ref_id ? '<a class="btn ghost" href="#/reports/' + encodeURIComponent(i.ref_id) + '">Open ' + esc(i.ref_id) + '</a>' : '') +
        (live && !done && i.can_complete ? '<input type="text" class="note-in" placeholder="Note, e.g. invoice #" aria-label="Note">' +
          '<button class="btn primary" type="button" data-done="' + esc(i.task_id) + '">Mark done</button>' : '') + '</div></div>';
  }
  function openNotifications(batchAt) {
    const n = state.notes;
    const live = !batchAt;
    const draw = (data) => {
      const items = (data && data.items) || [];
      const open = items.filter((i) => i.status !== 'done');
      const done = items.filter((i) => i.status === 'done');
      openDrawer(live ? 'Notifications' : 'Past · ' + batchLabel(data.batch_at),
        '<p class="muted">' + (data && data.batch_at ? (live ? 'Refreshed ' : 'Sent ') + esc(batchLabel(data.batch_at)) + ' · new lists arrive every day at 9:00' : 'No reminders yet. The first list arrives at 9:00.') + '</p>' +
        (items.length ? '' : '<div class="empty">Nothing for you in this list.</div>') +
        open.map((i) => noteCard(i, live)).join('') +
        (done.length ? '<h2>Done since</h2>' + done.map((i) => noteCard(i, live)).join('') : '') +
        '<div class="actions">' + (live ? '<button class="btn" type="button" id="past-btn">Past notifications</button>'
          : '<button class="btn" type="button" id="back-btn">Back to today</button>') + '</div>' +
        '<div id="past-list"></div>');
      const pb = $('#past-btn');
      if (pb) pb.addEventListener('click', () => {
        const list = ((state.notes && state.notes.batches) || []).slice(1);
        $('#past-list').innerHTML = list.length ? '<h2>Past notifications</h2><div class="past">' +
          list.map((b) => '<button class="btn ghost" type="button" data-batch="' + esc(b) + '">' + esc(batchLabel(b)) + '</button>').join('') + '</div>'
          : '<div class="empty">No earlier lists yet.</div>';
        $('#past-list').querySelectorAll('[data-batch]').forEach((x) => x.addEventListener('click', () => openNotifications(x.dataset.batch)));
      });
      const bb = $('#back-btn'); if (bb) bb.addEventListener('click', () => openNotifications());
      $('#drawer').querySelectorAll('[data-done]').forEach((btn) => btn.addEventListener('click', async () => {
        const card = btn.closest('.card');
        btn.disabled = true; btn.textContent = 'Saving…';
        try {
          await api('completeTask', { task_id: btn.dataset.done, note: card.querySelector('.note-in').value });
          const it = state.notes.items.find((x) => x.task_id === btn.dataset.done);
          if (it) { it.status = 'done'; it.done_by = state.me.user.email; it.done_at = new Date().toISOString(); it.note = card.querySelector('.note-in').value; }
          LS.set('notes', state.notes); renderBell(); toast('Marked done'); openNotifications();
        } catch (e) { btn.disabled = false; btn.textContent = 'Mark done'; toast(e.message); }
      }));
    };
    if (live) { draw(n); return; }
    if (!online()) { toast('Past notifications need the internet'); return; }
    openDrawer('Past notifications', '<div class="empty">Loading…</div>');
    api('notifications', { batch_at: batchAt }).then(draw).catch((e) => openDrawer('Past notifications', '<div class="empty">' + esc(e.message) + '</div>'));
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
      '<div class="stamp"><span>Received by server <strong>' + esc(fmtDate(r.server_time)) + '</strong>' + (isAdmin() ? te('Service Reports', r.report_id, 'server_time', r.server_time) : ' · cannot be changed') + '</span>' +
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

  const siteKey = (s) => addrKey(s.address) || addrKey(s.name);
  const FREQ_ORDER = { monthly: 1, quarterly: 2, 'semi-annual': 3, 'semi annual': 3, 'bi-annual': 3 };
  function renderSites() {
    if (!state.data) { view().innerHTML = '<div class="empty">Connect once to download the site list.</div>'; return; }
    const sites = ((state.data && state.data.sites) || []).slice()
      .sort((a, b) => (FREQ_ORDER[String(a.frequency).toLowerCase()] || 9) - (FREQ_ORDER[String(b.frequency).toLowerCase()] || 9) || String(a.name).localeCompare(String(b.name)));
    const q = (state.siteQ || '').toLowerCase();
    const shown = sites.filter((s) => !q || [s.name, s.address, s.city, s.site_contact, s.contact_name, s.installation_no].join(' ').toLowerCase().indexOf(q) >= 0);
    const groups = {};
    shown.forEach((s) => { const g = s.frequency || (s.segment_id === 'RES' ? 'Residential' : 'Other sites'); (groups[g] = groups[g] || []).push(s); });
    const addForm = can('site.create') ? '<details class="add-site"><summary class="btn">Add a site</summary>' +
      '<form class="stack" id="sf" novalidate>' +
        '<label class="field"><span>Site name</span><input id="s-name" type="text" required placeholder="e.g. 100 King St W"></label>' +
        '<label class="field"><span>Type</span><select id="s-seg">' +
          state.data.segments.map((s) => '<option value="' + esc(s.segment_id) + '">' + esc(s.name) + '</option>').join('') + '</select></label>' +
        '<div class="row2"><label class="field"><span>Address</span><input id="s-addr" type="text"></label>' +
          '<label class="field"><span>City</span><input id="s-city" type="text"></label></div>' +
        '<div class="row2"><label class="field"><span>Contact name</span><input id="s-cname" type="text"></label>' +
          '<label class="field"><span>Contact phone</span><input id="s-cphone" type="tel"></label></div>' +
        '<label class="field"><span>Contact email</span><input id="s-cemail" type="email"></label>' +
        '<p class="muted">Adding a site that was removed earlier brings it back with its history.</p>' +
        '<p class="muted" id="s-error" role="alert"></p>' +
        '<div class="actions"><button class="btn primary" type="submit">Add site</button></div>' +
      '</form></details>' : '';
    view().innerHTML = '<a class="back" href="#/search">‹ Search</a><div class="page-head"><h1>Sites</h1><span class="muted">' + sites.length + ' fixed addresses</span></div>' +
      '<div class="search-box"><input id="site-q" type="search" placeholder="Filter sites…" value="' + esc(state.siteQ || '') + '" aria-label="Filter sites"></div>' +
      addForm +
      Object.keys(groups).map((g) => '<h2>' + esc(g) + ' · ' + groups[g].length + '</h2><div class="list">' +
        groups[g].map((s) => '<a class="card site-card" href="#/sites/' + encodeURIComponent(s.site_id) + '">' +
          '<div class="card-top"><span class="ticket">' + esc(s.site_id) + '</span>' +
            (s.units_qty ? '<span class="chip">' + esc(s.units_qty) + ' unit' + (Number(s.units_qty) > 1 ? 's' : '') + '</span>' : '') +
            (s.contract_expiry ? '<span class="chip">Expires ' + esc(String(s.contract_expiry).slice(0, 10)) + '</span>' : '') + '</div>' +
          '<div class="card-title">' + esc(s.name) + '</div>' +
          '<div class="card-meta">' + esc([s.city, s.site_contact || s.contact_name].filter(Boolean).join(' · ')) + '</div></a>').join('') + '</div>').join('') +
      (shown.length ? '' : '<div class="empty">No site matches.</div>');
    const qi = $('#site-q');
    qi.addEventListener('input', () => { state.siteQ = qi.value; const pos = qi.selectionStart; renderSites(); const n = $('#site-q'); n.focus(); n.setSelectionRange(pos, pos); });
    const sf = $('#sf');
    if (sf) sf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#s-error'); err.textContent = '';
      try {
        const r = await api('createSite', {
          name: $('#s-name').value, segment_id: $('#s-seg').value, address: $('#s-addr').value, city: $('#s-city').value,
          contact_name: $('#s-cname').value, contact_phone: $('#s-cphone').value, contact_email: $('#s-cemail').value,
        });
        await refreshData(); toast(r && r.restored ? 'Site restored' : 'Site added'); renderSites();
      } catch (ex) { err.textContent = ex.message; }
    });
  }

  const itemYear = (it) => String(it.date || '').slice(0, 4) || it.year || '';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function renderSiteDetail(id) {
    const s = state.data && state.data.sites.find((x) => x.site_id === id);
    if (!s) { view().innerHTML = '<div class="empty">This site is not in the list (it may have been removed). <a href="#/sites">Back to sites</a></div>'; return; }
    const thisYear = new Date().getFullYear();
    const years = [thisYear, thisYear - 1, thisYear - 2];
    const year = Number(state.siteYear) && years.indexOf(Number(state.siteYear)) >= 0 ? Number(state.siteYear) : thisYear;
    const key = siteKey(s);
    const all = ((state.index && state.index.items) || []).concat(reportItems())
      .filter((it) => (key && it.key === key) || (it.internal && it.addr === s.name));
    // Months covered by the schedule sheet use it; the maintenance-record visit for the same month would be a duplicate.
    const schedMonths = new Set(((state.index && state.index.items) || []).filter((it) => it.kind === 'Schedule' && it.date).map((it) => it.date.slice(0, 7)));
    const inYear = all.filter((it) => itemYear(it) === String(year) && !(it.kind === 'Maintenance visit' && schedMonths.has(it.date.slice(0, 7))));
    const dated = inYear.filter((it) => it.date && !/maintenance to be done/i.test(it.kind));
    const byMonth = MONTHS.map(() => []);
    dated.forEach((it) => { const m = Number(it.date.slice(5, 7)) - 1; if (m >= 0 && m < 12) byMonth[m].push(it); });
    const counts = years.map((y) => all.filter((it) => itemYear(it) === String(y)).length);
    const records = inYear.filter((it) => !it.date);           // whole-year rows (maintenance record, trackers)
    const dot = (it) => '<button class="ev" type="button" data-it="' + esc(it.id) + '" style="--c:' + esc(it.internal ? 'var(--navy)' : personColor(it.person)) + '">' +
      '<b>' + esc(Number(it.date.slice(8, 10)) && !it.approx ? Number(it.date.slice(8, 10)) : '·') + '</b>' + esc(it.internal || it.kind === 'Maintenance visit' ? it.title.split(' · ')[0] : (it.person || it.kind)) + '</button>';
    const info = [
      ['Frequency', s.frequency], ['Contract', [s.contract_type, s.contract_value ? '$' + s.contract_value : ''].filter(Boolean).join(' · ')],
      ['Expires', String(s.contract_expiry || '').slice(0, 10)], ['Units', s.units_qty], ['Installation #', s.installation_no],
      ['Scheduled week', s.scheduled_week], ['Contact', s.site_contact || [s.contact_name, s.contact_phone, s.contact_email].filter(Boolean).join(' · ')],
      ['Notes', s.notes],
    ].filter((r) => r[1]);
    view().innerHTML =
      '<a class="back" href="#/sites">‹ Sites</a>' +
      '<div class="page-head"><h1>' + esc(s.name) + '</h1><span class="ticket">' + esc(s.site_id) + '</span></div>' +
      '<dl class="kv">' + info.map((r) => '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>').join('') + '</dl>' +
      '<div class="cal-bar"><h2 style="margin:0">History</h2><div class="seg" role="group" aria-label="Year">' +
        years.map((y, i) => '<button type="button" data-year="' + y + '" class="' + (y === year ? 'on' : '') + '">' + y + (counts[i] ? ' <small>' + counts[i] + '</small>' : '') + '</button>').join('') + '</div></div>' +
      (inYear.length ? '' : '<div class="empty">No records for ' + year + ' at this address.</div>') +
      (dated.length ? '<div class="year-grid">' + MONTHS.map((m, i) => '<div class="ym' + (byMonth[i].length ? '' : ' none') + '"><div class="ym-h">' + m + '</div>' +
        byMonth[i].sort((a, b) => a.date.localeCompare(b.date)).map(dot).join('') + '</div>').join('') + '</div>' : '') +
      (dated.length ? '<h2>Visits and reports · ' + dated.length + '</h2><div class="list">' +
        dated.slice().sort((a, b) => b.date.localeCompare(a.date)).map((it) => '<button class="card tl" type="button" data-it="' + esc(it.id) + '">' +
          '<div class="card-top"><span class="chip">' + esc(it.kind) + '</span><span class="muted">' + esc(it.approx ? it.date.slice(0, 7) : it.date) + '</span>' +
          (it.person ? '<span class="chip" style="border-color:' + esc(personColor(it.person)) + '">' + esc(it.person) + '</span>' : '') + '</div>' +
          '<div class="card-body">' + esc(it.internal ? it.title + ' · ' + it.text.split('\n')[0] : it.text.split('\n')[0]) + '</div></button>').join('') + '</div>' : '') +
      (records.length ? '<h2>Records for ' + year + ' · ' + records.length + '</h2><div class="list">' + records.map(resultCard).join('') + '</div>' : '') +
      siteWorkHtml(s) +
      (can('site.delete') ? '<details class="danger-zone"><summary>Remove from Sites</summary><form class="stack" id="arch-f">' +
        '<label class="field"><span>Reason (required)</span><input id="arch-reason" type="text" required placeholder="e.g. Contract ended Dec 2026"></label>' +
        '<p class="muted">The site leaves the list but nothing is deleted: its rows stay in the master sheet and the hourly import will not add it back. Adding the same name again restores it.</p>' +
        '<p class="muted" id="arch-err" role="alert"></p><div class="actions"><button class="btn danger" type="submit">Remove site</button></div></form></details>' : '');
    view().querySelectorAll('[data-year]').forEach((b) => b.addEventListener('click', () => { state.siteYear = b.dataset.year; renderSiteDetail(id); }));
    bindMailCards(view());
    const byId = {}; inYear.forEach((it) => { byId[it.id] = it; });
    view().querySelectorAll('[data-it]').forEach((b) => b.addEventListener('click', () => {
      const it = byId[b.dataset.it]; if (!it) return;
      if (it.internal) { location.hash = it.url; return; }
      openDrawer(it.kind + ' · ' + (it.approx ? it.date.slice(0, 7) + ' (day not recorded)' : it.date),
        '<div class="card-body" style="-webkit-line-clamp:unset;white-space:pre-wrap">' + esc(it.text) + '</div>' + contactLine(it) +
        (it.url ? '<div class="actions"><a class="btn" href="' + esc(it.url) + '" target="_blank" rel="noopener">Open in sheet</a></div>' : ''));
    }));
    const af = $('#arch-f');
    if (af) af.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#arch-err'); err.textContent = '';
      if (!online()) { err.textContent = 'Removing a site needs the internet.'; return; }
      try { await api('archiveSite', { site_id: id, reason: $('#arch-reason').value }); await refreshData(); toast('Removed from Sites'); location.hash = '#/sites'; }
      catch (ex) { err.textContent = ex.message; }
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
  /** Contacts and companies matching the search (name, email, phone digits), shown above the sheet rows. */
  function crmSearch(q) {
    if (!can('crm.view') || !state.crm) return '';
    const t = q.toLowerCase(), d = q.replace(/\D/g, '');
    const hit = (txt, ph) => String(txt).toLowerCase().indexOf(t) >= 0 || (d.length >= 4 && String(ph).replace(/\D/g, '').indexOf(d) >= 0);
    const cos = CRM().companies.filter((c) => hit([c.name, c.email, c.domain].join(' '), c.phone)).slice(0, 5);
    const cts = CRM().contacts.filter((c) => hit([ctName(c), c.email].join(' '), [c.phone, c.mobile].join(' '))).slice(0, 8);
    if (!cos.length && !cts.length) return '';
    return '<section class="group"><h2>CRM <span class="muted">· ' + (cos.length + cts.length) + '</span></h2><div class="crm-hits">' +
      cos.map((c) => '<a class="crm-chip" href="#/crm/company/' + encodeURIComponent(c.company_id) + '">' + avatar(c.name, 'company') + esc(c.name) + '</a>').join('') +
      cts.map((c) => '<a class="crm-chip" href="#/crm/contact/' + encodeURIComponent(c.contact_id) + '">' + avatar(ctName(c)) + esc(ctName(c)) +
        ((coById(c.company_id) || {}).name ? ' <span class="muted">· ' + esc(coById(c.company_id).name) + '</span>' : '') + (c.phone || c.mobile ? ' <span class="muted mono">' + esc(c.phone || c.mobile) + '</span>' : '') + '</a>').join('') +
      '</div></section>';
  }
  function renderSearch() {
    const idx = state.index;
    const ready = idx && idx.items;
    view().innerHTML =
      '<div class="filters"><input id="s-q" class="search" type="search" autocomplete="off" ' +
        'placeholder="Address, name, phone or email…" value="' + esc(state.search) + '"></div>' +
      '<p class="muted" id="s-meta"></p>' +
      (state.data && state.data.sites && state.data.sites.length ? '<p class="site-links"><a href="#/sites">All ' + state.data.sites.length + ' maintenance sites ›</a></p>' : '') +
      '<div class="list" id="s-results"></div>';
    const siteByKey = {};
    ((state.data && state.data.sites) || []).forEach((s) => { const k = siteKey(s); if (k && !siteByKey[k]) siteByKey[k] = s; });
    const meta = $('#s-meta');
    if (!ready) meta.textContent = online() ? 'Downloading the company sheets…' : 'The company sheets are not on this device yet. Connect once to download them.';
    else meta.textContent = 'Searching ' + idx.items.length.toLocaleString() + ' rows from ' +
      idx.sources.map((x) => x.name).join(', ') + ' + service reports. Works offline.';
    const draw = () => {
      const q = state.search.trim(); const box = $('#s-results');
      if (q.length < 2) { box.innerHTML = '<div class="empty">Type at least 2 characters. Phone numbers work with or without spaces.</div>'; return; }
      const groups = searchItems(q);
      const crmHits = crmSearch(q);
      if (!groups.length && !crmHits) { box.innerHTML = '<div class="empty">Nothing found for “' + esc(q) + '”.</div>'; return; }
      const shown = groups.slice(0, 25);
      box.innerHTML = crmHits + shown.map((g) => {
        const head = g.key.charAt(0) === '~' ? '' : (g.items.find((i) => i.addr) || g.items[0]);
        return '<section class="group">' +
          (head ? '<h2>' + esc(head.addr || head.title) + ' <span class="muted">· ' + g.items.length + ' record' + (g.items.length > 1 ? 's' : '') + '</span>' +
            (siteByKey[g.key] ? ' <a class="site-open" href="#/sites/' + encodeURIComponent(siteByKey[g.key].site_id) + '">Site page ›</a>' : '') + '</h2>' : '') +
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
  // ───────── drawer (row / event details) ─────────
  function openDrawer(title, bodyHtml) {
    const d = $('#drawer');
    d.innerHTML = '<div class="drawer-panel" role="dialog" aria-label="' + esc(title) + '">' +
      '<div class="drawer-head"><h1>' + esc(title) + '</h1><button class="btn ghost" id="dr-close" type="button">Close</button></div>' +
      bodyHtml + '</div>';
    d.hidden = false;
    const close = () => { d.hidden = true; d.innerHTML = ''; };
    $('#dr-close').addEventListener('click', close);
    d.addEventListener('click', (e) => { if (e.target === d) close(); }, { once: true });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#drawer').hidden) { $('#drawer').hidden = true; } });

  // ───────── calendar (Google-Calendar style, from the K.E Schedule sheet) ─────────
  function renderSchedule() {
    const items = ((state.index && state.index.items) || []);
    const sched = items.filter((it) => it.kind === 'Schedule' && it.date);
    const schedMonths = new Set(sched.map((e) => e.date.slice(0, 7)));
    // Months without a schedule sheet (2025 and earlier) show the visits written in the maintenance record.
    const visits = items.filter((it) => it.kind === 'Maintenance visit' && it.date && !schedMonths.has(it.date.slice(0, 7)))
      .map((it) => Object.assign({}, it, { person: it.person, title: it.title.replace(/^[^·]*·\s*/, ''), past: true }));
    const reps = reportItems().filter((it) => it.date).map((it) => Object.assign({}, it, { title: it.title, oa: true }));
    const entries = sched.concat(visits, reps);
    if (!state.week) state.week = mondayOf(new Date());
    const hidden = new Set(LS.get('calHidden', []));
    const canon = (n) => String(n || '').trim().toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
    entries.forEach((e) => { e.person = canon(e.person); });
    const offCal = new Set(((state.data && state.data.users) || []).filter((u) => u.on_calendar === false).map((u) => canon(u.name)));
    if (offCal.size) { for (let i = entries.length - 1; i >= 0; i--) if (offCal.has(entries[i].person)) entries.splice(i, 1); }
    const people = Array.from(new Set(entries.map((e) => e.person))).sort();
    const visible = entries.filter((e) => !hidden.has(e.person));
    const byDay = {}; visible.forEach((e) => { (byDay[e.date] = byDay[e.date] || []).push(e); });
    Object.values(byDay).forEach((l) => l.sort((a, b) => String(a.person).localeCompare(String(b.person))));
    const mode = LS.get('calView', 'week');
    const anchor = state.week;
    const monthStart = new Date(anchor.getFullYear(), anchor.getMonth() + (anchor.getDate() > 22 ? 1 : 0), 1);
    const title = mode === 'month'
      ? monthStart.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })
      : (() => { const end = new Date(anchor); end.setDate(anchor.getDate() + 6);
          return anchor.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) + ' – ' +
                 end.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }); })();
    const evBtn = (e) => '<button class="ev' + (e.past ? ' past' : '') + (e.oa ? ' oa' : '') + '" type="button" data-ev="' + esc(e.id) + '" style="--c:' + esc(personColor(e.person)) + '">' +
      '<b>' + esc(e.person) + '</b>' + esc(e.title) + '</button>';
    const todayIso = iso(new Date());
    let body = '';
    if (!entries.length) {
      body = '<div class="empty">' + (state.index ? 'No calendar rows visible to you yet. Kaixin runs syncSources once to load them.' : 'Connect once to download the calendar.') + '</div>';
    } else if (mode === 'month') {
      const first = mondayOf(monthStart);
      const cells = Array.from({ length: 42 }, (_, i) => { const d = new Date(first); d.setDate(first.getDate() + i); return d; });
      const weeks = cells[35].getMonth() === monthStart.getMonth() ? 6 : 5;
      body = '<div class="cal-month">' + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => '<div class="dow">' + d + '</div>').join('') +
        cells.slice(0, weeks * 7).map((d) => {
          const list = byDay[iso(d)] || [];
          return '<div class="cal-cell' + (d.getMonth() !== monthStart.getMonth() ? ' out' : '') + (iso(d) === todayIso ? ' today' : '') + '">' +
            '<button class="daynum" type="button" data-day="' + iso(d) + '" aria-label="Open week of ' + esc(d.toDateString()) + '">' + d.getDate() + '</button>' +
            list.slice(0, 3).map(evBtn).join('') +
            (list.length > 3 ? '<button class="more" type="button" data-day="' + iso(d) + '">+' + (list.length - 3) + ' more</button>' : '') + '</div>';
        }).join('') + '</div>';
    } else {
      const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(anchor); d.setDate(anchor.getDate() + i); return d; });
      body = '<div class="cal-week">' + days.map((d) => {
        const list = byDay[iso(d)] || [];
        return '<div class="cal-col' + (iso(d) === todayIso ? ' today' : '') + (list.length ? '' : ' empty-day') + '">' +
          '<div class="cal-head"><small>' + d.toLocaleDateString('en-CA', { weekday: 'short' }) + '</small><span class="daynum">' + d.getDate() + '</span></div>' +
          '<div class="cal-body">' + list.map(evBtn).join('') + '</div></div>';
      }).join('') + '</div>';
      const monthKey = iso(anchor).slice(0, 7);
      const due = items.filter((it) => /maintenance to be done/i.test(it.kind) && String(it.date).slice(0, 7) === monthKey);
      if (due.length) {
        body += '<h2>Maintenance due in ' + esc(anchor.toLocaleDateString('en-CA', { month: 'long' })) + ' (' + due.length + ')</h2><div class="list">' +
          due.map((it) => '<div class="card"><div class="card-top"><span class="chip">' + esc(it.kind.replace(/maintenance to be done/i, '').replace(/^\W+|\W+$/g, '') || 'Maintenance') + '</span>' +
            (/completed|done/i.test(it.text) ? '<span class="chip t-ok">Done</span>' : '') + '</div>' +
            '<div class="card-title">' + esc(it.addr) + '</div>' +
            '<div class="card-body">' + esc(it.text.split('\n').slice(1).join(' · ')) + '</div>' + contactLine(it) + '</div>').join('') + '</div>';
      }
    }
    view().innerHTML =
      '<div class="cal-bar"><button class="btn" id="cal-today" type="button">Today</button>' +
        '<button class="btn ghost" id="cal-prev" type="button" aria-label="Previous">‹</button>' +
        '<button class="btn ghost" id="cal-next" type="button" aria-label="Next">›</button>' +
        '<h1>' + esc(title) + '</h1>' +
        '<input type="month" id="cal-jump" aria-label="Go to month" value="' + esc(iso(mode === 'month' ? monthStart : anchor).slice(0, 7)) + '"' +
          (entries.length ? ' min="' + esc(entries.reduce((m, e) => e.date < m ? e.date : m, '9999').slice(0, 7)) + '"' : '') + '>' +
        '<div class="seg" role="group" aria-label="View"><button type="button" data-mode="week" class="' + (mode === 'week' ? 'on' : '') + '">Week</button>' +
        '<button type="button" data-mode="month" class="' + (mode === 'month' ? 'on' : '') + '">Month</button></div></div>' +
      (people.length ? '<div class="cal-people">' + people.map((p) => '<label style="--c:' + esc(personColor(p)) + '"><input type="checkbox" data-person="' + esc(p) + '"' +
        (hidden.has(p) ? '' : ' checked') + '>' + esc(p) + '</label>').join('') + '</div>' : '') + body;

    const step = (dir) => {
      const d = new Date(state.week);
      if (mode === 'month') { const m = new Date(monthStart.getFullYear(), monthStart.getMonth() + dir, 1); state.week = mondayOf(m); if (state.week.getMonth() !== m.getMonth()) state.week.setDate(state.week.getDate() + 7); }
      else { d.setDate(d.getDate() + 7 * dir); state.week = d; }
      renderSchedule();
    };
    $('#cal-prev').addEventListener('click', () => step(-1));
    $('#cal-next').addEventListener('click', () => step(1));
    $('#cal-today').addEventListener('click', () => { state.week = mondayOf(new Date()); renderSchedule(); });
    $('#cal-jump').addEventListener('change', (ev) => {
      const v = ev.target.value; if (!/^\d{4}-\d{2}$/.test(v)) return;
      const m = new Date(Number(v.slice(0, 4)), Number(v.slice(5, 7)) - 1, 1);
      state.week = mondayOf(m); if (state.week.getMonth() !== m.getMonth()) state.week.setDate(state.week.getDate() + 7);
      renderSchedule();
    });
    const legend = [visits.length ? '<span class="ev past" style="--c:#8A99A6">Lighter</span> = from the maintenance record (before the schedule sheet)' : '',
      reps.length ? '<span class="ev oa" style="--c:#8A99A6">Outlined</span> = OA service report' : ''].filter(Boolean);
    if (legend.length) view().insertAdjacentHTML('beforeend', '<p class="muted cal-legend">' + legend.join(' · ') + '</p>');
    view().querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { LS.set('calView', b.dataset.mode); renderSchedule(); }));
    view().querySelectorAll('[data-person]').forEach((cb) => cb.addEventListener('change', () => {
      const h = new Set(LS.get('calHidden', [])); if (cb.checked) h.delete(cb.dataset.person); else h.add(cb.dataset.person);
      LS.set('calHidden', Array.from(h)); renderSchedule();
    }));
    view().querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => {
      state.week = mondayOf(new Date(b.dataset.day + 'T12:00:00')); LS.set('calView', 'week'); renderSchedule();
    }));
    const byId = {}; visible.forEach((e) => { byId[e.id] = e; });
    view().querySelectorAll('[data-ev]').forEach((b) => b.addEventListener('click', () => {
      const e = byId[b.dataset.ev]; if (!e) return;
      if (e.oa) { location.hash = e.url; return; }
      const related = e.key ? ((state.index && state.index.items) || []).filter((x) => x.key === e.key && x.id !== e.id).length : 0;
      openDrawer(e.person + ' · ' + new Date(e.date + 'T12:00:00').toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' }),
        '<div class="card-body" style="-webkit-line-clamp:unset;white-space:pre-wrap">' + esc(e.text) + '</div>' + contactLine(e) +
        (e.approx ? '<p class="muted">The day was not written in the maintenance record, so this sits on the 1st.</p>' : '') +
        '<div class="actions"><a class="btn" href="' + esc(e.url) + '" target="_blank" rel="noopener">Open in sheet</a>' +
        (related ? '<button class="btn ghost" type="button" id="dr-related">' + related + ' other records at this address</button>' : '') + '</div>');
      const rel = $('#dr-related');
      if (rel) rel.addEventListener('click', () => { $('#drawer').hidden = true; state.search = e.addr || e.title; location.hash = '#/search'; });
    }));
  }

  // ───────── tables (console-style browser of the company sheets) ─────────
  async function loadTables() {
    if (state.tables && state.index && state.tables.version === state.index.version) return state.tables;
    try { const c = await DB.getKv('tables'); if (c && state.index && c.version === state.index.version) { state.tables = c; return c; } } catch (e) { /* ignore */ }
    try { const t = await api('tables'); state.tables = t; await DB.setKv('tables', t); return t; }
    catch (e) { try { state.tables = (await DB.getKv('tables')) || null; } catch (x) { state.tables = null; } if (!state.tables) throw e; return state.tables; }
  }
  async function renderTables() {
    view().innerHTML = '<div class="empty">Loading tables…</div>';
    let data;
    try { data = await loadTables(); } catch (e) { view().innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
    const tables = (data && data.tables) || [];
    if (!tables.length) { view().innerHTML = '<div class="empty">No tables visible to you.</div>'; return; }
    const pick = LS.get('tableSel', '');
    let cur = tables.find((t) => t.src + '|' + t.tab === pick) || tables.find((t) => /Maintenance Log/.test(t.tab)) || tables[0];
    const groups = {}; tables.forEach((t) => { (groups[t.source] = groups[t.source] || []).push(t); });
    let q = '';
    const rowLink = (t, r) => t.native ? t.url + '#gid=' + t.gid + '&range=A' + r : t.url;
    const draw = () => {
      const qq = q.trim().toLowerCase();
      const rows = qq ? cur.rows.filter((r) => r.c.join(' ').toLowerCase().indexOf(qq) >= 0) : cur.rows;
      $('#tb-title').textContent = cur.tab;
      $('#tb-count').textContent = rows.length + (qq ? ' of ' + cur.rows.length : '') + ' rows';
      $('#tb-grid').innerHTML = '<table class="grid"><thead><tr><th class="rn">#</th>' + cur.headers.map((h) => '<th title="' + esc(h) + '">' + esc(h) + '</th>').join('') +
        '</tr></thead><tbody>' + rows.slice(0, 500).map((r) => '<tr data-r="' + r.r + '"><td class="rn">' + r.r + '</td>' +
          r.c.map((c) => '<td title="' + esc(c) + '">' + esc(c.replace(/\n/g, ' · ')) + '</td>').join('') + '</tr>').join('') + '</tbody></table>' +
        (rows.length > 500 ? '<p class="muted" style="padding:8px 12px">Showing the first 500 rows. Filter to narrow down.</p>' : '');
      $('#tb-grid').querySelectorAll('tr[data-r]').forEach((tr) => tr.addEventListener('click', () => {
        const r = cur.rows.find((x) => String(x.r) === tr.dataset.r); if (!r) return;
        openDrawer(cur.tab + ' · row ' + r.r, '<dl class="fields">' + cur.headers.map((h, i) => r.c[i] ? '<dt>' + esc(h) + '</dt><dd>' + esc(r.c[i]) + '</dd>' : '').join('') + '</dl>' +
          (cur.url ? '<div class="actions"><a class="btn" href="' + esc(rowLink(cur, r.r)) + '" target="_blank" rel="noopener">Open in ' + (cur.native ? 'sheet' : 'Drive') + '</a></div>' : ''));
      }));
      view().querySelectorAll('.tbl-list button').forEach((b) => b.classList.toggle('on', b.dataset.t === cur.src + '|' + cur.tab));
    };
    view().innerHTML =
      '<select class="tbl-pick" id="tb-pick" aria-label="Table">' + tables.map((t) => '<option value="' + esc(t.src + '|' + t.tab) + '"' +
        (t === cur ? ' selected' : '') + '>' + esc(t.source + ' · ' + t.tab) + '</option>').join('') + '</select>' +
      '<div class="tbl-shell"><aside class="tbl-list">' + Object.keys(groups).map((g) => '<h2>' + esc(g) + '</h2>' +
        groups[g].map((t) => '<button type="button" data-t="' + esc(t.src + '|' + t.tab) + '"><span>' + esc(t.tab) + '</span><span>' + t.rows.length + '</span></button>').join('')).join('') +
      '</aside><section class="tbl-main"><div class="tbl-tools"><strong id="tb-title"></strong><span class="muted mono" id="tb-count"></span>' +
        '<input id="tb-q" type="search" placeholder="Filter rows…" aria-label="Filter rows"></div><div class="tbl-scroll" id="tb-grid"></div></section></div>' +
      '<p class="muted">Read-only copy of the company sheets, refreshed every hour. Click a row to see all of it.</p>';
    const choose = (key) => { cur = tables.find((t) => t.src + '|' + t.tab === key) || cur; LS.set('tableSel', key); $('#tb-pick').value = key; draw(); };
    view().querySelectorAll('.tbl-list button').forEach((b) => b.addEventListener('click', () => choose(b.dataset.t)));
    $('#tb-pick').addEventListener('change', (e) => choose(e.target.value));
    $('#tb-q').addEventListener('input', (e) => { q = e.target.value; draw(); });
    draw();
  }

  // ═════════ work: This month · Orders · Prices · Projects · Mail ═════════
  const W = () => state.work || {};
  async function loadWork() {
    try {
      state.work = await api('work'); await DB.setKv('work', state.work);
      // Permissions follow the sheet without signing in again (e.g. a new CRM permission).
      if (state.work.permissions && state.me && state.me.user && !state.me.user.isAdmin) { state.me.user.permissions = state.work.permissions; LS.set('me', state.me); }
    }
    catch (e) { if (!state.work) { try { state.work = (await DB.getKv('work')) || null; } catch (x) { state.work = null; } } }
    try { state.month = await api('monthChecklist', {}); LS.set('month', state.month); } catch (e) { /* keep the copy on this device */ }
    await loadInvoices();
    await loadCrm();
  }
  async function loadWorkFromDevice() {
    if (!state.work) { try { state.work = (await DB.getKv('work')) || null; } catch (e) { state.work = null; } }
  }
  const dShort = (v) => { if (!v) return ''; const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? v + 'T12:00:00' : v); return isNaN(d) ? String(v) : d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }); };
  const daysSince = (v) => Math.max(0, Math.floor((Date.now() - new Date(v).getTime()) / 86400000));
  const moneyFmt = (v) => (v === '' || v === null || v === undefined || isNaN(Number(v))) ? '' : '$' + Number(v).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const who = (email) => { const u = state.data && state.data.users; const n = String(email || '').split('@')[0]; return n ? n.charAt(0).toUpperCase() + n.slice(1) : ''; };
  const siteById = (id) => state.data && state.data.sites.find((s) => s.site_id === id);
  function siteOptions(selected) {
    const sites = ((state.data && state.data.sites) || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return '<option value="">— pick a site —</option>' + sites.map((s) => '<option value="' + esc(s.site_id) + '"' + (s.site_id === selected ? ' selected' : '') + '>' +
      esc(s.name) + (s.city ? ' · ' + esc(s.city) : '') + '</option>').join('') + '<option value="__other"' + (selected === '__other' ? ' selected' : '') + '>Other address…</option>';
  }
  function siteLink(id, name) {
    const s = id && siteById(id);
    return s ? '<a href="#/sites/' + encodeURIComponent(s.site_id) + '">' + esc(s.name) + '</a>' : esc(name || '');
  }
  /** A flow chart of steps: done steps filled, current one ringed, later ones hollow. */
  function flowHtml(steps, current, info) {
    const at = steps.indexOf(current);
    const closed = current === 'Cancelled' || current === 'Lost / cancelled';
    return '<ol class="flow' + (closed ? ' stopped' : '') + '">' + steps.map((s, i) => {
      const cls = closed ? (info[s] ? 'done' : 'todo') : i < at ? 'done' : i === at ? 'now' : 'todo';
      return '<li class="' + cls + '"><span class="dot" aria-hidden="true">' + (cls === 'done' ? '✓' : i + 1) + '</span><b>' + esc(s) + '</b>' +
        (info[s] ? '<small>' + info[s] + '</small>' : '') + '</li>';
    }).join('') + '</ol>' + (closed ? '<p class="chip flag">' + esc(current) + '</p>' : '');
  }
  function mailRow(m) {
    return '<div class="card mail-card" data-mail="' + esc(m.mail_id) + '"><div class="card-top">' +
      String(m.categories || '').split(',').filter(Boolean).map((c) => '<span class="chip c-' + esc(slug(c)) + '">' + esc(c) + '</span>').join('') +
      (m.direction === 'out' ? '<span class="chip">Sent</span>' : '') + (m.status === 'ignored' ? '<span class="chip fix">Ignored</span>' : '') +
      '<span class="muted">' + esc(fmtDate(m.received_at)) + '</span></div>' +
      '<div class="card-title">' + esc(m.subject || '(no subject)') + '</div>' +
      '<div class="card-meta"><span>' + esc(String(m.direction === 'out' ? 'To ' + m.to : m.from).replace(/<[^>]*>/g, '').trim()) + '</span>' +
        (m.site_id ? '<span>' + siteLink(m.site_id, m.site_name) + '</span>' : '') + (m.amounts ? '<span class="mono">' + esc(m.amounts) + '</span>' : '') +
        (m.linked_type === 'order' ? '<a href="#/orders/' + encodeURIComponent(m.linked_id) + '">' + esc(m.linked_id) + '</a>' : '') +
        (m.linked_type === 'project' ? '<a href="#/projects/' + encodeURIComponent(m.linked_id) + '">' + esc(m.linked_id) + '</a>' : '') + '</div>' +
      '<div class="card-body">' + esc(m.excerpt || m.snippet) + '</div></div>';
  }
  function bindMailCards(root) {
    root.querySelectorAll('[data-mail]').forEach((c) => c.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      openMail(c.dataset.mail);
    }));
  }
  function openMail(id) {
    const m = (W().mail || []).find((x) => x.mail_id === id); if (!m) return;
    const orders = (W().orders || []).filter((o) => o.stage !== 'Received' && o.stage !== 'Cancelled');
    const projects = (W().projects || []).filter((p) => p.status !== 'closed');
    openDrawer(m.subject || '(no subject)',
      '<p class="muted">' + esc(fmtDate(m.received_at)) + ' · ' + esc(m.direction === 'out' ? 'sent to ' + m.to : 'from ' + m.from) + '</p>' +
      '<div class="card-body" style="-webkit-line-clamp:unset;white-space:pre-wrap">' + esc(m.excerpt || m.snippet) + '</div>' +
      (m.attachments ? '<p class="muted">Attachments: ' + esc(m.attachments) + '</p>' : '') +
      '<div class="actions"><a class="btn primary" href="' + esc(m.link) + '" target="_blank" rel="noopener">Open in Gmail</a></div>' +
      (can('order.edit') ? '<h2>File this email</h2><div class="stack">' +
        '<div class="actions"><a class="btn" href="#/orders/new?mail=' + encodeURIComponent(m.mail_id) + '">New order from this email</a>' +
        (can('project.create') ? '<a class="btn" href="#/projects/new?mail=' + encodeURIComponent(m.mail_id) + '">New project</a>' : '') + '</div>' +
        (orders.length ? '<label class="field"><span>Add to an order</span><select id="ml-order"><option value="">—</option>' +
          orders.map((o) => '<option value="' + esc(o.order_id) + '">' + esc(o.order_id + ' · ' + o.title + (o.supplier ? ' (' + o.supplier + ')' : '')) + '</option>').join('') + '</select></label>' : '') +
        (projects.length && can('project.edit') ? '<label class="field"><span>Add to a project</span><select id="ml-project"><option value="">—</option>' +
          projects.map((p) => '<option value="' + esc(p.project_id) + '">' + esc(p.project_id + ' · ' + p.title) + '</option>').join('') + '</select></label>' : '') +
        '<div class="actions"><button class="btn" type="button" id="ml-save">Save</button>' +
        (m.status !== 'ignored' ? '<button class="btn ghost" type="button" id="ml-ignore">Not work-related</button>' : '') + '</div>' +
        '<p class="muted" id="ml-err" role="alert"></p></div>' : ''));
    const save = $('#ml-save');
    if (save) save.addEventListener('click', async () => {
      const o = $('#ml-order') && $('#ml-order').value, p = $('#ml-project') && $('#ml-project').value;
      if (!o && !p) { $('#ml-err').textContent = 'Pick an order or a project.'; return; }
      try {
        if (o) await api('orderStep', { order_id: o, mail_id: m.mail_id, mail_thread_id: m.thread_id, note: 'Email: ' + m.subject });
        if (p) await api('projectStep', { project_id: p, mail_id: m.mail_id, note: 'Email: ' + m.subject });
        await loadWork(); toast('Filed'); $('#drawer').hidden = true; route();
      } catch (e) { $('#ml-err').textContent = e.message; }
    });
    const ig = $('#ml-ignore');
    if (ig) ig.addEventListener('click', async () => {
      try { await api('linkMail', { mail_id: m.mail_id, ignore: true }); m.status = 'ignored'; $('#drawer').hidden = true; route(); }
      catch (e) { $('#ml-err').textContent = e.message; }
    });
  }

  // ───────── This month: maintenance due + invoice checklist ─────────
  async function renderMonth(params) {
    let mc = state.month;
    const want = params.get('m');
    if (want && (!mc || mc.month !== want)) {
      view().innerHTML = '<div class="empty">Loading…</div>';
      try { mc = await api('monthChecklist', { month: want }); } catch (e) { view().innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
    }
    if (!mc) { view().innerHTML = '<div class="empty">Connect once to download this month\'s list.</div>'; return; }
    drawMonth(mc);
  }
  function drawMonth(mc) {
    const label = (ym) => new Date(ym + '-15T12:00:00').toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
    const maintAll = mc.items.filter((i) => i.type === 'Maintenance').sort((a, b) => a.address.localeCompare(b.address));
    const maint = maintAll.filter((i) => i.segment !== 'RES'), resMaint = maintAll.filter((i) => i.segment === 'RES');
    const resMail = mc.items.filter((i) => i.type === 'Residential email').sort((a, b) => a.address.localeCompare(b.address));
    const draft = (i) => {
      const t = mc.template || {}; const first = String(i.contact_name || '').split(/[\s,/&]+/)[0] || 'there';
      const vars = { first_name: first, customer: i.contact_name || '', address: i.address, month: label(mc.month).split(' ')[0], package: i.package || '', frequency: String(i.frequency || '').toLowerCase() };
      const fill = (x) => String(x || '').replace(/\{(\w+)\}/g, (m, k) => vars[k] !== undefined ? vars[k] : m);
      return { subject: fill(t.subject), body: fill(t.body) };
    };
    const resRow = (i) => {
      const d = draft(i);
      const url = 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(mc.sendFrom || '') + '&view=cm&fs=1&to=' + encodeURIComponent(i.contact_email || '') +
        '&su=' + encodeURIComponent(d.subject) + '&body=' + encodeURIComponent(d.body);
      return '<li class="check' + (i.status === 'done' ? ' is-done' : '') + '"><label><input type="checkbox" data-task="' + esc(i.task_id) + '"' + (i.status === 'done' ? ' checked' : '') + '>' +
        '<span><b>' + esc(i.contact_name || 'Customer') + ' · ' + esc(i.address) + '</b><small>' + esc(i.frequency) + (i.package ? ' · ' + esc(i.package) : '') + ' · ' + esc(i.contact_email || 'no email on file') +
        (i.status === 'done' ? '<br>✓ sent · ' + esc(who(i.done_by)) + ' ' + esc(dShort(i.done_at)) + te('Tasks', i.task_id, 'done_at', i.done_at) : '') + '</small></span></label>' +
        '<span class="check-links">' + (i.contact_email ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">Open draft in Gmail</a>' : '') +
        '<a href="#" data-copy="' + esc(i.task_id) + '">Copy text</a></span></li>';
    };
    const inv = mc.items.filter((i) => i.type === 'Maintenance invoice').sort((a, b) => a.address.localeCompare(b.address));
    const doneN = (l) => l.filter((i) => i.status === 'done').length;
    const bar = (l) => '<span class="meter" role="img" aria-label="' + doneN(l) + ' of ' + l.length + '"><i style="width:' + (l.length ? Math.round(doneN(l) / l.length * 100) : 0) + '%"></i></span>';
    const hst = Number(mc.hst || 13);
    const total = inv.reduce((s, i) => s + (Number(i.amount) || 0), 0);
    const row = (i, isInv) => {
      const subj = 'Krysnor Elevator – ' + label(mc.month).split(' ')[0] + ' maintenance invoice – ' + i.address;
      return '<li class="check' + (i.status === 'done' ? ' is-done' : '') + '"><label><input type="checkbox" data-task="' + esc(i.task_id) + '"' + (i.status === 'done' ? ' checked' : '') + '>' +
        '<span><b>' + esc(i.address) + '</b>' +
        '<small>' + esc(i.frequency) + (i.due_months && i.frequency !== 'Monthly' ? ' · ' + esc(i.due_months) : '') +
          (isInv && i.amount !== '' ? '<br><span class="mono">' + moneyFmt(i.amount) + ' + HST = ' + moneyFmt(Number(i.amount) * (1 + hst / 100)) + '</span>' : '') +
          (i.status === 'done' ? '<br>✓ ' + esc(i.done_by === 'Maintenance Record' ? 'visit in the maintenance record' : who(i.done_by) + ' ' + dShort(i.done_at)) + te('Tasks', i.task_id, 'done_at', i.done_at) : '') + '</small></span></label>' +
        '<span class="check-links">' + (i.site_id ? '<a href="#/sites/' + encodeURIComponent(i.site_id) + '">History</a>' : '') +
          (isInv && i.contact_email ? '<a href="mailto:' + esc(i.contact_email) + '?subject=' + encodeURIComponent(subj) + '">Email ' + esc(i.contact_name || i.contact_email) + '</a>' : '') + '</span></li>';
    };
    view().innerHTML = '<div class="page-head"><h1>' + esc(label(mc.month)) + '</h1>' +
      (mc.months.length > 1 ? '<select id="m-pick" aria-label="Month">' + mc.months.map((m) => '<option value="' + m + '"' + (m === mc.month ? ' selected' : '') + '>' + esc(label(m)) + '</option>').join('') + '</select>' : '') + '</div>' +
      '<p class="muted">From the company Maintenance Record: commercial sites due this month (monthly, quarterly, semi-annual) and residential customers due this month. A visit written in the record ticks the visit lists by itself.</p>' +
      (mc.items.length ? '' : '<div class="empty">No maintenance list for your role this month.</div>') +
      (inv.length ? '<h2>Invoices to send · ' + doneN(inv) + ' of ' + inv.length + ' ' + bar(inv) + '</h2>' +
        '<p class="muted mono">Total ' + moneyFmt(total) + ' + HST ' + hst + '% = ' + moneyFmt(total * (1 + hst / 100)) + '</p>' +
        '<ul class="checklist">' + inv.map((i) => row(i, true)).join('') + '</ul>' : '') +
      (maint.length ? '<h2>' + (resMaint.length ? 'Commercial maintenance' : 'Maintenance visits') + ' · ' + doneN(maint) + ' of ' + maint.length + ' done ' + bar(maint) + '</h2>' +
        '<ul class="checklist">' + maint.map((i) => row(i, false)).join('') + '</ul>' : '') +
      (resMail.length ? '<h2>Residential: booking emails · ' + doneN(resMail) + ' of ' + resMail.length + ' sent ' + bar(resMail) + '</h2>' +
        '<p class="muted">A draft is ready for each customer due this month. Open it in Gmail (' + esc(mc.sendFrom || '') + '), check it, send it, then tick it here.</p>' +
        '<ul class="checklist">' + resMail.map(resRow).join('') + '</ul>' : '') +
      (resMaint.length ? '<h2>Residential maintenance · ' + doneN(resMaint) + ' of ' + resMaint.length + ' done ' + bar(resMaint) + '</h2>' +
        '<ul class="checklist">' + resMaint.map((i) => row(i, false)).join('') + '</ul>' : '');
    const pick = $('#m-pick'); if (pick) pick.addEventListener('change', () => { location.hash = '#/month?m=' + pick.value; });
    view().querySelectorAll('[data-copy]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault(); const it = mc.items.find((x) => x.task_id === a.dataset.copy); const d = draft(it);
      const text = 'To: ' + (it.contact_email || '') + '\nSubject: ' + d.subject + '\n\n' + d.body;
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('Copied'), () => openDrawer('Draft', '<textarea style="width:100%;min-height:300px">' + esc(text) + '</textarea>'));
    }));
    view().querySelectorAll('[data-task]').forEach((cb) => cb.addEventListener('change', async () => {
      const it = mc.items.find((x) => x.task_id === cb.dataset.task);
      cb.disabled = true;
      try {
        await api('setTask', { task_id: it.task_id, done: cb.checked });
        it.status = cb.checked ? 'done' : 'open'; it.done_by = state.me.user.email; it.done_at = new Date().toISOString();
        if (state.month && state.month.month === mc.month) { state.month = mc; LS.set('month', mc); }
        const y = window.scrollY; drawMonth(mc); window.scrollTo(0, y);
      } catch (e) { cb.checked = !cb.checked; cb.disabled = false; toast(e.message); }
    }));
  }

  // ───────── Orders ─────────
  function orderInfo(o) {
    const st = (W().stages && W().stages.order) || [];
    const ev = (W().orderEvents || []).filter((e) => e.order_id === o.order_id).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const info = {};
    ev.forEach((e) => { if (e.stage && !info[e.stage]) info[e.stage] = dShort(e.at); });
    if (st[1] && o.quote_amount !== '' && o.quote_amount !== undefined) info[st[1]] = (info[st[1]] ? info[st[1]] + ' · ' : '') + moneyFmt(o.quote_amount) + (o.quote_ref ? ' · ' + esc(o.quote_ref) : '');
    if (st[3] && o.ready_date) info[st[3]] = (o.delivery_method ? esc(o.delivery_method) + ' ' : '') + 'on ' + dShort(o.ready_date) + (info[st[3]] ? ' (set ' + info[st[3]] + ')' : '');
    return { stages: st, events: ev, info };
  }
  function orderCard(o) {
    return '<a class="card" href="#/orders/' + encodeURIComponent(o.order_id) + '"><div class="card-top"><span class="ticket">' + esc(o.order_id) + '</span>' +
      (o.supplier ? '<span class="chip">' + esc(o.supplier) + '</span>' : '') + (o.quote_amount !== '' && o.quote_amount !== undefined ? '<span class="mono">' + moneyFmt(o.quote_amount) + '</span>' : '') + '</div>' +
      '<div class="card-title">' + esc(o.title) + '</div><div class="card-meta"><span>' + esc(o.site_name || '') + '</span>' +
      (o.ready_date && o.stage !== 'Received' ? '<span class="chip flag">' + esc(o.delivery_method || 'Ready') + ' ' + esc(dShort(o.ready_date)) + '</span>' : '') +
      '<span>' + esc(o.stage) + ' · ' + daysSince(o.stage_at) + 'd</span></div></a>';
  }
  function renderOrders() {
    const w = W();
    if (!w.orders) { view().innerHTML = '<div class="empty">' + (state.work ? 'Your role cannot see orders.' : 'Connect once to download orders.') + '</div>'; return; }
    const st = w.stages.order;
    const f = state.orderFilter || 'open';
    const q = (state.orderQ || '').toLowerCase();
    const list = w.orders.filter((o) => (f === 'all' || (f === 'open' ? o.stage !== st[st.length - 1] && o.stage !== 'Cancelled' : o.stage === st[st.length - 1] || o.stage === 'Cancelled')) &&
      (!q || [o.order_id, o.title, o.supplier, o.site_name, o.notes].join(' ').toLowerCase().indexOf(q) >= 0));
    const cols = f === 'open' ? st.slice(0, -1) : f === 'done' ? [st[st.length - 1], 'Cancelled'] : st.concat(['Cancelled']);
    view().innerHTML = '<div class="page-head"><h1>Orders</h1>' + (can('order.edit') ? '<a class="btn primary" href="#/orders/new">New order</a>' : '') +
      '<a class="btn ghost" href="#/prices">Part prices</a></div>' +
      '<div class="toolbar"><input id="o-q" type="search" placeholder="Search part, supplier, address…" value="' + esc(state.orderQ || '') + '" aria-label="Search orders">' +
      '<div class="seg" role="group" aria-label="Show">' + [['open', 'Open'], ['done', 'Received'], ['all', 'All']].map((x) => '<button type="button" data-of="' + x[0] + '" class="' + (f === x[0] ? 'on' : '') + '">' + x[1] + '</button>').join('') + '</div></div>' +
      '<div class="board">' + cols.map((c) => { const l = list.filter((o) => o.stage === c); return '<section class="lane"><h2>' + esc(c) + ' · ' + l.length + '</h2>' +
        (l.length ? '<div class="list">' + l.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).map(orderCard).join('') + '</div>' : '<p class="muted lane-empty">—</p>') + '</section>'; }).join('') + '</div>';
    view().querySelectorAll('[data-of]').forEach((b) => b.addEventListener('click', () => { state.orderFilter = b.dataset.of; renderOrders(); }));
    const qi = $('#o-q'); qi.addEventListener('input', () => { state.orderQ = qi.value; const p = qi.selectionStart; renderOrders(); const n = $('#o-q'); n.focus(); n.setSelectionRange(p, p); });
  }
  function renderOrderNew(params) {
    if (!can('order.edit')) { view().innerHTML = '<div class="empty">Your role cannot open orders.</div>'; return; }
    const mail = params.get('mail') && (W().mail || []).find((m) => m.mail_id === params.get('mail'));
    const sup = mail && mail.supplier ? mail.supplier : '';
    const site = params.get('site') || (mail && mail.site_id) || '';
    const proj = params.get('project') || '';
    view().innerHTML = '<a class="back" href="#/orders">‹ Orders</a><h1>New order</h1>' +
      (mail ? '<div class="stamp"><span>From email: <strong>' + esc(mail.subject) + '</strong></span><span class="muted">' + esc(mail.from) + '</span></div>' : '') +
      '<form class="stack" id="of" novalidate>' +
      '<label class="field"><span>What are we ordering?</span><input id="o-title" type="text" required placeholder="e.g. GAL door operator board MOVFR" value="' + esc(mail ? mail.subject.replace(/^(re|fwd?):\s*/i, '') : '') + '"></label>' +
      '<label class="field"><span>Supplier</span><input id="o-sup" type="text" list="sup-list" value="' + esc(sup) + '"><datalist id="sup-list">' +
        (W().suppliers || []).map((s) => '<option value="' + esc(s.name) + '">').join('') + '</datalist></label>' +
      '<label class="field"><span>For which address</span><select id="o-site">' + siteOptions(site) + '</select></label>' +
      '<label class="field" id="o-other-f" hidden><span>Address</span><input id="o-other" type="text"></label>' +
      '<label class="field"><span>Project (optional)</span><select id="o-proj"><option value="">—</option>' +
        (W().projects || []).filter((p) => p.status !== 'closed').map((p) => '<option value="' + esc(p.project_id) + '"' + (p.project_id === proj ? ' selected' : '') + '>' + esc(p.project_id + ' · ' + p.title) + '</option>').join('') + '</select></label>' +
      '<label class="field"><span>First note</span><textarea id="o-note" placeholder="e.g. Asked CITI for price and lead time by email">' + esc(mail ? 'Email: ' + mail.subject : '') + '</textarea></label>' +
      '<p class="muted" id="o-err" role="alert"></p><div class="actions"><button class="btn primary" type="submit">Open order</button></div></form>';
    const sel = $('#o-site'); const tog = () => { $('#o-other-f').hidden = sel.value !== '__other'; }; sel.addEventListener('change', tog); tog();
    $('#of').addEventListener('submit', async (e) => {
      e.preventDefault(); const err = $('#o-err'); err.textContent = '';
      const sid = sel.value === '__other' ? '' : sel.value;
      try {
        const r = await api('saveOrder', { title: $('#o-title').value, supplier: $('#o-sup').value, site_id: sid,
          site_name: sel.value === '__other' ? $('#o-other').value : (siteById(sid) || {}).name, project_id: $('#o-proj').value,
          first_note: $('#o-note').value, mail_id: mail ? mail.mail_id : '', mail_thread_id: mail ? mail.thread_id : '' });
        await loadWork(); toast(r.order.order_id + ' opened'); location.hash = '#/orders/' + encodeURIComponent(r.order.order_id);
      } catch (ex) { err.textContent = ex.message; }
    });
  }
  function renderOrder(id) {
    const o = (W().orders || []).find((x) => x.order_id === id);
    if (!o) { view().innerHTML = '<div class="empty">Order not found. <a href="#/orders">Back to orders</a></div>'; return; }
    const { stages, events, info } = orderInfo(o);
    const prices = (W().prices || []).filter((p) => p.order_id === id);
    const mails = (W().mail || []).filter((m) => (m.linked_type === 'order' && m.linked_id === id) || String(o.mail_thread_ids || '').split(',').indexOf(m.thread_id) >= 0);
    const mailById = {}; (W().mail || []).forEach((m) => { mailById[m.mail_id] = m; });
    const next = stages[Math.min(stages.indexOf(o.stage) + 1, stages.length - 1)];
    const proj = o.project_id && (W().projects || []).find((p) => p.project_id === o.project_id);
    view().innerHTML = '<a class="back" href="#/orders">‹ Orders</a>' +
      '<div class="page-head"><h1>' + esc(o.title) + '</h1><span class="ticket">' + esc(o.order_id) + '</span></div>' +
      '<dl class="kv"><dt>Supplier</dt><dd>' + esc(o.supplier || '—') + '</dd><dt>Address</dt><dd>' + siteLink(o.site_id, o.site_name) + '</dd>' +
        (proj ? '<dt>Project</dt><dd><a href="#/projects/' + encodeURIComponent(proj.project_id) + '">' + esc(proj.project_id + ' · ' + proj.title) + '</a></dd>' : '') +
        '<dt>Opened</dt><dd>' + esc(dShort(o.created_at)) + ' by ' + esc(who(o.created_by)) + te('Orders', o.order_id, 'created_at', o.created_at) + '</dd>' + (o.notes ? '<dt>Notes</dt><dd>' + esc(o.notes) + '</dd>' : '') + '</dl>' +
      flowHtml(stages, o.stage, info) +
      (can('order.edit') && o.stage !== stages[stages.length - 1] && o.stage !== 'Cancelled' ? '<h2>Next step</h2><form class="stack step-form" id="os" novalidate>' +
        '<div class="row2"><label class="field"><span>Step</span><select id="os-stage">' + stages.concat(['Cancelled']).map((s) => '<option' + (s === next ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select></label>' +
        '<label class="field" data-for="quote"><span>Supplier price (total)</span><input id="os-amt" type="text" inputmode="decimal" placeholder="$"></label></div>' +
        '<div class="row2"><label class="field" data-for="quote"><span>Quote #</span><input id="os-ref" type="text"></label>' +
        '<label class="field" data-for="ready"><span>Pickup / delivery date</span><input id="os-date" type="date"></label>' +
        '<label class="field" data-for="ready"><span>How</span><select id="os-how"><option>Pickup</option><option>Delivery</option></select></label></div>' +
        '<label class="field"><span>Note</span><input id="os-note" type="text" placeholder="e.g. Chris approved; supplier says ready Thursday"></label>' +
        '<p class="muted" id="os-err" role="alert"></p><div class="actions"><button class="btn primary" type="submit">Save step</button>' +
        '<button class="btn ghost" type="button" id="os-noteonly">Add note only</button></div></form>' : '') +
      '<h2>Part prices · ' + prices.length + '</h2>' +
      (prices.length ? '<div class="tscroll"><table class="ptable"><thead><tr><th>Part</th><th>Part #</th><th>Qty</th><th>Unit price</th><th>Total</th><th>Status</th><th>Date</th></tr></thead><tbody>' +
        prices.map((p) => '<tr><td>' + esc(p.part) + '</td><td class="mono">' + esc(p.part_no) + '</td><td>' + esc(p.qty) + ' ' + esc(p.unit) + '</td><td class="mono">' + moneyFmt(p.unit_price) +
          '</td><td class="mono">' + moneyFmt(p.total) + '</td><td>' + esc(p.status) + '</td><td>' + esc(dShort(p.date)) + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="muted">No prices recorded yet. Add what the supplier quoted, so next time we know our cost.</p>') +
      (can('order.edit') ? '<details class="add-site"><summary class="btn">Add part prices</summary><form class="stack" id="pf" novalidate>' +
        '<div class="row2"><label class="field"><span>Date</span><input id="pf-date" type="date" value="' + esc(new Date().toISOString().slice(0, 10)) + '"></label>' +
        '<label class="field"><span>Status</span><select id="pf-status"><option value="quoted">Quoted</option><option value="bought">Bought</option></select></label></div>' +
        '<div id="pf-lines"></div><div class="actions"><button class="btn ghost" type="button" id="pf-more">+ Another part</button></div>' +
        '<p class="muted" id="pf-err" role="alert"></p><div class="actions"><button class="btn primary" type="submit">Save prices</button></div></form></details>' : '') +
      '<h2>Timeline</h2><ol class="timeline">' + events.slice().reverse().map((e) => {
        const m = e.mail_id && mailById[e.mail_id];
        return '<li><span class="muted">' + esc(fmtDate(e.at)) + '</span> ' + (e.stage ? '<b>' + esc(e.stage) + '</b> ' : '') + esc(e.note || '') +
          (e.amount !== '' && e.amount !== undefined ? ' <span class="mono">' + moneyFmt(e.amount) + '</span>' : '') + (e.date_value ? ' · ' + esc(dShort(e.date_value)) : '') +
          ' <span class="muted">· ' + esc(who(e.by)) + '</span>' + te('Order Events', e.event_id, 'at', e.at) + (m ? ' · <a href="' + esc(m.link) + '" target="_blank" rel="noopener">email</a>' : '') + '</li>';
      }).join('') + '</ol>' +
      (mails.length ? '<h2>Emails · ' + mails.length + '</h2><div class="list">' + mails.map(mailRow).join('') + '</div>' : '');
    bindMailCards(view());
    const form = $('#os');
    if (form) {
      const sync = () => { const s = $('#os-stage').value; form.querySelectorAll('[data-for]').forEach((el) => { el.hidden = !((el.dataset.for === 'quote' && s === stages[1]) || (el.dataset.for === 'ready' && s === stages[3])); }); };
      $('#os-stage').addEventListener('change', sync); sync();
      const send = async (noteOnly) => {
        const err = $('#os-err'); err.textContent = '';
        const s = $('#os-stage').value;
        if (!noteOnly && s === stages[3] && !$('#os-date').value) { err.textContent = 'When can we pick it up / when is it delivered?'; return; }
        if (noteOnly && !$('#os-note').value.trim()) { err.textContent = 'Write the note first.'; return; }
        try {
          await api('orderStep', noteOnly ? { order_id: id, note: $('#os-note').value } : { order_id: id, stage: s, note: $('#os-note').value,
            quote_amount: s === stages[1] ? $('#os-amt').value : '', quote_ref: s === stages[1] ? $('#os-ref').value : '',
            ready_date: s === stages[3] ? $('#os-date').value : '', delivery_method: s === stages[3] ? $('#os-how').value : '' });
          await loadWork(); toast('Saved'); renderOrder(id);
        } catch (ex) { err.textContent = ex.message; }
      };
      form.addEventListener('submit', (e) => { e.preventDefault(); send(false); });
      $('#os-noteonly').addEventListener('click', () => send(true));
    }
    const pf = $('#pf');
    if (pf) {
      const line = () => '<div class="pline"><input type="text" class="pl-part" placeholder="Part" aria-label="Part"><input type="text" class="pl-no" placeholder="Part #" aria-label="Part number">' +
        '<input type="text" class="pl-qty" inputmode="decimal" value="1" aria-label="Quantity"><input type="text" class="pl-price" inputmode="decimal" placeholder="Unit $" aria-label="Unit price"></div>';
      $('#pf-lines').innerHTML = line();
      $('#pf-more').addEventListener('click', () => $('#pf-lines').insertAdjacentHTML('beforeend', line()));
      pf.addEventListener('submit', async (e) => {
        e.preventDefault(); const err = $('#pf-err'); err.textContent = '';
        const lines = Array.from(pf.querySelectorAll('.pline')).map((l) => ({ part: l.querySelector('.pl-part').value, part_no: l.querySelector('.pl-no').value,
          qty: l.querySelector('.pl-qty').value, unit_price: l.querySelector('.pl-price').value })).filter((l) => l.part.trim());
        try { await api('savePrices', { order_id: id, supplier: o.supplier, site_name: o.site_name, date: $('#pf-date').value, status: $('#pf-status').value, lines });
              await loadWork(); toast('Prices saved'); renderOrder(id); }
        catch (ex) { err.textContent = ex.message; }
      });
    }
  }

  // ───────── Part prices (what we paid / were quoted, so we know our cost) ─────────
  function renderPrices() {
    const w = W();
    if (!w.prices) { view().innerHTML = '<div class="empty">' + (state.work ? 'Your role cannot see prices.' : 'Connect once to download prices.') + '</div>'; return; }
    const q = (state.priceQ || '').toLowerCase();
    const groups = {};
    w.prices.forEach((p) => { const k = String(p.part_no || p.part).trim().toLowerCase(); (groups[k] = groups[k] || []).push(p); });
    const rows = Object.keys(groups).map((k) => { const l = groups[k].sort((a, b) => String(b.date).localeCompare(String(a.date))); return { k, l, last: l[0] }; })
      .filter((g) => !q || g.l.some((p) => [p.part, p.part_no, p.supplier, p.site_name, p.order_id].join(' ').toLowerCase().indexOf(q) >= 0))
      .sort((a, b) => String(a.last.part).localeCompare(String(b.last.part)));
    view().innerHTML = '<div class="page-head"><h1>Part prices</h1><span class="muted">' + w.prices.length + ' prices · ' + Object.keys(groups).length + ' parts</span></div>' +
      '<p class="muted">Every price a supplier quoted us or we paid, newest first. Add prices from an order.</p>' +
      '<div class="search-box"><input id="p-q" type="search" placeholder="Part, part #, supplier…" value="' + esc(state.priceQ || '') + '" aria-label="Search prices"></div>' +
      (rows.length ? '<div class="tscroll"><table class="ptable"><thead><tr><th>Part</th><th>Last price</th><th>Supplier</th><th>Date</th><th>Range</th><th></th></tr></thead><tbody>' +
        rows.map((g) => { const u = g.l.map((p) => Number(p.unit_price)); const lo = Math.min.apply(null, u), hi = Math.max.apply(null, u);
          return '<tr class="prow" data-k="' + esc(g.k) + '"><td><b>' + esc(g.last.part) + '</b>' + (g.last.part_no ? '<br><span class="mono muted">' + esc(g.last.part_no) + '</span>' : '') + '</td>' +
            '<td class="mono">' + moneyFmt(g.last.unit_price) + ' / ' + esc(g.last.unit || 'ea') + '<br><span class="muted">' + esc(g.last.status) + '</span></td><td>' + esc(g.last.supplier) + '</td><td>' + esc(dShort(g.last.date)) + '</td>' +
            '<td class="mono">' + (g.l.length > 1 ? moneyFmt(lo) + ' – ' + moneyFmt(hi) : '') + '</td><td>' + (g.l.length > 1 ? g.l.length + ' prices' : '') + '</td></tr>' +
            '<tr class="phist" data-for="' + esc(g.k) + '" hidden><td colspan="6"><ul>' + g.l.map((p) => '<li>' + esc(dShort(p.date)) + ' · ' + esc(p.supplier) + ' · <span class="mono">' + moneyFmt(p.unit_price) + '</span> × ' + esc(p.qty) +
              ' · ' + esc(p.status) + (p.order_id ? ' · <a href="#/orders/' + encodeURIComponent(p.order_id) + '">' + esc(p.order_id) + '</a>' : '') + (p.site_name ? ' · ' + esc(p.site_name) : '') + '</li>').join('') + '</ul></td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="empty">' + (q ? 'No part matches.' : 'No prices yet. Open an order and use "Add part prices".') + '</div>');
    const qi = $('#p-q'); qi.addEventListener('input', () => { state.priceQ = qi.value; const p = qi.selectionStart; renderPrices(); const n = $('#p-q'); n.focus(); n.setSelectionRange(p, p); });
    view().querySelectorAll('.prow').forEach((r) => r.addEventListener('click', () => { const h = view().querySelector('.phist[data-for="' + CSS.escape(r.dataset.k) + '"]'); if (h) h.hidden = !h.hidden; }));
  }

  // ───────── Projects (installation / repair flow) ─────────
  const typeName = (t) => ((state.data && state.data.projectTypes) || []).find((x) => x.type_id === t) || { name: t };
  function projectSteps(p) {
    return (W().projectStages || []).filter((s) => s.type_id === p.type_id && (String(s.segments || 'ALL').toUpperCase() === 'ALL' || String(s.segments).toUpperCase() === String(p.segment_id).toUpperCase()))
      .sort((a, b) => Number(a.order) - Number(b.order));
  }
  const stepsFor = (typeId, seg) => projectSteps({ type_id: typeId, segment_id: seg });
  function renderProjects() {
    const w = W();
    if (!w.projects) { view().innerHTML = '<div class="empty">' + (state.work ? 'Your role cannot see projects.' : 'Connect once to download projects.') + '</div>'; return; }
    const showClosed = !!state.projClosed;
    const stepFilter = state.projStep || '';
    const open = w.projects.filter((p) => p.status !== 'closed');
    const list = w.projects.filter((p) => (showClosed || p.status !== 'closed') && (!stepFilter || p.type_id + '|' + p.stage === stepFilter))
      .sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)));
    const byType = {}; list.forEach((p) => { (byType[p.type_id] = byType[p.type_id] || []).push(p); });
    // Flow of each project type with how many open projects sit in each step (click a step to filter)
    const types = [...new Set(['INS', 'REP'].concat(open.map((p) => p.type_id)))].filter((t) => (w.projectStages || []).some((s) => s.type_id === t));
    const flow = types.map((t) => {
      const names = [...new Set((w.projectStages || []).filter((s) => s.type_id === t).sort((a, b) => Number(a.order) - Number(b.order)).map((s) => s.stage))];
      return '<div class="pipe"><div class="pipe-h">' + esc(typeName(t).name) + '</div><ol>' + names.map((n) => {
        const c = open.filter((p) => p.type_id === t && p.stage === n).length;
        const st = (w.projectStages || []).find((s) => s.type_id === t && s.stage === n) || {};
        const who = String(st.assign_roles || '').split(',').map((r) => ({ manager: 'Chris', office: 'Kyle', technician: 'Tech', sales: 'Sales', admin: 'Kaixin' })[r.trim()] || '').filter(Boolean).join('/');
        return '<li class="' + (c ? 'has' : '') + (stepFilter === t + '|' + n ? ' on' : '') + '"><button type="button" data-step="' + esc(t + '|' + n) + '"' + (c ? '' : ' disabled') + '>' +
          '<b>' + (c || '') + '</b><span>' + esc(n) + '</span>' + (who ? '<small>' + esc(who) + (String(st.segments || 'ALL') !== 'ALL' ? ' · ' + esc(st.segments) : '') + '</small>' : '') + '</button></li>';
      }).join('') + '</ol></div>';
    }).join('');
    // Ongoing jobs found in the Project Tracker and in mail
    const sug = (w.suggestions || []).slice().sort((a, b) => String(b.proposal_date || b.inquiry_date).localeCompare(String(a.proposal_date || a.inquiry_date)));
    const sugHtml = sug.length && can('project.create') ? '<details class="sug"' + (state.sugClosed ? '' : ' open') + '><summary><b>Ongoing jobs found · ' + sug.length + '</b>' +
        '<span class="muted">from the company Project Tracker and mail — tick the real ones and add them</span></summary>' +
        '<div class="actions"><button class="btn ghost" type="button" id="sg-all">Select all</button><button class="btn primary" type="button" id="sg-add">Add selected</button><span class="muted" id="sg-msg"></span></div>' +
        '<ul class="checklist sug-list">' + sug.map((x) => {
          const steps = stepsFor(x.type_id, x.segment_id).map((s) => s.stage);
          return '<li class="check" data-ref="' + esc(x.ref) + '"><label><input type="checkbox" class="sg-cb">' +
            '<span><b>' + esc(x.title) + '</b><small>' + esc(x.source) + ' · ' + esc(x.segment_id === 'RES' ? 'Residential' : 'Commercial') + ' · ' + esc(typeName(x.type_id).name) +
            (x.value ? ' · <span class="mono">' + moneyFmt(x.value) + '</span>' : '') +
            (x.proposal_date ? ' · quote sent ' + esc(dShort(x.proposal_date)) : x.inquiry_date ? ' · enquiry ' + esc(dShort(x.inquiry_date)) : '') +
            (x.site_name ? '<br>' + esc(x.site_name) : '') + (x.next_steps ? '<br>' + esc(x.next_steps) : '') + '</small></span></label>' +
            '<span class="check-links"><select class="sg-stage" aria-label="Step">' + steps.map((n) => '<option' + (n === x.stage ? ' selected' : '') + '>' + esc(n) + '</option>').join('') + '</select>' +
            (x.link ? '<a href="' + esc(x.link) + '" target="_blank" rel="noopener">Source</a>' : '') + '<a href="#" class="sg-no">Not a job</a></span></li>';
        }).join('') + '</ul></details>' : '';
    view().innerHTML = '<div class="page-head"><h1>Projects</h1>' + (can('project.create') ? '<a class="btn primary" href="#/projects/new">New project</a>' : '') +
      '<label class="check-row"><input type="checkbox" id="pj-closed"' + (showClosed ? ' checked' : '') + '>Show closed</label></div>' +
      sugHtml + flow +
      (stepFilter ? '<p class="muted">Showing step "' + esc(stepFilter.split('|')[1]) + '" · <a href="#" id="pj-clear">show all</a></p>' : '') +
      (list.length ? '' : '<div class="empty">' + (sug.length ? 'No projects yet — add the ongoing jobs found above.' : 'No open projects.') + '</div>') +
      Object.keys(byType).map((t) => '<h2>' + esc(typeName(t).name) + ' · ' + byType[t].length + '</h2><div class="list">' + byType[t].map((p) => {
        const steps = projectSteps(p); const i = steps.findIndex((s) => s.stage === p.stage);
        return '<a class="card" href="#/projects/' + encodeURIComponent(p.project_id) + '"><div class="card-top"><span class="ticket">' + esc(p.project_id) + '</span><span class="chip">' + esc(p.segment_id) + '</span>' +
          '<span class="chip' + (p.status === 'closed' ? ' t-ok' : '') + '">' + esc(p.stage || p.status) + '</span>' + (steps.length ? '<span class="muted">step ' + (i + 1) + ' of ' + steps.length + ' · ' + daysSince(p.stage_at || p.created_at) + 'd</span>' : '') + '</div>' +
          '<div class="card-title">' + esc(p.title) + '</div><div class="card-meta"><span>' + esc(p.site_name || '') + '</span>' + (p.customer ? '<span>' + esc(p.customer) + '</span>' : '') + (p.value ? '<span class="mono">' + moneyFmt(p.value) + '</span>' : '') + '</div></a>';
      }).join('') + '</div>').join('');
    $('#pj-closed').addEventListener('change', (e) => { state.projClosed = e.target.checked; renderProjects(); });
    view().querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => { state.projStep = state.projStep === b.dataset.step ? '' : b.dataset.step; renderProjects(); }));
    const clr = $('#pj-clear'); if (clr) clr.addEventListener('click', (e) => { e.preventDefault(); state.projStep = ''; renderProjects(); });
    const sd = view().querySelector('details.sug'); if (sd) sd.addEventListener('toggle', () => { state.sugClosed = !sd.open; });
    const all = $('#sg-all'); if (all) all.addEventListener('click', () => { const cbs = view().querySelectorAll('.sg-cb'); const on = Array.from(cbs).some((c) => !c.checked); cbs.forEach((c) => { c.checked = on; }); });
    view().querySelectorAll('.sg-no').forEach((a) => a.addEventListener('click', async (e) => {
      e.preventDefault(); const li = a.closest('li'); const ref = li.dataset.ref;
      try { await api('dismissSuggestion', { ref }); w.suggestions = w.suggestions.filter((x) => x.ref !== ref); li.remove(); toast('Removed from the list'); } catch (ex) { toast(ex.message); }
    }));
    const add = $('#sg-add');
    if (add) add.addEventListener('click', async () => {
      const items = Array.from(view().querySelectorAll('.sug-list li')).filter((li) => li.querySelector('.sg-cb').checked)
        .map((li) => ({ ref: li.dataset.ref, stage: li.querySelector('.sg-stage').value }));
      if (!items.length) { $('#sg-msg').textContent = 'Tick at least one job.'; return; }
      add.disabled = true; $('#sg-msg').textContent = 'Adding ' + items.length + '…';
      try { const r = await api('acceptSuggestions', { items }); await loadWork(); loadNotes(); toast(r.added.length + ' project' + (r.added.length === 1 ? '' : 's') + ' added'); renderProjects(); }
      catch (ex) { add.disabled = false; $('#sg-msg').textContent = ex.message; }
    });
  }
  function renderProjectNew(params) {
    if (!can('project.create')) { view().innerHTML = '<div class="empty">Your role cannot open projects.</div>'; return; }
    const mail = params.get('mail') && (W().mail || []).find((m) => m.mail_id === params.get('mail'));
    const types = (state.data && state.data.projectTypes) || [];
    view().innerHTML = '<a class="back" href="#/projects">‹ Projects</a><h1>New project</h1>' +
      (mail ? '<div class="stamp"><span>From email: <strong>' + esc(mail.subject) + '</strong></span><span class="muted">' + esc(mail.from) + '</span></div>' : '') +
      '<form class="stack" id="pjf" novalidate><div class="row2"><label class="field"><span>Type</span><select id="pj-type">' +
        types.map((t) => '<option value="' + esc(t.type_id) + '"' + (t.type_id === (mail && /repair|replace/i.test(mail.subject) ? 'REP' : 'INS') ? ' selected' : '') + '>' + esc(t.name) + '</option>').join('') + '</select></label>' +
      '<label class="field"><span>Commercial / residential</span><select id="pj-seg">' + state.data.segments.map((s) => '<option value="' + esc(s.segment_id) + '">' + esc(s.name) + '</option>').join('') + '</select></label></div>' +
      '<label class="field"><span>Title</span><input id="pj-title" type="text" required placeholder="e.g. Savaria V1504 home lift – 27 Pomander Rd" value="' + esc(mail ? mail.subject.replace(/^(re|fwd?):\s*/i, '') : '') + '"></label>' +
      '<label class="field"><span>Address</span><select id="pj-site">' + siteOptions(mail && mail.site_id ? mail.site_id : '__other') + '</select></label>' +
      '<label class="field" id="pj-other-f"><span>Address (not in Sites yet)</span><input id="pj-other" type="text"></label>' +
      '<div class="row2"><label class="field"><span>Customer</span><input id="pj-cust" type="text"></label><label class="field"><span>Contact (phone / email)</span><input id="pj-contact" type="text" value="' + esc(mail ? mail.from : '') + '"></label></div>' +
      '<label class="field"><span>Value (optional)</span><input id="pj-value" type="text" inputmode="decimal" placeholder="$"></label>' +
      '<label class="field"><span>First note</span><textarea id="pj-note"></textarea></label>' +
      '<p class="muted">Opening a project also makes its Drive folder with the usual subfolders.</p>' +
      '<p class="muted" id="pj-err" role="alert"></p><div class="actions"><button class="btn primary" type="submit">Open project</button></div></form>';
    const sel = $('#pj-site'); const tog = () => { $('#pj-other-f').hidden = sel.value !== '__other'; if (sel.value && sel.value !== '__other') { const s = siteById(sel.value); if (s) $('#pj-seg').value = s.segment_id; } };
    sel.addEventListener('change', tog); tog();
    $('#pjf').addEventListener('submit', async (e) => {
      e.preventDefault(); const err = $('#pj-err'); err.textContent = '';
      const sid = sel.value === '__other' ? '' : sel.value;
      try {
        const r = await api('saveProject', { type_id: $('#pj-type').value, segment_id: $('#pj-seg').value, title: $('#pj-title').value, site_id: sid,
          site_name: sid ? siteById(sid).name : $('#pj-other').value, customer: $('#pj-cust').value, contact: $('#pj-contact').value, value: $('#pj-value').value,
          first_note: $('#pj-note').value, mail_id: mail ? mail.mail_id : '' });
        await loadWork(); toast(r.project.project_id + ' opened'); location.hash = '#/projects/' + encodeURIComponent(r.project.project_id);
      } catch (ex) { err.textContent = ex.message; }
    });
  }
  function renderProject(id) {
    const p = (W().projects || []).find((x) => x.project_id === id);
    if (!p) { view().innerHTML = '<div class="empty">Project not found. <a href="#/projects">Back to projects</a></div>'; return; }
    const steps = projectSteps(p);
    const names = steps.map((s) => s.stage);
    const ev = (W().projectEvents || []).filter((e) => e.project_id === id).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const info = {}; ev.forEach((e) => { if (e.stage && !info[e.stage]) info[e.stage] = dShort(e.at); });
    const orders = (W().orders || []).filter((o) => o.project_id === id);
    const mailById = {}; (W().mail || []).forEach((m) => { mailById[m.mail_id] = m; });
    const mails = (W().mail || []).filter((m) => m.linked_type === 'project' && m.linked_id === id);
    const at = names.indexOf(p.stage);
    const cur = steps[at];
    view().innerHTML = '<a class="back" href="#/projects">‹ Projects</a>' +
      '<div class="page-head"><h1>' + esc(p.title) + '</h1><span class="ticket">' + esc(p.project_id) + '</span></div>' +
      '<dl class="kv"><dt>Type</dt><dd>' + esc(typeName(p.type_id).name) + ' · ' + esc(p.segment_id) + '</dd><dt>Address</dt><dd>' + siteLink(p.site_id, p.site_name) + '</dd>' +
        (p.customer ? '<dt>Customer</dt><dd>' + esc(p.customer) + '</dd>' : '') + (p.contact ? '<dt>Contact</dt><dd>' + esc(p.contact) + '</dd>' : '') +
        (p.value ? '<dt>Value</dt><dd class="mono">' + moneyFmt(p.value) + '</dd>' : '') +
        '<dt>Opened</dt><dd>' + esc(dShort(p.created_at)) + te('Projects', p.project_id, 'created_at', p.created_at) + '</dd>' +
        (p.folder_url ? '<dt>Files</dt><dd><a href="' + esc(p.folder_url) + '" target="_blank" rel="noopener">Drive folder</a></dd>' : '') + '</dl>' +
      crmProjectHtml(p) +
      flowHtml(names, p.stage, info) +
      (cur && cur.notes ? '<p class="muted">Now: ' + esc(cur.notes) + '</p>' : '') +
      stepBoxHtml(p, cur) +
      (p.scope ? '<div class="scope-box"><h2>Work to do <small>confirmed by ' + esc(who(p.scope_by)) + ' ' + esc(dShort(p.scope_at)) + '</small></h2>' +
        '<p>' + esc(p.scope) + '</p>' + (p.materials ? '<h2>Materials</h2><p>' + esc(p.materials) + '</p>' : '') + '</div>' : '') +
      (can('project.edit') && p.status !== 'closed' ? '<h2>Next step</h2><form class="stack step-form" id="ps" novalidate><div class="row2">' +
        '<label class="field"><span>Step</span><select id="ps-stage">' + names.concat(['Lost / cancelled']).map((s, i) => '<option' + (i === Math.min(at + 1, names.length - 1) ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select></label>' +
        '<label class="field"><span>Note</span><input id="ps-note" type="text" placeholder="e.g. quote $38,500 sent, Chris approved"></label></div>' +
        '<p class="muted" id="ps-err" role="alert"></p><div class="actions"><button class="btn primary" type="submit">Save step</button><button class="btn ghost" type="button" id="ps-noteonly">Add note only</button>' +
        (can('order.edit') ? '<a class="btn ghost" href="#/orders/new?project=' + encodeURIComponent(id) + (p.site_id ? '&site=' + encodeURIComponent(p.site_id) : '') + '">Order materials</a>' : '') + '</div></form>' : '') +
      planHtml(p) +
      (orders.length ? '<h2>Orders · ' + orders.length + '</h2><div class="list">' + orders.map(orderCard).join('') + '</div>' : '') +
      '<h2>Timeline</h2><ol class="timeline">' + ev.slice().reverse().map((e) => { const m = e.mail_id && mailById[e.mail_id];
        return '<li><span class="muted">' + esc(fmtDate(e.at)) + '</span> ' + (e.stage ? '<b>' + esc(e.stage) + '</b> ' : '') + esc(e.note || '') + ' <span class="muted">· ' + esc(who(e.by)) + '</span>' + te('Project Events', e.event_id, 'at', e.at) +
          (m ? ' · <a href="' + esc(m.link) + '" target="_blank" rel="noopener">email</a>' : '') + '</li>'; }).join('') + '</ol>' +
      (mails.length ? '<h2>Emails · ' + mails.length + '</h2><div class="list">' + mails.map(mailRow).join('') + '</div>' : '');
    bindMailCards(view());
    bindCrmProject(p);
    bindPlan(p);
    bindStepBox(p, cur);
    const f = $('#ps');
    if (f) {
      const send = async (noteOnly) => {
        const err = $('#ps-err'); err.textContent = '';
        if (noteOnly && !$('#ps-note').value.trim()) { err.textContent = 'Write the note first.'; return; }
        try { await api('projectStep', noteOnly ? { project_id: id, note: $('#ps-note').value } : { project_id: id, stage: $('#ps-stage').value, note: $('#ps-note').value });
              await loadWork(); toast('Saved'); renderProject(id); }
        catch (ex) { err.textContent = ex.message; }
      };
      f.addEventListener('submit', (e) => { e.preventDefault(); send(false); });
      $('#ps-noteonly').addEventListener('click', () => send(true));
    }
  }

  // ───────── Mail (records from Kyle's mailbox) ─────────
  const MAIL_CATS = ['Quote', 'Order', 'Installation', 'Maintenance', 'Inspection', 'Invoice', 'Task'];
  function renderMail() {
    const w = W();
    if (!w.mail) { view().innerHTML = '<div class="empty">' + (state.work ? 'Your role cannot see mail records.' : 'Connect once to download mail records.') + '</div>'; return; }
    const cat = state.mailCat || '', q = (state.mailQ || '').toLowerCase(), st = state.mailSt || 'open';
    const list = w.mail.filter((m) => (!cat || String(m.categories).split(',').indexOf(cat) >= 0) &&
      (st === 'all' || (st === 'open' ? m.status !== 'ignored' : m.status === st)) &&
      (!q || [m.subject, m.from, m.to, m.excerpt, m.site_name, m.supplier].join(' ').toLowerCase().indexOf(q) >= 0));
    const boxes = (w.mailboxes || []).map((b) => esc(b.owner || b.mailbox) + ': ' + (b.active ? (b.last_ingest ? 'checked ' + esc(ago(b.last_ingest)) : 'waiting for the first run') : 'not connected yet')).join(' · ');
    view().innerHTML = '<div class="page-head"><h1>Mail</h1><span class="muted">' + boxes + '</span></div>' +
      '<p class="muted">Emails about quotes, orders, installs, maintenance and tasks, collected read-only from the mailbox. Open one to file it under an order or project.</p>' +
      '<div class="search-box"><input id="ml-q" type="search" placeholder="Subject, sender, address…" value="' + esc(state.mailQ || '') + '" aria-label="Search mail"></div>' +
      '<div class="chips-row">' + [''].concat(MAIL_CATS).map((c) => { const n = w.mail.filter((m) => m.status !== 'ignored' && (!c || String(m.categories).split(',').indexOf(c) >= 0)).length;
        return '<button type="button" class="fchip' + (c === cat ? ' on' : '') + '" data-cat="' + esc(c) + '">' + esc(c || 'All') + ' <small>' + n + '</small></button>'; }).join('') +
        '<select id="ml-st" aria-label="Status"><option value="open"' + (st === 'open' ? ' selected' : '') + '>Not ignored</option><option value="new"' + (st === 'new' ? ' selected' : '') + '>Not filed yet</option>' +
        '<option value="linked"' + (st === 'linked' ? ' selected' : '') + '>Filed</option><option value="ignored"' + (st === 'ignored' ? ' selected' : '') + '>Ignored</option><option value="all"' + (st === 'all' ? ' selected' : '') + '>All</option></select></div>' +
      (list.length ? '<div class="list">' + list.slice(0, 200).map(mailRow).join('') + '</div>' : '<div class="empty">' + (w.mail.length ? 'Nothing matches.' : 'No emails yet. They appear here once the collector runs in Kyle\'s account.') + '</div>');
    bindMailCards(view());
    view().querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => { state.mailCat = b.dataset.cat; renderMail(); }));
    $('#ml-st').addEventListener('change', (e) => { state.mailSt = e.target.value; renderMail(); });
    const qi = $('#ml-q'); qi.addEventListener('input', () => { state.mailQ = qi.value; const p = qi.selectionStart; renderMail(); const n = $('#ml-q'); n.focus(); n.setSelectionRange(p, p); });
  }

  /** Orders, projects and emails at one address, for the site page. */
  function siteWorkHtml(s) {
    const k = siteKey(s);
    const at = (x) => (x.site_id && x.site_id === s.site_id) || (k && x.addr_key === k);
    const orders = (W().orders || []).filter(at), projects = (W().projects || []).filter(at), mails = (W().mail || []).filter((m) => at(m) && m.status !== 'ignored');
    return (projects.length ? '<h2>Projects · ' + projects.length + '</h2><div class="list">' + projects.map((p) => '<a class="card" href="#/projects/' + encodeURIComponent(p.project_id) + '"><div class="card-top"><span class="ticket">' +
        esc(p.project_id) + '</span><span class="chip">' + esc(p.stage) + '</span></div><div class="card-title">' + esc(p.title) + '</div></a>').join('') + '</div>' : '') +
      (orders.length ? '<h2>Orders · ' + orders.length + '</h2><div class="list">' + orders.map(orderCard).join('') + '</div>' : '') +
      (mails.length ? '<h2>Emails · ' + mails.length + '</h2><div class="list">' + mails.slice(0, 30).map(mailRow).join('') + '</div>' : '') +
      (can('order.edit') ? '<div class="actions" style="margin-top:12px"><a class="btn ghost" href="#/orders/new?site=' + encodeURIComponent(s.site_id) + '">New order for this address</a></div>' : '');
  }

  // ═════════ Invoices: what was sent, what was not ═════════
  const isAdmin = () => !!(state.me && state.me.user && state.me.user.isAdmin);
  /** Admin-only pencil next to a recorded time. */
  function te(table, id, field, value) {
    if (!isAdmin() || !id) return '';
    return '<button type="button" class="tedit" title="Change this time (admin)" aria-label="Change this time" data-te="' +
      esc([table, id, field, value || ''].join('|')) + '">✎</button>';
  }
  function localInput(v, dateOnly) {
    if (!v) return '';
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? v + 'T12:00:00' : v);
    if (isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    const day = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    return dateOnly ? day : day + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function openTimeEdit(spec) {
    const [table, id, field, value] = spec.split('|');
    const dateOnly = field === 'ready_date';
    openDrawer('Change time',
      '<p class="muted">' + esc(table) + ' · ' + esc(id) + ' · ' + esc(field) + '</p>' +
      '<p>Now: <strong>' + esc(value ? (dateOnly ? dShort(value) : fmtDate(value)) : '—') + '</strong></p>' +
      '<label class="field"><span>New ' + (dateOnly ? 'date' : 'date and time') + '</span><input id="te-v" type="' + (dateOnly ? 'date' : 'datetime-local') + '" value="' + esc(localInput(value, dateOnly)) + '"></label>' +
      '<p class="muted">Only you (admin) can do this. The old time is kept in the Audit Log.</p>' +
      '<p class="muted" id="te-err" role="alert"></p><div class="actions"><button class="btn primary" type="button" id="te-save">Save</button></div>');
    $('#te-save').addEventListener('click', async () => {
      const v = $('#te-v').value; const err = $('#te-err'); err.textContent = '';
      if (!v) { err.textContent = 'Pick a date.'; return; }
      try {
        await api('editTime', { table, id, field, value: dateOnly ? v : new Date(v).toISOString() });
        $('#drawer').hidden = true; toast('Time changed');
        await refreshData(); route();
      } catch (e) { err.textContent = e.message; }
    });
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.tedit'); if (!b) return;
    e.preventDefault(); e.stopPropagation(); openTimeEdit(b.dataset.te);
  }, true);

  async function loadInvoices() {
    try { state.invoices = await api('invoices', {}); LS.set('invoices', state.invoices); } catch (e) { if (!state.invoices) state.invoices = LS.get('invoices', null); }
  }
  const INV_KINDS = ['Maintenance', 'Service report', 'Project'];
  function renderInvoices() {
    const d = state.invoices;
    if (!d) { view().innerHTML = '<div class="empty">Connect once to download the invoice list.</div>'; return; }
    const st = state.invSt || 'not sent', kind = state.invKind || '', q = (state.invQ || '').toLowerCase();
    const hst = Number(d.hst || 13);
    const all = d.items;
    const list = all.filter((i) => (st === 'all' || i.status === st) && (!kind || i.kind === kind) &&
      (!q || [i.title, i.note, i.ref_id].join(' ').toLowerCase().indexOf(q) >= 0))
      .sort((a, b) => st === 'sent' ? String(b.done_at).localeCompare(String(a.done_at)) : String(a.created_at || '9').localeCompare(String(b.created_at || '9')));
    const sum = (l) => l.reduce((s, i) => s + (Number(i.amount) || 0), 0);
    const notSent = all.filter((i) => i.status === 'not sent'), sentMonth = all.filter((i) => i.status === 'sent' && String(i.done_at).slice(0, 7) === new Date().toISOString().slice(0, 7));
    const tile = (label, l, extra) => '<div class="tile"><span>' + label + '</span><b>' + l.length + '</b><small class="mono">' + (sum(l) ? moneyFmt(sum(l)) + ' + HST' : '&nbsp;') + '</small>' + (extra || '') + '</div>';
    view().innerHTML = '<div class="page-head"><h1>Invoices</h1></div>' +
      '<div class="tiles">' + tile('Not sent yet', notSent) + tile('Sent this month', sentMonth) + tile('Coming up (projects)', all.filter((i) => i.status === 'upcoming')) + '</div>' +
      '<div class="toolbar"><input id="iv-q" type="search" placeholder="Address, report, invoice #…" value="' + esc(state.invQ || '') + '" aria-label="Search invoices">' +
      '<div class="seg" role="group" aria-label="Status">' + [['not sent', 'Not sent'], ['sent', 'Sent'], ['upcoming', 'Coming up'], ['all', 'All']].map((x) =>
        '<button type="button" data-ist="' + x[0] + '" class="' + (st === x[0] ? 'on' : '') + '">' + x[1] + ' <small>' + (x[0] === 'all' ? all.length : all.filter((i) => i.status === x[0]).length) + '</small></button>').join('') + '</div></div>' +
      '<div class="chips-row">' + [''].concat(INV_KINDS).map((k) => '<button type="button" class="fchip' + (k === kind ? ' on' : '') + '" data-ik="' + esc(k) + '">' + esc(k || 'All kinds') + '</button>').join('') + '</div>' +
      (list.length ? '<p class="muted mono">' + list.length + ' shown' + (sum(list) ? ' · ' + moneyFmt(sum(list)) + ' + HST ' + hst + '% = ' + moneyFmt(sum(list) * (1 + hst / 100)) : '') + '</p>' +
        '<ul class="checklist">' + list.map((i) => '<li class="check' + (i.status === 'sent' ? ' is-done' : '') + '">' +
          '<label>' + (i.status === 'upcoming' ? '<span class="upcoming-dot" aria-hidden="true">◷</span>' : '<input type="checkbox" data-inv="' + esc(i.task_id) + '"' + (i.status === 'sent' ? ' checked' : '') + '>') +
          '<span><b>' + esc(i.title) + '</b><small><span class="chip">' + esc(i.kind) + '</span> ' +
            (i.status === 'sent' ? 'Sent ' + esc(dShort(i.done_at)) + (i.done_by ? ' by ' + esc(who(i.done_by)) : '') + te('Tasks', i.task_id, 'done_at', i.done_at) + (i.note ? ' · ' + esc(i.note) : '')
              : i.status === 'upcoming' ? 'Billed when the project reaches "' + esc(i.due_step) + '"'
              : 'Waiting since ' + esc(dShort(i.created_at)) + ' (' + daysSince(i.created_at) + ' days)' + te('Tasks', i.task_id, 'created_at', i.created_at)) +
          '</small></span></label>' +
          '<span class="check-links">' + (i.link ? '<a href="' + esc(i.link) + '">Open</a>' : '') + (i.kind === 'Service report' && i.ref_id ? '<a href="#/reports/' + encodeURIComponent(i.ref_id) + '">' + esc(i.ref_id) + '</a>' : '') + '</span></li>').join('') + '</ul>'
        : '<div class="empty">' + (st === 'not sent' ? 'Everything has been sent.' : 'Nothing here.') + '</div>');
    view().querySelectorAll('[data-ist]').forEach((b) => b.addEventListener('click', () => { state.invSt = b.dataset.ist; renderInvoices(); }));
    view().querySelectorAll('[data-ik]').forEach((b) => b.addEventListener('click', () => { state.invKind = b.dataset.ik; renderInvoices(); }));
    const qi = $('#iv-q'); qi.addEventListener('input', () => { state.invQ = qi.value; const p = qi.selectionStart; renderInvoices(); const n = $('#iv-q'); n.focus(); n.setSelectionRange(p, p); });
    view().querySelectorAll('[data-inv]').forEach((cb) => cb.addEventListener('change', () => {
      const it = d.items.find((x) => x.task_id === cb.dataset.inv);
      if (cb.checked) {
        cb.checked = false;
        openDrawer('Mark invoice as sent', '<p><strong>' + esc(it.title) + '</strong></p>' +
          '<label class="field"><span>Invoice # (optional)</span><input id="iv-no" type="text" placeholder="e.g. INV-2041"></label>' +
          '<p class="muted" id="iv-err" role="alert"></p><div class="actions"><button class="btn primary" type="button" id="iv-save">Mark as sent</button></div>');
        $('#iv-save').addEventListener('click', async () => {
          try {
            await api('setTask', { task_id: it.task_id, note: $('#iv-no').value });
            Object.assign(it, { status: 'sent', done_at: new Date().toISOString(), done_by: state.me.user.email, note: $('#iv-no').value });
            LS.set('invoices', d); $('#drawer').hidden = true; toast('Marked as sent'); renderInvoices(); loadNotes();
          } catch (e) { $('#iv-err').textContent = e.message; }
        });
      } else {
        cb.disabled = true;
        api('setTask', { task_id: it.task_id, done: false }).then(() => {
          Object.assign(it, { status: 'not sent', done_at: '', done_by: '', note: '' }); LS.set('invoices', d); toast('Back to not sent'); renderInvoices();
        }).catch((e) => { cb.checked = true; cb.disabled = false; toast(e.message); });
      }
    }));
  }

  /** Payment plan (how the project is invoiced: 50/50, 45/45/10 …) on the project page. */
  function planHtml(p) {
    const steps = projectSteps(p).map((s) => s.stage);
    const parts = String(p.payment_plan || '').split(';').filter(Boolean).map((x) => { const m = /^([\d.]+)@(.+)$/.exec(x); return m ? { pct: Number(m[1]), stage: m[2] } : null; }).filter(Boolean);
    const inv = ((state.invoices && state.invoices.items) || []).filter((i) => i.ref_id === p.project_id && i.kind === 'Project');
    const presets = String((state.invoices && state.invoices.plans) || '50/50=50,50|45/45/10=45,45,10').split('|').map((x) => x.split('='));
    const at = steps.indexOf(p.stage);
    const row = (x, i) => {
      const t = inv.find((v) => new RegExp('^Invoice ' + (i + 1) + ' of ').test(v.title));
      const amt = Number(p.value) ? Number(p.value) * x.pct / 100 : 0;
      const s = t ? t.status : (steps.indexOf(x.stage) <= at ? 'not sent' : 'upcoming');
      return '<li class="check' + (s === 'sent' ? ' is-done' : '') + '"><span><b>' + (i + 1) + '. ' + x.pct + '%' + (amt ? ' · ' + moneyFmt(amt) : '') + '</b>' +
        '<small>when "' + esc(x.stage) + '" · ' + (s === 'sent' ? '✓ sent ' + esc(dShort(t.done_at)) + (t.note ? ' · ' + esc(t.note) : '') : s === 'not sent' ? '<strong class="warn-text">not sent yet</strong>' : 'coming up') + '</small></span></li>';
    };
    return '<h2>Invoicing</h2>' + (parts.length ? '<ul class="checklist plan">' + parts.map(row).join('') + '</ul>' : '<p class="muted">No invoice split set yet.</p>') +
      (can('project.edit') && p.status !== 'closed' ? '<details class="add-site"><summary class="btn">' + (parts.length ? 'Change split' : 'Set invoice split') + '</summary>' +
        '<form class="stack" id="plf" novalidate><label class="field"><span>Project value (before HST)</span><input id="pl-value" type="text" inputmode="decimal" value="' + esc(p.value || '') + '"></label>' +
        '<label class="field"><span>Split</span><select id="pl-preset">' + presets.map((x) => '<option value="' + esc(x[1]) + '">' + esc(x[0]) + '</option>').join('') + '<option value="">Custom</option></select></label>' +
        '<div id="pl-parts"></div><div class="actions"><button class="btn ghost" type="button" id="pl-more">+ Part</button></div>' +
        '<p class="muted" id="pl-err" role="alert"></p><div class="actions"><button class="btn primary" type="submit">Save split</button></div></form></details>' : '');
  }
  /** The current step's checkbox (or Chris's scope form) on the project page. */
  const hasRole = (roles) => isAdmin() || String(roles || '').split(',').some((r) => ((state.me && state.me.user.roles) || []).indexOf(r.trim()) >= 0);
  function stepBoxHtml(p, cur) {
    if (!cur || p.status === 'closed' || !String(cur.assign_roles || '').trim()) return '';
    const mine = hasRole(cur.assign_roles);
    const whoFor = String(cur.assign_roles).split(',').map((r) => ({ manager: 'Chris', office: 'Kyle', technician: 'the technician', admin: 'Kaixin', sales: 'Sales' })[r.trim()] || r).join(' / ');
    const choices = String(cur.next || '').split('|').map((x) => x.trim()).filter(Boolean).map((x) => { const m = x.split(/\s*(?:→|->)\s*/); return { label: m[0], stage: (m[1] || m[0]).trim() }; });
    if (choices.length && String(cur.form) !== 'scope') {
      if (!mine) return '<div class="step-box waiting">Now with ' + esc(whoFor) + ': ' + esc(cur.reminder || cur.stage) + '</div>';
      return '<div class="step-box"><h2>' + esc(/\?\s*$/.test(cur.reminder || '') ? cur.reminder : cur.stage + ': what happened?') + '</h2><div class="actions choice-row">' +
        choices.map((c) => '<button type="button" class="btn' + (/lost|not passed/i.test(c.label) ? ' ghost' : ' primary') + '" data-choice="' + esc(c.stage) + '">' + esc(c.label) + '</button>').join('') + '</div>' +
        '<input type="text" id="step-note" placeholder="Note (optional)"></div>';
    }
    if (String(cur.form) === 'scope') {
      if (!mine) return '<div class="step-box waiting">Waiting for ' + esc(whoFor) + ' to confirm the work and materials before the quote is prepared.</div>';
      return '<form class="stack step-box" id="scf" novalidate><h2>' + esc(cur.reminder || cur.stage) + '</h2>' +
        '<label class="field"><span>What needs to be done</span><textarea id="sc-scope" required placeholder="e.g. Replace door operator board, adjust doors, test">' + esc(p.scope || '') + '</textarea></label>' +
        '<label class="field"><span>Materials needed</span><textarea id="sc-mat" placeholder="e.g. GAL MOVFR board x1, door gibs x8">' + esc(p.materials || '') + '</textarea></label>' +
        '<p class="muted" id="sc-err" role="alert"></p><div class="actions"><button class="btn primary" type="submit">Confirm and send to Kyle</button></div></form>';
    }
    if (!mine) return '<div class="step-box waiting">Now with ' + esc(whoFor) + ': ' + esc(cur.reminder || cur.stage) + '</div>';
    return '<div class="step-box"><label class="bigcheck"><input type="checkbox" id="step-done"><span><b>' + esc(cur.reminder || cur.stage) + '</b>' +
      '<small>Tick when done. The project moves to the next step.</small></span></label>' +
      '<input type="text" id="step-note" placeholder="Note (optional), e.g. quote # or what was done"></div>';
  }
  function bindStepBox(p, cur) {
    const sc = $('#scf');
    if (sc) sc.addEventListener('submit', async (e) => {
      e.preventDefault(); const err = $('#sc-err'); err.textContent = '';
      try { await api('confirmScope', { project_id: p.project_id, scope: $('#sc-scope').value, materials: $('#sc-mat').value });
            await loadWork(); loadNotes(); toast('Sent to Kyle'); renderProject(p.project_id); }
      catch (ex) { err.textContent = ex.message; }
    });
    view().querySelectorAll('[data-choice]').forEach((b) => b.addEventListener('click', async () => {
      view().querySelectorAll('[data-choice]').forEach((x) => { x.disabled = true; });
      try { await api('projectStep', { project_id: p.project_id, stage: b.dataset.choice, note: '✓ ' + p.stage + ': ' + b.textContent + ($('#step-note').value ? ' · ' + $('#step-note').value : '') });
            await loadWork(); loadNotes(); toast('Now: ' + b.dataset.choice); renderProject(p.project_id); }
      catch (ex) { view().querySelectorAll('[data-choice]').forEach((x) => { x.disabled = false; }); toast(ex.message); }
    }));
    const cb = $('#step-done');
    if (cb) cb.addEventListener('change', async () => {
      if (!cb.checked) return;
      cb.disabled = true;
      const names = projectSteps(p).map((s) => s.stage);
      const next = names[names.indexOf(p.stage) + 1];
      try { await api('projectStep', { project_id: p.project_id, stage: next, note: '✓ ' + p.stage + ($('#step-note').value ? ' · ' + $('#step-note').value : '') });
            await loadWork(); loadNotes(); toast('Done · now: ' + next); renderProject(p.project_id); }
      catch (ex) { cb.checked = false; cb.disabled = false; toast(ex.message); }
    });
  }
  function bindPlan(p) {
    const f = $('#plf'); if (!f) return;
    const steps = projectSteps(p).map((s) => s.stage);
    const pick = (re, fb) => steps.find((s) => re.test(s)) || fb;
    const won = pick(/confirmed|accepted|approved/i, steps[1]), built = pick(/^installation$|installed|repair done/i, steps[steps.length - 2]);
    const defaults = (n) => n === 2 ? [won, built] : [won, built, steps[steps.length - 1]];
    const partRow = (pct, stage) => '<div class="pline plan-line"><input type="text" class="pp-pct" inputmode="decimal" value="' + esc(pct) + '" aria-label="Percent"><span>% when</span>' +
      '<select class="pp-stage" aria-label="Step">' + steps.map((s) => '<option' + (s === stage ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select></div>';
    const fill = (pcts) => { const st = defaults(pcts.length); $('#pl-parts').innerHTML = pcts.map((x, i) => partRow(x, st[i] || steps[steps.length - 1])).join(''); };
    const cur = String(p.payment_plan || '').split(';').filter(Boolean);
    if (cur.length) $('#pl-parts').innerHTML = cur.map((x) => { const m = /^([\d.]+)@(.+)$/.exec(x); return partRow(m[1], m[2]); }).join('');
    else fill($('#pl-preset').value.split(','));
    if (cur.length) $('#pl-preset').value = '';
    $('#pl-preset').addEventListener('change', (e) => { if (e.target.value) fill(e.target.value.split(',')); });
    $('#pl-more').addEventListener('click', () => $('#pl-parts').insertAdjacentHTML('beforeend', partRow('', steps[steps.length - 1])));
    f.addEventListener('submit', async (e) => {
      e.preventDefault(); const err = $('#pl-err'); err.textContent = '';
      const plan = Array.from(f.querySelectorAll('.plan-line')).filter((l) => l.querySelector('.pp-pct').value.trim())
        .map((l) => l.querySelector('.pp-pct').value.trim() + '@' + l.querySelector('.pp-stage').value).join(';');
      try {
        await api('saveProject', Object.assign({}, p, { value: $('#pl-value').value, payment_plan: plan }));
        await loadWork(); toast('Invoice split saved'); renderProject(p.project_id);
      } catch (ex) { err.textContent = ex.message; }
    });
  }

  // ───────── router ─────────
  // ───────── CRM (laid out like HubSpot: contacts, companies, deals — no call / email tracking) ─────────
  const CRM = () => state.crm || { companies: [], contacts: [], notes: [], links: [], lifecycle: [], companyTypes: [], owners: [], canEdit: false };
  async function loadCrm() {
    if (!can('crm.view')) return;
    if (!state.crm) { try { state.crm = (await DB.getKv('crm')) || null; } catch (e) { state.crm = null; } }
    if (!online() || !tokenValid()) return;
    try { state.crm = await api('crm'); await DB.setKv('crm', state.crm); } catch (e) { /* keep the copy on this device */ }
  }
  const saveCrmLocal = () => { DB.setKv('crm', state.crm).catch(() => {}); };
  const ctName = (c) => (c ? [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || c.phone || c.mobile || c.contact_id : '');
  const initials = (s) => String(s || '').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  const coById = (id) => CRM().companies.find((c) => c.company_id === id);
  const ctById = (id) => CRM().contacts.find((c) => c.contact_id === id);
  const myEmail = () => String((state.me && state.me.user && state.me.user.email) || '').toLowerCase();
  const ownerName = (e) => { if (!e) return ''; const o = CRM().owners.find((x) => x.email === String(e).toLowerCase()); return o ? o.name : String(e).split('@')[0]; };
  const crmLinks = (type, id) => CRM().links.filter((l) => l.a_type === type && String(l.a_id) === String(id));
  const crmLinkedTo = (bType, bId) => CRM().links.filter((l) => l.b_type === bType && String(l.b_id) === String(bId));
  const lifeChip = (l) => l ? '<span class="life life-' + esc(String(l).toLowerCase().replace(/[^a-z]+/g, '-')) + '">' + esc(l) + '</span>' : '<span class="muted">—</span>';
  const avatar = (name, kind, big) => '<span class="av' + (kind === 'company' ? ' sq' : '') + (big ? ' lg' : '') + '" aria-hidden="true">' + esc(initials(name)) + '</span>';
  const crmCanEdit = () => !!CRM().canEdit && can('crm.edit');
  function crmUpsert(type, rec) {
    const list = type === 'contact' ? CRM().contacts : CRM().companies;
    const key = type === 'contact' ? 'contact_id' : 'company_id';
    const i = list.findIndex((x) => x[key] === rec[key]);
    if (String(rec.archived).toUpperCase() === 'TRUE' || rec.archived === true) { if (i >= 0) list.splice(i, 1); }
    else if (i >= 0) list[i] = rec; else list.push(rec);
    saveCrmLocal();
  }
  const dealsOf = (type, id) => {
    const ids = new Set(crmLinks(type, id).filter((l) => l.b_type === 'project').map((l) => l.b_id));
    return (W().projects || []).filter((p) => ids.has(p.project_id));
  };
  const sitesOf = (type, id) => {
    const ids = new Set(crmLinks(type, id).filter((l) => l.b_type === 'site').map((l) => l.b_id));
    return ((state.data && state.data.sites) || []).filter((s) => ids.has(s.site_id));
  };
  const dealCompany = (p) => {
    const l = crmLinkedTo('project', p.project_id).find((x) => x.a_type === 'company');
    return l ? coById(l.a_id) : null;
  };
  const dealContact = (p) => {
    const l = crmLinkedTo('project', p.project_id).find((x) => x.a_type === 'contact');
    return l ? ctById(l.a_id) : null;
  };
  const crmView = (obj) => {
    state.crmV = state.crmV || LS.get('crmV', {});
    return (state.crmV[obj] = Object.assign({ view: 'all', q: '', owner: '', life: '', type: '', sort: obj === 'deals' ? '' : 'created', dir: -1, page: 0 }, state.crmV[obj] || {}));
  };
  const saveCrmView = () => LS.set('crmV', Object.assign({}, state.crmV, Object.fromEntries(Object.entries(state.crmV || {}).map(([k, v]) => [k, Object.assign({}, v, { q: '', page: 0 })]))));

  function crmTop(active) {
    const objs = [['contacts', 'Contacts'], ['companies', 'Companies']].concat(can('project.view') ? [['deals', 'Deals']] : []);
    return '<nav class="crm-objs" aria-label="CRM">' + objs.map((o) => '<a href="#/crm/' + o[0] + '" class="' + (o[0] === active ? 'on' : '') + '">' + o[1] + '</a>').join('') + '</nav>';
  }

  async function renderCrm(parts) {
    if (!can('crm.view')) { view().innerHTML = '<div class="empty">Your role cannot see the CRM.</div>'; return; }
    if (!state.crm) {
      view().innerHTML = '<div class="empty">Loading the CRM…</div>';
      await loadCrm();
      if (!state.crm) { view().innerHTML = '<div class="empty">' + (online() ? 'The CRM could not be loaded. Is the backend updated to the newest version?' : 'Connect once to download the CRM.') + '</div>'; return; }
      if (!location.hash.startsWith('#/crm')) return;
    }
    const sub = parts[1] || 'contacts';
    if (sub === 'contact' && parts[2]) renderCrmRecord('contact', decodeURIComponent(parts[2]));
    else if (sub === 'company' && parts[2]) renderCrmRecord('company', decodeURIComponent(parts[2]));
    else if (sub === 'deals') renderCrmDeals();
    else renderCrmIndex(sub === 'companies' ? 'companies' : 'contacts');
  }

  // ── index (table) ──
  function crmRows(obj, v) {
    const me = myEmail();
    const q = v.q.trim().toLowerCase(), qd = q.replace(/\D/g, '');
    if (obj === 'contacts') {
      return CRM().contacts.filter((c) => {
        if (v.view === 'mine' && c.owner !== me) return false;
        if (v.view === 'unassigned' && c.owner) return false;
        if (v.owner && c.owner !== v.owner) return false;
        if (v.life && c.lifecycle !== v.life) return false;
        if (!q) return true;
        const co = coById(c.company_id);
        const hay = [ctName(c), c.email, c.job_title, co && co.name, c.address].join(' ').toLowerCase();
        return hay.indexOf(q) >= 0 || (qd.length >= 3 && [c.phone, c.mobile].join(' ').replace(/\D/g, '').indexOf(qd) >= 0);
      });
    }
    return CRM().companies.filter((c) => {
      if (v.view === 'mine' && c.owner !== me) return false;
      if (v.view === 'unassigned' && c.owner) return false;
      if (v.owner && c.owner !== v.owner) return false;
      if (v.life && c.lifecycle !== v.life) return false;
      if (v.type && c.type !== v.type) return false;
      if (!q) return true;
      return [c.name, c.domain, c.email, c.city, c.address, c.type].join(' ').toLowerCase().indexOf(q) >= 0 ||
        (qd.length >= 3 && String(c.phone).replace(/\D/g, '').indexOf(qd) >= 0);
    });
  }
  function crmCols(obj) {
    const openDeals = (type, id) => dealsOf(type, id).filter((p) => p.status !== 'closed').length;
    if (obj === 'contacts') return [
      { k: 'name', h: 'Name', v: (c) => ctName(c).toLowerCase(), td: (c) => '<a class="rec" href="#/crm/contact/' + encodeURIComponent(c.contact_id) + '">' + avatar(ctName(c)) + '<span>' + esc(ctName(c)) + (c.job_title ? '<small>' + esc(c.job_title) + '</small>' : '') + '</span></a>' },
      { k: 'email', h: 'Email', v: (c) => c.email || '', td: (c) => esc(c.email || '') },
      { k: 'phone', h: 'Phone number', v: (c) => c.phone || c.mobile || '', td: (c) => '<span class="nowrap">' + esc(c.phone || c.mobile || '') + '</span>' },
      { k: 'company', h: 'Company', v: (c) => ((coById(c.company_id) || {}).name || '').toLowerCase(), td: (c) => { const co = coById(c.company_id); return co ? '<a href="#/crm/company/' + encodeURIComponent(co.company_id) + '">' + esc(co.name) + '</a>' : ''; } },
      { k: 'lifecycle', h: 'Lifecycle stage', v: (c) => CRM().lifecycle.indexOf(c.lifecycle), td: (c) => lifeChip(c.lifecycle) },
      { k: 'owner', h: 'Contact owner', v: (c) => ownerName(c.owner), td: (c) => esc(ownerName(c.owner)) || '<span class="muted">No owner</span>' },
      { k: 'created', h: 'Create date', v: (c) => String(c.created_at || ''), td: (c) => '<span class="nowrap">' + esc(dShort(c.created_at)) + '</span>' },
    ];
    return [
      { k: 'name', h: 'Company name', v: (c) => String(c.name).toLowerCase(), td: (c) => '<a class="rec" href="#/crm/company/' + encodeURIComponent(c.company_id) + '">' + avatar(c.name, 'company') + '<span>' + esc(c.name) + (c.domain ? '<small>' + esc(c.domain) + '</small>' : '') + '</span></a>' },
      { k: 'type', h: 'Type', v: (c) => c.type || '', td: (c) => esc(c.type || '') },
      { k: 'phone', h: 'Phone number', v: (c) => c.phone || '', td: (c) => '<span class="nowrap">' + esc(c.phone || '') + '</span>' },
      { k: 'city', h: 'City', v: (c) => c.city || '', td: (c) => esc(c.city || '') },
      { k: 'lifecycle', h: 'Lifecycle stage', v: (c) => CRM().lifecycle.indexOf(c.lifecycle), td: (c) => lifeChip(c.lifecycle) },
      { k: 'contacts', h: 'Contacts', v: (c) => CRM().contacts.filter((x) => x.company_id === c.company_id).length, td: (c) => String(CRM().contacts.filter((x) => x.company_id === c.company_id).length || '') },
      { k: 'deals', h: 'Open deals', v: (c) => openDeals('company', c.company_id), td: (c) => String(openDeals('company', c.company_id) || '') },
      { k: 'owner', h: 'Company owner', v: (c) => ownerName(c.owner), td: (c) => esc(ownerName(c.owner)) || '<span class="muted">No owner</span>' },
      { k: 'created', h: 'Create date', v: (c) => String(c.created_at || ''), td: (c) => '<span class="nowrap">' + esc(dShort(c.created_at)) + '</span>' },
    ];
  }
  const PAGE = 25;
  function renderCrmIndex(obj) {
    const v = crmView(obj);
    const one = obj === 'contacts' ? 'contact' : 'company';
    const all = obj === 'contacts' ? CRM().contacts : CRM().companies;
    const cols = crmCols(obj);
    const rows = crmRows(obj, v);
    const col = cols.find((c) => c.k === v.sort) || cols.find((c) => c.k === 'created');
    rows.sort((a, b) => { const x = col.v(a), y = col.v(b); return (x < y ? -1 : x > y ? 1 : 0) * v.dir; });
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    if (v.page >= pages) v.page = pages - 1;
    const shown = rows.slice(v.page * PAGE, v.page * PAGE + PAGE);
    const sel = (id, label, cur, opts) => '<label class="flt"><span class="sr">' + esc(label) + '</span><select id="' + id + '"><option value="">' + esc(label) + '</option>' +
      opts.map((o) => '<option value="' + esc(o[0]) + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') + '</select></label>';
    const filtered = v.owner || v.life || v.type;
    view().innerHTML = crmTop(obj) +
      '<div class="crm-head"><div><h1>' + (obj === 'contacts' ? 'Contacts' : 'Companies') + '</h1><span class="muted">' + all.length.toLocaleString() + ' record' + (all.length === 1 ? '' : 's') + '</span></div>' +
        '<div class="actions">' + (crmCanEdit() ? '<button class="btn ghost" type="button" id="crm-import">Import from company sheets</button><button class="btn primary" type="button" id="crm-create">Create ' + one + '</button>' : '') + '</div></div>' +
      '<div class="crm-views" role="tablist">' + [['all', 'All ' + obj], ['mine', 'My ' + obj], ['unassigned', 'Unassigned ' + obj]].map((t) =>
        '<button type="button" role="tab" aria-selected="' + (v.view === t[0]) + '" data-view="' + t[0] + '" class="' + (v.view === t[0] ? 'on' : '') + '">' + esc(t[1]) + '</button>').join('') + '</div>' +
      '<div class="crm-tools"><input id="crm-q" type="search" placeholder="Search name, phone, email' + (obj === 'contacts' ? ', company' : '') + '" value="' + esc(v.q) + '" aria-label="Search">' +
        sel('f-owner', obj === 'contacts' ? 'Contact owner' : 'Company owner', v.owner, CRM().owners.map((o) => [o.email, o.name])) +
        sel('f-life', 'Lifecycle stage', v.life, CRM().lifecycle.map((l) => [l, l])) +
        (obj === 'companies' ? sel('f-type', 'Type', v.type, CRM().companyTypes.map((l) => [l, l])) : '') +
        (filtered ? '<button class="btn ghost" type="button" id="f-clear">Clear filters</button>' : '') + '</div>' +
      '<div class="crm-tbl-wrap"><table class="crm-tbl"><thead><tr>' + cols.map((c) => '<th scope="col"><button type="button" data-sort="' + c.k + '" aria-sort="' + (c.k === col.k ? (v.dir > 0 ? 'ascending' : 'descending') : 'none') + '">' + esc(c.h) +
          (c.k === col.k ? (v.dir > 0 ? ' ▲' : ' ▼') : '') + '</button></th>').join('') + '</tr></thead><tbody>' +
        (shown.length ? shown.map((r) => '<tr>' + cols.map((c) => '<td>' + c.td(r) + '</td>').join('') + '</tr>').join('')
          : '<tr><td colspan="' + cols.length + '" class="crm-none">' + (all.length ? 'No ' + obj + ' match these filters.' : 'No ' + obj + ' yet.' + (crmCanEdit() ? ' Use “Import from company sheets” to fill them from the Project Tracker and the maintenance record.' : '')) + '</td></tr>') +
      '</tbody></table></div>' +
      '<div class="crm-pager"><button class="btn ghost" type="button" id="pg-prev"' + (v.page ? '' : ' disabled') + '>‹ Prev</button><span class="muted">' +
        (rows.length ? (v.page * PAGE + 1) + '–' + Math.min(rows.length, (v.page + 1) * PAGE) + ' of ' + rows.length : '0') + '</span>' +
        '<button class="btn ghost" type="button" id="pg-next"' + (v.page < pages - 1 ? '' : ' disabled') + '>Next ›</button></div>';
    const again = () => { saveCrmView(); renderCrmIndex(obj); };
    view().querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { v.view = b.dataset.view; v.page = 0; again(); }));
    view().querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => { if (v.sort === b.dataset.sort) v.dir = -v.dir; else { v.sort = b.dataset.sort; v.dir = b.dataset.sort === 'created' ? -1 : 1; } again(); }));
    const qi = $('#crm-q');
    qi.addEventListener('input', () => { v.q = qi.value; v.page = 0; const pos = qi.selectionStart; renderCrmIndex(obj); const n = $('#crm-q'); n.focus(); n.setSelectionRange(pos, pos); });
    [['f-owner', 'owner'], ['f-life', 'life'], ['f-type', 'type']].forEach(([id, k]) => { const e = $('#' + id); if (e) e.addEventListener('change', () => { v[k] = e.value; v.page = 0; again(); }); });
    const fc = $('#f-clear'); if (fc) fc.addEventListener('click', () => { v.owner = v.life = v.type = ''; again(); });
    $('#pg-prev').addEventListener('click', () => { v.page--; again(); });
    $('#pg-next').addEventListener('click', () => { v.page++; again(); });
    const cr = $('#crm-create'); if (cr) cr.addEventListener('click', () => openCrmCreate(one));
    const im = $('#crm-import');
    if (im) im.addEventListener('click', async () => {
      if (!online()) { toast('Importing needs the internet.'); return; }
      im.disabled = true; im.textContent = 'Importing…';
      try { const r = await api('crmImport', {}); await loadCrm(); toast(r.contacts + ' contacts and ' + r.companies + ' companies added'); }
      catch (ex) { toast(ex.message); }
      if (location.hash.startsWith('#/crm')) renderCrmIndex(obj);
    });
  }

  // ── create panel (slides in from the right, like HubSpot) ──
  function crmFormFields(type, rec) {
    rec = rec || {};
    const opt = (list, cur, blank) => (blank !== undefined ? '<option value="">' + esc(blank) + '</option>' : '') + list.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('');
    const inp = (k, label, t, ph) => '<label class="field"><span>' + label + '</span><input data-f="' + k + '" type="' + (t || 'text') + '" value="' + esc(rec[k] || '') + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + '></label>';
    const owners = opt(CRM().owners.map((o) => [o.email, o.name]), rec.owner === undefined ? myEmail() : rec.owner, 'No owner');
    if (type === 'contact') {
      const co = coById(rec.company_id);
      return '<div class="row2">' + inp('first_name', 'First name') + inp('last_name', 'Last name') + '</div>' +
        inp('email', 'Email', 'email') + '<div class="row2">' + inp('phone', 'Phone number', 'tel') + inp('mobile', 'Mobile phone', 'tel') + '</div>' +
        inp('job_title', 'Job title', 'text', 'e.g. Property manager') +
        '<label class="field"><span>Company</span><input data-f="company_name" type="text" list="crm-co-list" value="' + esc(co ? co.name : '') + '" placeholder="Type to find a company, or a new name to add it">' +
          '<datalist id="crm-co-list">' + CRM().companies.map((c) => '<option value="' + esc(c.name) + '">').join('') + '</datalist></label>' +
        '<div class="row2"><label class="field"><span>Contact owner</span><select data-f="owner">' + owners + '</select></label>' +
          '<label class="field"><span>Lifecycle stage</span><select data-f="lifecycle">' + opt(CRM().lifecycle, rec.lifecycle || 'Lead') + '</select></label></div>';
    }
    return inp('name', 'Company name') + '<div class="row2"><label class="field"><span>Type</span><select data-f="type">' + opt(CRM().companyTypes, rec.type || '', '—') + '</select></label>' +
        inp('domain', 'Company domain', 'text', 'e.g. acmepm.ca') + '</div>' +
      '<div class="row2">' + inp('phone', 'Phone number', 'tel') + inp('email', 'Email', 'email') + '</div>' +
      '<div class="row2">' + inp('address', 'Street address') + inp('city', 'City') + '</div>' +
      '<div class="row2"><label class="field"><span>Company owner</span><select data-f="owner">' + owners + '</select></label>' +
        '<label class="field"><span>Lifecycle stage</span><select data-f="lifecycle">' + opt(CRM().lifecycle, rec.lifecycle || 'Lead') + '</select></label></div>';
  }
  /** Company typed in a contact form → its id; a new name creates the company first. */
  async function crmCompanyId(name) {
    name = String(name || '').trim();
    if (!name) return '';
    const hit = CRM().companies.find((c) => c.name.trim().toLowerCase() === name.toLowerCase());
    if (hit) return hit.company_id;
    const r = await api('crmSave', { object: 'company', record: { name: name, owner: myEmail() } });
    crmUpsert('company', r.record);
    return r.record.company_id;
  }
  function openCrmCreate(type, preset, link, after) {
    openDrawer('Create ' + type, '<form class="stack" id="crm-cf" novalidate>' + crmFormFields(type, preset) +
      '<p class="muted" id="crm-cerr" role="alert"></p>' +
      '<div class="actions"><button class="btn primary" type="submit">Create</button><button class="btn ghost" type="button" id="crm-cmore">Create and add another</button><button class="btn ghost" type="button" id="crm-ccancel">Cancel</button></div></form>');
    const f = $('#crm-cf');
    const first = f.querySelector('input'); if (first) first.focus();
    $('#crm-ccancel').addEventListener('click', () => { $('#drawer').hidden = true; $('#drawer').innerHTML = ''; });
    const go = async (more) => {
      const err = $('#crm-cerr'); err.textContent = '';
      if (!online()) { err.textContent = 'Creating a record needs the internet.'; return; }
      const rec = {}; f.querySelectorAll('[data-f]').forEach((e) => { rec[e.dataset.f] = e.value.trim(); });
      try {
        if (type === 'contact') { rec.company_id = await crmCompanyId(rec.company_name); delete rec.company_name; }
        const r = await api('crmSave', { object: type, record: rec, link: link || null });
        crmUpsert(type, r.record);
        if (link) state.crm.links.push({ a_type: type, a_id: r.record[type === 'contact' ? 'contact_id' : 'company_id'], b_type: link.type, b_id: link.id });
        toast(r.restored ? 'Brought back (it was removed earlier)' : (type === 'contact' ? 'Contact' : 'Company') + ' created');
        if (more) { f.reset(); f.querySelectorAll('input').forEach((i) => { i.value = ''; }); f.querySelector('input').focus(); return; }
        $('#drawer').hidden = true; $('#drawer').innerHTML = '';
        if (after) after(r.record); else location.hash = '#/crm/' + type + '/' + encodeURIComponent(r.record[type === 'contact' ? 'contact_id' : 'company_id']);
      } catch (ex) { err.textContent = ex.message; }
    };
    f.addEventListener('submit', (e) => { e.preventDefault(); go(false); });
    $('#crm-cmore').addEventListener('click', () => go(true));
  }

  /** A searchable list in the side panel; onPick(id) runs when one is chosen. */
  function crmPick(title, options, onPick, newLabel, onNew) {
    openDrawer(title, '<input id="pk-q" type="search" placeholder="Search" aria-label="Search">' + (newLabel ? '<button type="button" class="btn ghost" id="pk-new">' + esc(newLabel) + '</button>' : '') + '<div class="pk-list" id="pk-list"></div>');
    if (newLabel) $('#pk-new').addEventListener('click', () => { onNew(); });
    const draw = () => {
      const q = $('#pk-q').value.trim().toLowerCase();
      const hits = options.filter((o) => !q || (o.label + ' ' + (o.sub || '')).toLowerCase().indexOf(q) >= 0).slice(0, 60);
      $('#pk-list').innerHTML = hits.length ? hits.map((o) => '<button type="button" class="pk" data-id="' + esc(o.id) + '"><b>' + esc(o.label) + '</b>' + (o.sub ? '<small>' + esc(o.sub) + '</small>' : '') + '</button>').join('') : '<div class="empty">Nothing found.</div>';
      $('#pk-list').querySelectorAll('.pk').forEach((b) => b.addEventListener('click', async () => {
        b.disabled = true;
        try { await onPick(b.dataset.id); $('#drawer').hidden = true; $('#drawer').innerHTML = ''; } catch (ex) { b.disabled = false; toast(ex.message); }
      }));
    };
    $('#pk-q').addEventListener('input', draw); $('#pk-q').focus(); draw();
  }
  async function crmLinkNow(aT, aId, bT, bId, remove) {
    await api('crmLink', { a_type: aT, a_id: aId, b_type: bT, b_id: bId, remove: !!remove });
    const L = state.crm.links;
    for (let i = L.length - 1; i >= 0; i--) if (L[i].a_type === aT && String(L[i].a_id) === String(aId) && L[i].b_type === bT && String(L[i].b_id) === String(bId)) L.splice(i, 1);
    if (!remove) L.push({ a_type: aT, a_id: aId, b_type: bT, b_id: bId, by: myEmail(), at: new Date().toISOString() });
    saveCrmLocal();
  }
  async function crmSet(type, id, fields) {
    const r = await api('crmSave', { object: type, id: id, record: fields });
    crmUpsert(type, r.record);
    return r.record;
  }

  // ── record page: properties | activity | associations ──
  function crmTimeline(type, rec) {
    const id = rec[type === 'contact' ? 'contact_id' : 'company_id'];
    const items = CRM().notes.filter((n) => n.object_type === type && n.object_id === id)
      .map((n) => ({ at: n.at, kind: 'Note', who: n.by, html: '<p class="note-text">' + esc(n.text) + '</p>' }));
    const deals = dealsOf(type, id);
    const dealIds = new Set(deals.map((p) => p.project_id));
    (W().projectEvents || []).filter((e) => dealIds.has(e.project_id) && (e.stage || e.note)).forEach((e) => {
      const p = deals.find((x) => x.project_id === e.project_id);
      items.push({ at: e.at, kind: 'Deal', who: e.by, html: '<p><a href="#/projects/' + encodeURIComponent(e.project_id) + '">' + esc(p ? p.title : e.project_id) + '</a>' +
        (e.stage ? ' moved to <b>' + esc(e.stage) + '</b>' : '') + (e.note ? ' · ' + esc(e.note) : '') + '</p>' });
    });
    const linkedSites = sitesOf(type, id);
    const siteIds = new Set(linkedSites.map((s) => s.site_id)), siteKeys = new Set(linkedSites.map(siteKey).filter(Boolean));
    ((state.data && state.data.reports) || []).filter((r) => !r.pending && ((r.site_id && siteIds.has(r.site_id)) || (siteKeys.size && siteKeys.has(addrKey(r.site_name))))).forEach((r) => {
      items.push({ at: r.server_time, kind: 'Service report', who: r.tech_name, html: '<p><a href="#/reports/' + encodeURIComponent(r.report_id) + '">' + esc(r.report_id) + '</a> · ' + esc(r.site_name || '') +
        ' · ' + esc([r.call_type, r.work_done].filter(Boolean).join(' — ')) + '</p>' });
    });
    items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return items;
  }
  const whoName = (e) => { const n = ownerName(e); return n === 'import' ? 'Import' : n; };
  function timelineHtml(items) {
    if (!items.length) return '<div class="empty">No activity yet. Notes, deal steps and service reports at linked sites show here.</div>';
    let month = '';
    return '<ol class="crm-tl">' + items.map((it) => {
      const d = new Date(it.at); const m = isNaN(d) ? '' : d.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
      const head = m !== month ? (month = m, '<li class="tl-month">' + esc(m) + '</li>') : '';
      return head + '<li class="tl-item"><div class="tl-h"><b>' + esc(it.kind) + '</b><span class="muted">' + (it.who ? 'by ' + esc(whoName(it.who)) + ' · ' : '') + esc(fmtDate(it.at)) + '</span></div>' + it.html + '</li>';
    }).join('') + '</ol>';
  }
  function crmProps(type, rec) {
    const ed = crmCanEdit();
    const fields = type === 'contact'
      ? [['email', 'Email', 'email'], ['phone', 'Phone number', 'tel'], ['mobile', 'Mobile phone', 'tel'], ['job_title', 'Job title'], ['owner', 'Contact owner', 'owner'],
         ['lifecycle', 'Lifecycle stage', 'life'], ['address', 'Address'], ['notes', 'About', 'area']]
      : [['name', 'Company name'], ['type', 'Type', 'type'], ['domain', 'Company domain'], ['phone', 'Phone number', 'tel'], ['email', 'Email', 'email'],
         ['address', 'Street address'], ['city', 'City'], ['owner', 'Company owner', 'owner'], ['lifecycle', 'Lifecycle stage', 'life'], ['notes', 'About', 'area']];
    const opts = (list, cur, blank) => (blank !== undefined ? '<option value="">' + esc(blank) + '</option>' : '') + list.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('');
    return '<div class="props">' + fields.map(([k, label, kind]) => {
      const val = rec[k] || '';
      let ctl;
      if (!ed) ctl = '<div class="pv">' + (kind === 'owner' ? esc(ownerName(val)) : kind === 'life' ? lifeChip(val) : esc(val)) + (val ? '' : '<span class="muted">—</span>') + '</div>';
      else if (kind === 'owner') ctl = '<select data-p="' + k + '">' + opts(CRM().owners.map((o) => [o.email, o.name]), val, 'No owner') + '</select>';
      else if (kind === 'life') ctl = '<select data-p="' + k + '">' + opts(CRM().lifecycle, val, '—') + '</select>';
      else if (kind === 'type') ctl = '<select data-p="' + k + '">' + opts(CRM().companyTypes, val, '—') + '</select>';
      else if (kind === 'area') ctl = '<textarea data-p="' + k + '" rows="3" placeholder="—">' + esc(val) + '</textarea>';
      else ctl = '<input data-p="' + k + '" type="' + (kind || 'text') + '" value="' + esc(val) + '" placeholder="—">';
      return '<label class="prop"><span>' + esc(label) + '</span>' + ctl + '</label>';
    }).join('') + '</div>';
  }
  function assocCard(title, count, bodyHtml, addId, extra) {
    return '<details class="assoc" open><summary><b>' + esc(title) + '</b> <span class="muted">(' + count + ')</span>' +
      (addId && crmCanEdit() ? '<button type="button" class="link-btn" id="' + addId + '">+ Add</button>' : '') + (extra || '') + '</summary>' +
      '<div class="assoc-body">' + (bodyHtml || '<p class="muted">None yet.</p>') + '</div></details>';
  }
  const rmBtn = (kind, id) => crmCanEdit() ? '<button type="button" class="x" data-rm="' + kind + '" data-id="' + esc(id) + '" aria-label="Remove link">×</button>' : '';
  function dealMini(p) {
    return '<div class="mini"><a href="#/projects/' + encodeURIComponent(p.project_id) + '"><b>' + esc(p.title) + '</b></a>' +
      '<small>' + esc([p.stage, p.value ? moneyFmt(p.value) : ''].filter(Boolean).join(' · ')) + '</small>' + rmBtn('project', p.project_id) + '</div>';
  }
  function renderCrmRecord(type, id) {
    const rec = type === 'contact' ? ctById(id) : coById(id);
    const list = type === 'contact' ? 'contacts' : 'companies';
    if (!rec) { view().innerHTML = crmTop(list) + '<div class="empty">This ' + type + ' is not in the CRM (it may have been removed). <a href="#/crm/' + list + '">Back to ' + list + '</a></div>'; return; }
    const name = type === 'contact' ? ctName(rec) : rec.name;
    const co = type === 'contact' ? coById(rec.company_id) : null;
    const tab = state.crmTab || 'overview';
    const items = crmTimeline(type, rec);
    const deals = dealsOf(type, id), sites = sitesOf(type, id);
    const people = type === 'company' ? CRM().contacts.filter((c) => c.company_id === id) : [];
    const lastAct = items.find((i) => i.kind !== 'Created');
    const composer = crmCanEdit() ? '<form class="composer" id="crm-nf"><label class="sr" for="crm-note">Note</label><textarea id="crm-note" rows="3" placeholder="Write a note… (who you talked to, what they need, next steps)"></textarea>' +
      '<div class="actions"><button class="btn primary" type="submit">Save note</button><span class="muted" id="crm-nerr" role="alert"></span></div></form>' : '';
    const quick = [rec.email ? '<a class="qa" href="mailto:' + esc(rec.email) + '">Email</a>' : '', (rec.phone || rec.mobile) ? '<a class="qa" href="tel:' + esc(String(rec.phone || rec.mobile).replace(/[^\d+]/g, '')) + '">Call</a>' : '',
      crmCanEdit() ? '<button class="qa" type="button" id="qa-note">Note</button>' : ''].filter(Boolean).join('');
    view().innerHTML = crmTop(list) +
      '<div class="crm-rec">' +
      '<aside class="crm-left">' +
        '<a class="back" href="#/crm/' + list + '">‹ ' + (type === 'contact' ? 'Contacts' : 'Companies') + '</a>' +
        '<div class="crm-id">' + avatar(name, type, true) + '<div><h1>' + esc(name) + '</h1>' +
          (type === 'contact' ? '<div class="muted">' + esc([rec.job_title, co ? co.name : ''].filter(Boolean).join(' at ')) + '</div>' : (rec.domain ? '<div class="muted">' + esc(rec.domain) + '</div>' : '')) +
          (rec.email ? '<div><a href="mailto:' + esc(rec.email) + '">' + esc(rec.email) + '</a></div>' : '') +
          ((rec.phone || rec.mobile) ? '<div class="mono">' + esc(rec.phone || rec.mobile) + '</div>' : '') + '</div></div>' +
        (quick ? '<div class="qas">' + quick + '</div>' : '') +
        '<details class="crm-sec" open><summary>About this ' + type + '</summary>' + crmProps(type, rec) + '<p class="muted small" id="prop-msg" aria-live="polite"></p></details>' +
        '<p class="muted small">' + esc(rec[type === 'contact' ? 'contact_id' : 'company_id']) + (rec.source && rec.source !== 'OA' ? ' · added from ' + esc(rec.source) : '') + '</p>' +
        (crmCanEdit() ? '<details class="danger-zone"><summary>Remove this ' + type + '</summary><p class="muted">It leaves the CRM but stays in the sheet, and the import will not add it back. Creating it again brings it back.</p>' +
          '<div class="actions"><button class="btn danger" type="button" id="crm-arch">Remove ' + type + '</button></div></details>' : '') +
      '</aside>' +
      '<main class="crm-mid">' +
        '<div class="crm-tabs" role="tablist">' + [['overview', 'Overview'], ['activities', 'Activities']].map((t) =>
          '<button type="button" role="tab" aria-selected="' + (tab === t[0]) + '" data-tab="' + t[0] + '" class="' + (tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>').join('') + '</div>' +
        (tab === 'overview'
          ? '<section class="panel"><h2>Data highlights</h2><div class="hl"><div><small>Create date</small><b>' + esc(dShort(rec.created_at)) + '</b></div>' +
              '<div><small>Lifecycle stage</small><b>' + lifeChip(rec.lifecycle) + '</b></div>' +
              '<div><small>Last activity date</small><b>' + esc(lastAct ? dShort(lastAct.at) : '—') + '</b></div>' +
              '<div><small>Open deals</small><b>' + deals.filter((p) => p.status !== 'closed').length + '</b></div></div></section>' +
            '<section class="panel"><h2>Recent activities</h2>' + composer + timelineHtml(items.slice(0, 3)) +
              (items.length > 3 ? '<button class="link-btn" type="button" data-tab="activities">See all ' + items.length + ' activities ›</button>' : '') + '</section>' +
            (deals.length ? '<section class="panel"><h2>Deals</h2><table class="crm-tbl small"><thead><tr><th>Deal name</th><th>Stage</th><th>Amount</th></tr></thead><tbody>' +
              deals.map((p) => '<tr><td><a href="#/projects/' + encodeURIComponent(p.project_id) + '">' + esc(p.title) + '</a></td><td>' + esc(p.stage) + '</td><td class="mono">' + esc(moneyFmt(p.value)) + '</td></tr>').join('') + '</tbody></table></section>' : '')
          : '<section class="panel">' + composer + timelineHtml(items) + '</section>') +
      '</main>' +
      '<aside class="crm-right">' +
        (type === 'contact'
          ? assocCard('Company', co ? 1 : 0, co ? '<div class="mini"><a href="#/crm/company/' + encodeURIComponent(co.company_id) + '"><b>' + esc(co.name) + '</b></a><small>' + esc([co.type, co.phone].filter(Boolean).join(' · ')) + '</small>' + rmBtn('company', co.company_id) + '</div>' : '', 'as-co')
          : assocCard('Contacts', people.length, people.map((c) => '<div class="mini"><a href="#/crm/contact/' + encodeURIComponent(c.contact_id) + '"><b>' + esc(ctName(c)) + '</b></a><small>' + esc([c.job_title, c.email || c.phone].filter(Boolean).join(' · ')) + '</small>' + rmBtn('contact', c.contact_id) + '</div>').join(''), 'as-ct')) +
        (can('project.view') ? assocCard('Deals', deals.length, deals.map(dealMini).join(''), 'as-deal') : '') +
        assocCard('Sites', sites.length, sites.map((s) => '<div class="mini"><a href="#/sites/' + encodeURIComponent(s.site_id) + '"><b>' + esc(s.name) + '</b></a><small>' + esc([s.frequency, s.city].filter(Boolean).join(' · ')) + '</small>' + rmBtn('site', s.site_id) + '</div>').join(''), 'as-site') +
      '</aside></div>';

    const again = () => renderCrmRecord(type, id);
    view().querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { state.crmTab = b.dataset.tab; again(); }));
    // properties save as soon as they change
    view().querySelectorAll('[data-p]').forEach((e) => e.addEventListener('change', async () => {
      const msg = $('#prop-msg'); msg.textContent = 'Saving…';
      try { const f = {}; f[e.dataset.p] = e.value; await crmSet(type, id, f); msg.textContent = 'Saved'; if (['first_name', 'last_name', 'name', 'lifecycle', 'email', 'phone', 'mobile', 'job_title'].indexOf(e.dataset.p) >= 0) setTimeout(again, 300); }
      catch (ex) { msg.textContent = ex.message; }
    }));
    const nf = $('#crm-nf');
    if (nf) nf.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const t = $('#crm-note').value.trim(); const err = $('#crm-nerr');
      if (!t) { err.textContent = 'Write the note first.'; return; }
      if (!online()) { err.textContent = 'Saving a note needs the internet.'; return; }
      try { const r = await api('crmNote', { object_type: type, object_id: id, text: t }); state.crm.notes.push(r.note); saveCrmLocal(); toast('Note saved'); again(); }
      catch (ex) { err.textContent = ex.message; }
    });
    const qn = $('#qa-note'); if (qn) qn.addEventListener('click', () => { const n = $('#crm-note'); if (n) { n.focus(); n.scrollIntoView({ block: 'center' }); } });
    const arch = $('#crm-arch');
    if (arch) arch.addEventListener('click', async () => {
      if (!arch.dataset.armed) { arch.dataset.armed = '1'; arch.textContent = 'Click again to remove'; return; }
      try { const r = await api('crmArchive', { object: type, id: id }); crmUpsert(type, r.record); toast('Removed'); location.hash = '#/crm/' + list; } catch (ex) { toast(ex.message); }
    });
    // associations
    const bind = (bid, fn) => { const b = $('#' + bid); if (b) b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); }); };
    bind('as-co', () => crmPick('Add a company', CRM().companies.map((c) => ({ id: c.company_id, label: c.name, sub: [c.type, c.city].filter(Boolean).join(' · ') })),
      async (cid) => { await crmSet('contact', id, { company_id: cid }); again(); },
      'Create a new company', () => openCrmCreate('company', {}, null, async (c) => { await crmSet('contact', id, { company_id: c.company_id }); again(); })));
    bind('as-ct', () => crmPick('Add a contact', CRM().contacts.filter((c) => c.company_id !== id).map((c) => ({ id: c.contact_id, label: ctName(c), sub: [c.email, c.phone, (coById(c.company_id) || {}).name].filter(Boolean).join(' · ') })),
      async (cid) => { await crmSet('contact', cid, { company_id: id }); again(); },
      'Create a new contact', () => openCrmCreate('contact', { company_id: id }, null, () => again())));
    bind('as-deal', () => crmPick('Add a deal', (W().projects || []).filter((p) => !deals.some((d) => d.project_id === p.project_id)).map((p) => ({ id: p.project_id, label: p.title, sub: [p.project_id, p.stage, p.site_name].filter(Boolean).join(' · ') })),
      async (pid) => { await crmLinkNow(type, id, 'project', pid); again(); }));
    bind('as-site', () => crmPick('Add a site', ((state.data && state.data.sites) || []).filter((s) => !sites.some((x) => x.site_id === s.site_id)).map((s) => ({ id: s.site_id, label: s.name, sub: [s.site_id, s.frequency, s.city].filter(Boolean).join(' · ') })),
      async (sid) => { await crmLinkNow(type, id, 'site', sid); again(); }));
    view().querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async (e) => {
      e.preventDefault();
      const kind = b.dataset.rm, oid = b.dataset.id;
      try {
        if (kind === 'company') await crmSet('contact', id, { company_id: '' });
        else if (kind === 'contact') await crmSet('contact', oid, { company_id: '' });
        else await crmLinkNow(type, id, kind, oid, true);
        again();
      } catch (ex) { toast(ex.message); }
    }));
  }

  // ── deals: projects shown as a pipeline board ──
  function renderCrmDeals() {
    const w = W();
    if (!w.projects) { view().innerHTML = crmTop('deals') + '<div class="empty">' + (state.work ? 'Your role cannot see projects.' : 'Connect once to download projects.') + '</div>'; return; }
    const v = crmView('deals');
    const types = [...new Set((w.projectStages || []).map((s) => s.type_id))].filter((t) => w.projects.some((p) => p.type_id === t) || t === 'INS' || t === 'REP');
    if (!v.type || types.indexOf(v.type) < 0) v.type = types[0] || 'INS';
    const names = [...new Set((w.projectStages || []).filter((s) => s.type_id === v.type).sort((a, b) => Number(a.order) - Number(b.order)).map((s) => s.stage))];
    const q = v.q.trim().toLowerCase();
    const deals = w.projects.filter((p) => p.type_id === v.type && (!v.owner || String(p.owner_email).toLowerCase() === v.owner)).filter((p) => {
      if (!q) return true;
      const co = dealCompany(p), ct = dealContact(p);
      return [p.title, p.project_id, p.site_name, p.customer, co && co.name, ct && ctName(ct)].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    const extra = [...new Set(deals.map((p) => p.stage).filter((s) => s && names.indexOf(s) < 0))];
    const cols = names.concat(extra);
    const mode = v.view === 'table' ? 'table' : 'board';
    const total = (list) => list.reduce((s, p) => s + (Number(p.value) || 0), 0);
    const card = (p) => {
      const co = dealCompany(p), ct = dealContact(p);
      const who = co ? co.name : ct ? ctName(ct) : p.customer;
      return '<a class="deal" href="#/projects/' + encodeURIComponent(p.project_id) + '"><b>' + esc(p.title) + '</b>' +
        (p.value ? '<span class="mono">' + esc(moneyFmt(p.value)) + '</span>' : '') +
        (who ? '<small>' + esc(who) + '</small>' : '') +
        '<small class="muted">' + esc(p.project_id) + (p.stage_at ? ' · ' + daysSince(p.stage_at) + 'd in step' : '') + (p.owner_email ? ' · ' + esc(ownerName(p.owner_email)) : '') + '</small></a>';
    };
    view().innerHTML = crmTop('deals') +
      '<div class="crm-head"><div><h1>Deals</h1><span class="muted">' + deals.length + ' record' + (deals.length === 1 ? '' : 's') + ' · ' + esc(moneyFmt(total(deals)) || '$0') + '</span></div>' +
        '<div class="actions">' + (can('project.create') ? '<a class="btn primary" href="#/projects/new">Create deal</a>' : '') + '</div></div>' +
      '<div class="crm-tools"><label class="flt"><span class="sr">Pipeline</span><select id="d-type">' + types.map((t) => '<option value="' + esc(t) + '"' + (t === v.type ? ' selected' : '') + '>' + esc(typeName(t).name) + ' pipeline</option>').join('') + '</select></label>' +
        '<input id="crm-q" type="search" placeholder="Search deals" value="' + esc(v.q) + '" aria-label="Search deals">' +
        '<label class="flt"><span class="sr">Deal owner</span><select id="d-owner"><option value="">Deal owner</option>' + CRM().owners.map((o) => '<option value="' + esc(o.email) + '"' + (o.email === v.owner ? ' selected' : '') + '>' + esc(o.name) + '</option>').join('') + '</select></label>' +
        '<div class="seg" role="group" aria-label="View"><button type="button" data-mode="board" class="' + (mode === 'board' ? 'on' : '') + '">Board</button><button type="button" data-mode="table" class="' + (mode === 'table' ? 'on' : '') + '">Table</button></div></div>' +
      (mode === 'board'
        ? '<div class="board">' + cols.map((st) => { const list = deals.filter((p) => p.stage === st);
            return '<section class="bcol"><header><b>' + esc(st) + '</b><span class="count-b">' + list.length + '</span></header><div class="bcards">' + list.map(card).join('') + '</div>' +
              '<footer>Total: <span class="mono">' + esc(moneyFmt(total(list)) || '$0') + '</span></footer></section>'; }).join('') + '</div>'
        : '<div class="crm-tbl-wrap"><table class="crm-tbl"><thead><tr><th>Deal name</th><th>Deal stage</th><th>Amount</th><th>Company</th><th>Contact</th><th>Deal owner</th><th>Create date</th></tr></thead><tbody>' +
            (deals.length ? deals.slice().sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at))).map((p) => { const co = dealCompany(p), ct = dealContact(p);
              return '<tr><td><a class="rec" href="#/projects/' + encodeURIComponent(p.project_id) + '"><span>' + esc(p.title) + '<small>' + esc(p.project_id) + '</small></span></a></td><td>' + esc(p.stage) + '</td><td class="mono">' + esc(moneyFmt(p.value)) + '</td>' +
                '<td>' + (co ? '<a href="#/crm/company/' + encodeURIComponent(co.company_id) + '">' + esc(co.name) + '</a>' : esc(p.customer || '')) + '</td>' +
                '<td>' + (ct ? '<a href="#/crm/contact/' + encodeURIComponent(ct.contact_id) + '">' + esc(ctName(ct)) + '</a>' : '') + '</td>' +
                '<td>' + esc(ownerName(p.owner_email)) + '</td><td class="nowrap">' + esc(dShort(p.created_at)) + '</td></tr>'; }).join('')
              : '<tr><td colspan="7" class="crm-none">No deals in this pipeline.</td></tr>') + '</tbody></table></div>') +
      '<p class="muted small">Deals are the OA projects. Open one to move it to the next step — the step owners and Chris’s scope rules still apply.</p>';
    const again = () => { saveCrmView(); renderCrmDeals(); };
    $('#d-type').addEventListener('change', (e) => { v.type = e.target.value; again(); });
    $('#d-owner').addEventListener('change', (e) => { v.owner = e.target.value; again(); });
    view().querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { v.view = b.dataset.mode; again(); }));
    const qi = $('#crm-q');
    qi.addEventListener('input', () => { v.q = qi.value; const pos = qi.selectionStart; renderCrmDeals(); const n = $('#crm-q'); n.focus(); n.setSelectionRange(pos, pos); });
  }

  // ── the CRM box on a project page ──
  function crmProjectHtml(p) {
    if (!can('crm.view') || !state.crm) return '';
    const ls = crmLinkedTo('project', p.project_id);
    const cos = ls.filter((l) => l.a_type === 'company').map((l) => coById(l.a_id)).filter(Boolean);
    const cts = ls.filter((l) => l.a_type === 'contact').map((l) => ctById(l.a_id)).filter(Boolean);
    const chips = cos.map((c) => '<a class="crm-chip" href="#/crm/company/' + encodeURIComponent(c.company_id) + '">' + avatar(c.name, 'company') + esc(c.name) + '</a>')
      .concat(cts.map((c) => '<a class="crm-chip" href="#/crm/contact/' + encodeURIComponent(c.contact_id) + '">' + avatar(ctName(c)) + esc(ctName(c)) + (c.phone || c.mobile ? ' <span class="muted mono">' + esc(c.phone || c.mobile) + '</span>' : '') + '</a>'));
    return '<div class="crm-proj"><span class="muted">CRM</span>' + (chips.join('') || '<span class="muted">No contact or company linked.</span>') +
      (crmCanEdit() ? '<button type="button" class="link-btn" id="pj-crm">+ Link contact or company</button>' : '') + '</div>';
  }
  function bindCrmProject(p) {
    const b = $('#pj-crm'); if (!b) return;
    b.addEventListener('click', () => crmPick('Link a contact or company',
      CRM().companies.map((c) => ({ id: 'company:' + c.company_id, label: c.name, sub: 'Company' + (c.city ? ' · ' + c.city : '') }))
        .concat(CRM().contacts.map((c) => ({ id: 'contact:' + c.contact_id, label: ctName(c), sub: 'Contact' + ((coById(c.company_id) || {}).name ? ' · ' + coById(c.company_id).name : '') + (c.phone ? ' · ' + c.phone : '') }))),
      async (val) => { const [t, i] = val.split(':'); await crmLinkNow(t, i, 'project', p.project_id); renderProject(p.project_id); }));
  }

  function route() {
    state.touched = false;
    const dr = $('#drawer'); if (!dr.hidden) { dr.hidden = true; dr.innerHTML = ''; }
    if (!state.me) { renderSignIn(); return; }
    const hash = location.hash || '#/search';
    const [path, query] = hash.slice(1).split('?');
    const parts = path.split('/').filter(Boolean);
    const tab = parts[0] || 'reports';
    document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === (tab === 'sites' ? 'search' : tab)));
    view().classList.toggle('wide', tab === 'tables' || tab === 'schedule' || tab === 'crm' || (tab === 'orders' && !parts[1]));
    if (tab === 'search') renderSearch();
    else if (tab === 'schedule') renderSchedule();
    else if (tab === 'tables') renderTables();
    else if (tab === 'reports' && parts[1]) renderDetail(decodeURIComponent(parts[1]));
    else if (tab === 'new') renderNew(new URLSearchParams(query || ''));
    else if (tab === 'outbox') renderOutbox();
    else if (tab === 'month') renderMonth(new URLSearchParams(query || ''));
    else if (tab === 'orders' && parts[1] === 'new') renderOrderNew(new URLSearchParams(query || ''));
    else if (tab === 'orders' && parts[1]) renderOrder(decodeURIComponent(parts[1]));
    else if (tab === 'orders') renderOrders();
    else if (tab === 'prices') renderPrices();
    else if (tab === 'invoices') renderInvoices();
    else if (tab === 'projects' && parts[1] === 'new') renderProjectNew(new URLSearchParams(query || ''));
    else if (tab === 'projects' && parts[1]) renderProject(decodeURIComponent(parts[1]));
    else if (tab === 'projects') renderProjects();
    else if (tab === 'mail') renderMail();
    else if (tab === 'crm') renderCrm(parts);
    else if (tab === 'sites' && parts[1]) renderSiteDetail(decodeURIComponent(parts[1]));
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
  $('#bell').addEventListener('click', () => openNotifications());
  // Fresh data arriving after start-up redraws the page only if the person has not started using it.
  ['input', 'click', 'submit'].forEach((t) => $('#view').addEventListener(t, () => { state.touched = true; }, true));
  $('#close-menu').addEventListener('click', () => { $('#user-menu').hidden = true; });
  $('#sign-out').addEventListener('click', signOut);
  setInterval(() => { renderSync(); if (state.outbox.length) syncOutbox(); }, 60000);
  // Pick up the 9:00 list without a reload (checks every 15 minutes while the page is open).
  setInterval(() => { if (state.me && online() && tokenValid()) loadNotes(); }, 15 * 60000);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  (async function start() {
    await loadOutbox();
    await loadIndexFromDevice();
    await loadWorkFromDevice();
    renderChrome(); route();
    if (state.me && online()) {
      if (tokenValid()) {
        const h = location.hash;
        try { await refreshData(); renderChrome(); if (location.hash === h && !state.touched) route(); } catch (e) { banner(e.message, true); }
        syncOutbox();
      }
      else setTimeout(renewSignIn, 800);
    }
  })();

  window.__oa = { state, DB, syncOutbox, onCredential };   // used by tests
})();
