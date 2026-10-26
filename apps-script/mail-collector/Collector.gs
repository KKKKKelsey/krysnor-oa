/**
 * Krysnor OA – mail collector (READ-ONLY)
 * ---------------------------------------
 * Runs inside the mailbox owner's own Google account (Kyle: pm@krysnorelevator.ca), with his permission.
 *
 * What it does every 30 minutes:
 *   1. asks the OA which emails matter (words like quote, estimate, repair, order, pickup, install, TSSA …)
 *   2. searches this mailbox for recent matching emails
 *   3. sends the OA a short record of each one: date, from, to, subject, the first part of the message,
 *      attachment names and a link back to the email
 *
 * What it can NOT do: the only Gmail permission it has is gmail.readonly. It cannot send, delete, move,
 * label or mark anything as read. Nothing in the mailbox changes. To stop it: run uninstall(), or delete this project.
 *
 * Setup (Kyle, once):
 *   1. script.google.com → New project → name it "Krysnor OA mail collector"
 *   2. Project Settings (gear) → tick "Show appsscript.json manifest file in editor"
 *   3. Paste appsscript.json and this file (Collector.gs) over the default ones
 *   4. Paste the key Kaixin gives you into MAIL_KEY below, save
 *   5. Select install in the toolbar → Run → allow the permissions Google shows
 */

const OA_URL = 'https://script.google.com/macros/s/AKfycbxL29V03kLn5WMkSO7eaJQHgBUUkCJjPHeXJvRCaTTnZgHlWKVli-zyRPl9Y-KqL3Fg/exec';
const MAILBOX = 'pm@krysnorelevator.ca';
const MAIL_KEY = 'PASTE_THE_KEY_FROM_KAIXIN_HERE';
const EXCERPT_CHARS = 1500;      // how much of each message the OA keeps
const MAX_PER_RUN = 150;

function install() {
  if (Session.getActiveUser().getEmail().toLowerCase() !== MAILBOX) {
    throw new Error('Run this while signed in as ' + MAILBOX + ' (you are ' + Session.getActiveUser().getEmail() + ').');
  }
  if (/PASTE/.test(MAIL_KEY)) throw new Error('Paste the key from Kaixin into MAIL_KEY first.');
  uninstall();
  ScriptApp.newTrigger('collect').timeBased().everyMinutes(30).create();
  const res = collect();
  Logger.log('Installed. Runs every 30 minutes. First run: ' + JSON.stringify(res));
}

function uninstall() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'collect') ScriptApp.deleteTrigger(t); });
  Logger.log('Stopped. Nothing more will be sent to the OA.');
}

function collect() {
  const cfg = post_({ action: 'mailConfig' });
  const query = cfg.query + ' newer_than:' + (cfg.lookbackDays || 3) + 'd';
  const props = PropertiesService.getScriptProperties();
  const sent = JSON.parse(props.getProperty('SENT_IDS') || '[]');
  const ids = [];
  let pageToken;
  do {
    const page = Gmail.Users.Messages.list('me', { q: query, maxResults: 100, pageToken: pageToken, includeSpamTrash: false });
    (page.messages || []).forEach(function (m) { if (sent.indexOf(m.id) < 0 && ids.length < MAX_PER_RUN) ids.push(m.id); });
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < MAX_PER_RUN);

  let added = 0;
  for (let i = 0; i < ids.length; i += 40) {
    const batch = ids.slice(i, i + 40).map(readMessage_);
    const res = post_({ action: 'ingestMail', messages: batch });
    added += res.added || 0;
    batch.forEach(function (m) { sent.push(m.id); });
  }
  props.setProperty('SENT_IDS', JSON.stringify(sent.slice(-1500)));
  return { looked_at: ids.length, saved_in_oa: added };
}

function readMessage_(id) {
  const m = Gmail.Users.Messages.get('me', id, { format: 'full' });
  const h = {};
  (m.payload.headers || []).forEach(function (x) { h[x.name.toLowerCase()] = x.value; });
  const parts = { text: '', html: '', files: [] };
  walk_(m.payload, parts);
  let body = parts.text || parts.html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  // Keep only the new part of a reply, not the quoted thread below it.
  body = body.split(/\n\s*On .{5,200}wrote:\s*\n|\n-{2,}\s*Original Message|\nFrom: .*\nSent: /i)[0];
  body = body.split('\n').filter(function (l) { return !/^\s*>/.test(l); }).join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return {
    id: m.id, threadId: m.threadId, date: new Date(Number(m.internalDate)).toISOString(),
    direction: (m.labelIds || []).indexOf('SENT') >= 0 ? 'out' : 'in',
    from: h.from || '', to: [h.to, h.cc].filter(String).join(', '), subject: h.subject || '',
    snippet: m.snippet || '', excerpt: body.slice(0, EXCERPT_CHARS), attachments: parts.files.slice(0, 10),
  };
}

function walk_(part, out) {
  if (!part) return;
  if (part.filename) out.files.push(part.filename);
  else if (part.body && part.body.data) {
    const text = Utilities.newBlob(Utilities.base64DecodeWebSafe(part.body.data)).getDataAsString('UTF-8');
    if (part.mimeType === 'text/plain' && !out.text) out.text = text;
    else if (part.mimeType === 'text/html' && !out.html) out.html = text;
  }
  (part.parts || []).forEach(function (p) { walk_(p, out); });
}

function post_(body) {
  body.mailbox = MAILBOX;
  body.key = MAIL_KEY;
  const res = UrlFetchApp.fetch(OA_URL, { method: 'post', contentType: 'text/plain;charset=utf-8',
                                          payload: JSON.stringify(body), muteHttpExceptions: true, followRedirects: true });
  const out = JSON.parse(res.getContentText());
  if (!out.ok) throw new Error('OA said: ' + out.error);
  return out.data;
}
