/**
 * Krysnor OA – backend, step 1 (foundation)
 * -----------------------------------------
 * Paste this whole file into Extensions → Apps Script of the "Krysnor OA Master" sheet,
 * then run setup() once. Safe to run again: it never overwrites data that already exists.
 *
 * Nothing about people, roles, project types or folders is hard-coded below except the
 * FIRST-RUN seed values. After setup(), the tabs in the sheet are the only source of truth:
 *   - new technician      → add a row in Users
 *   - new job title        → add a row in Roles + a column in Permissions
 *   - new project type     → add a row in Project Types + rows in Folder Templates, run setupFolders()
 *
 * Functions you run by hand (select in the toolbar, then ▶ Run):
 *   setup()            first-time build: tabs, Drive folders, weekly backup, sheet protection
 *   setupFolders()     re-create missing segment/type folders after editing the config tabs
 *   weeklyBackup()     run a backup now (it also runs by itself every week)
 *   checkSetup()       prints users, their roles and permissions to the log, to verify config
 *   syncSources()      reads the company sheets now (it also runs by itself every hour)
 */

// ───────────────────────────── First-run seed data ─────────────────────────────

const SEED = {
  'Settings': {
    headers: ['key', 'value', 'description'],
    widths: [210, 330, 420],
    rows: [
      ['OA_NAME', 'Krysnor OA', 'Name shown in the web page header'],
      ['TIMEZONE', 'America/Toronto', 'All timestamps use this time zone'],
      ['ADMIN_EMAIL', 'kxli9742@gmail.com', 'Owner. Always has every permission'],
      ['ROOT_FOLDER_ID', '1AdgKv8zSRLAOX6OmaxorYMHxr2qrABs3', 'Drive: Krysnor Elevator (shared VIEW-ONLY with staff)'],
      ['SYSTEM_FOLDER_ID', '12KdYlHfaKkD1KPkPcfkVrPtOQd_JK5ww', 'Drive: Krysnor OA System (private, never share)'],
      ['BACKUP_FOLDER_ID', '1UVGKzUEoQNbGaF0pDWUh8HhaZ6kcPTPY', 'Drive: Krysnor OA System / Backups / Weekly'],
      ['BACKUP_RETENTION_DAYS', '365', 'Backups older than this many days are moved to Drive trash'],
      ['BACKUP_WEEKDAY', 'MONDAY', 'Day of the weekly backup (MONDAY … SUNDAY)'],
      ['BACKUP_HOUR', '3', 'Hour of the weekly backup, 0-23, in TIMEZONE'],
      ['INBOX_FOLDER_ID', '1D_7SXY1ceONSGQNl3CKjM6eTC3GHqdAx', 'Drive: 00_Inbox (bids to screen)'],
      ['OAUTH_CLIENT_ID', '', 'Filled in step 3 (Google sign-in for the web page)'],
      ['REPORT_ID_PREFIX', 'SR', 'Service report numbers look like SR-2026-0001'],
      ['UNLINKED_REPORTS_FOLDER', '06_Service Reports (no project)', 'Folder inside ROOT for photos of reports not tied to a project'],
      ['MAX_UPLOAD_MB', '15', 'Largest single file the OA page may upload'],
    ],
  },
  'Roles': {
    headers: ['role_id', 'name', 'description', 'active'],
    widths: [120, 180, 460, 70],
    rows: [
      ['admin', 'Administrator', 'Owner of the system. Only role that changes configuration.', true],
      ['manager', 'Manager / Approver', 'Approves quotes and orders. (Chris)', true],
      ['technician', 'Technician', 'Writes service reports, uploads site photos. (Duke)', true],
      ['office', 'Office', 'Screens bids, quotes, orders, maintenance contracts. (Kyle)', true],
      ['viewer', 'Viewer', 'Read-only access to everything.', true],
    ],
  },
  'Permissions': {
    headers: ['permission', 'description', 'admin', 'manager', 'technician', 'office', 'viewer'],
    widths: [150, 340, 80, 80, 90, 80, 80],
    note: 'One column per role_id (header must match Roles.role_id exactly). To add a role, add a column. ' +
          'The ADMIN_EMAIL in Settings always has every permission regardless of this table.',
    rows: [
      ['view.all', 'See projects, calendar, reports and files', true, true, true, true, true],
      ['report.create', 'Write a new service report', true, true, true, false, false],
      ['report.amend_own', "Add a correction to one's own report", true, true, true, false, false],
      ['report.delete', 'Delete any report (kept in the sheet with who/when/why)', true, true, false, false, false],
      ['file.upload', 'Upload files/photos to a project folder', true, true, true, true, false],
      ['site.create', 'Add a customer site or elevator unit', true, true, false, true, false],
      ['project.create', 'Open a new project (creates its Drive folders)', true, true, false, true, false],
      ['quote.submit', 'Submit a quote for approval', true, false, false, true, false],
      ['quote.approve', 'Approve or send back a quote', true, true, false, false, false],
      ['order.submit', 'Submit a material order for approval', true, false, false, true, false],
      ['order.approve', 'Approve or send back a material order', true, true, false, false, false],
    ],
  },
  'Users': {
    headers: ['email', 'display_name', 'role_ids', 'active', 'calendar_color', 'phone', 'added_on', 'note'],
    widths: [240, 120, 170, 70, 110, 120, 100, 220],
    note: 'email = the Google account the person signs in with. role_ids = one or more Roles.role_id, comma-separated. ' +
          'To remove access set active = FALSE (never delete the row: old reports still point to it).',
    rows: [
      ['kxli9742@gmail.com', 'Kaixin', 'admin', true, '#7A5195', '', '2026-10-18', 'Owner'],
      ['', 'Chris', 'manager,technician', true, '#1F77B4', '', '2026-10-18', 'TODO: Google email'],
      ['', 'Duke', 'technician', true, '#2CA02C', '', '2026-10-18', 'TODO: Google email'],
      ['', 'Kyle', 'office', true, '#FF7F0E', '', '2026-10-18', 'TODO: Google email'],
    ],
  },
  'Segments': {
    headers: ['segment_id', 'name', 'folder_id', 'tssa_required'],
    widths: [100, 140, 330, 110],
    rows: [
      ['COM', 'Commercial', '1i7Te6jv6gphGfnQLQmMSACJqwL8qeCMS', true],
      ['RES', 'Residential', '1f8Hk19EHMGK9HowwT1GQw0vliNQouFA6', false],
    ],
  },
  'Project Types': {
    headers: ['type_id', 'name', 'id_prefix', 'folder_name', 'active'],
    widths: [90, 180, 90, 180, 70],
    note: 'folder_name = subfolder inside each segment folder. Project numbers look like INS-2026-001.',
    rows: [
      ['INS', 'New Installation', 'INS', 'New Installation', true],
      ['REP', 'Repair', 'REP', 'Repair', true],
      ['MNT', 'Maintenance', 'MNT', 'Maintenance', true],
    ],
  },
  'Folder Templates': {
    headers: ['type_id', 'order', 'subfolder', 'segments'],
    widths: [90, 70, 260, 100],
    note: 'segments: ALL, or one segment_id (e.g. COM) if the subfolder only applies there. ' +
          'Service-report photos go to the first subfolder whose name contains "Photos".',
    rows: [
      ['INS', 1, '01_Bid Documents', 'ALL'], ['INS', 2, '02_Spec Summary', 'ALL'],
      ['INS', 3, '03_Our Quote', 'ALL'], ['INS', 4, '04_Orders & Suppliers', 'ALL'],
      ['INS', 5, '05_Site Work & Photos', 'ALL'], ['INS', 6, '06_TSSA Reports & Issues', 'COM'],
      ['INS', 7, '07_Contracts & Maintenance', 'ALL'],
      ['REP', 1, '01_Service Reports', 'ALL'], ['REP', 2, '02_Photos', 'ALL'],
      ['REP', 3, '03_Quote & Invoice', 'ALL'], ['REP', 4, '04_Parts & Orders', 'ALL'], ['REP', 5, '05_TSSA', 'COM'],
      ['MNT', 1, '01_Contract', 'ALL'], ['MNT', 2, '02_Service Reports', 'ALL'],
      ['MNT', 3, '03_Photos', 'ALL'], ['MNT', 4, '04_TSSA Reports', 'COM'],
    ],
  },
  'Call Types': {
    headers: ['call_type', 'active'],
    widths: [220, 70],
    rows: [['Breakdown', true], ['Entrapment', true], ['Scheduled maintenance', true],
           ['Callback', true], ['Inspection / TSSA', true], ['Other', true]],
  },
  'Sites': {
    headers: ['site_id', 'name', 'segment_id', 'address', 'city', 'contact_name', 'contact_phone',
              'contact_email', 'notes', 'created_at', 'created_by'],
    widths: [90, 220, 90, 260, 110, 150, 130, 200, 220, 150, 200], rows: [],
  },
  'Units': {
    headers: ['unit_id', 'site_id', 'label', 'elevator_type', 'capacity_lbs', 'speed_fpm', 'stops', 'notes'],
    widths: [90, 90, 120, 130, 100, 90, 70, 220], rows: [],
  },
  'Projects': {
    headers: ['project_id', 'type_id', 'segment_id', 'site_id', 'title', 'status', 'owner_email',
              'folder_id', 'folder_url', 'created_at', 'created_by', 'notes'],
    widths: [130, 70, 90, 90, 240, 130, 200, 260, 300, 150, 200, 220], rows: [],
  },
  'Service Reports': {
    headers: ['report_id', 'server_time', 'device_time', 'tech_email', 'tech_name', 'project_id', 'site_id',
              'unit_id', 'call_type', 'arrived', 'left', 'problem_found', 'work_done', 'parts_used',
              'follow_up_needed', 'follow_up_note', 'photos_folder_url', 'amends_report_id', 'site_name', 'client_id'],
    widths: [130, 150, 150, 200, 110, 130, 90, 90, 150, 80, 80, 300, 300, 220, 110, 220, 300, 130, 200, 260],
    note: 'Append-only. server_time is written by the system when the report arrives and cannot be changed. ' +
          'device_time is when the technician pressed Save on the phone (earlier if written offline).',
    rows: [],
  },
  'Report Deletions': {
    headers: ['report_id', 'deleted_at', 'deleted_by', 'reason'],
    widths: [130, 150, 220, 460],
    note: 'A report listed here is hidden in the OA (with its corrections). The original row in Service Reports is kept. ' +
          'To restore a report, delete its row here.',
    rows: [],
  },
  'Data Sources': {
    headers: ['source_id', 'name', 'file_id', 'tabs', 'parser', 'roles', 'active', 'notes', 'last_sync', 'last_result'],
    widths: [110, 200, 300, 300, 80, 240, 70, 260, 150, 260],
    note: 'Company sheets the OA reads every hour (syncSources). tabs = pattern of tab names. parser = table or schedule. ' +
          'roles = role_ids that may see this source in search and calendar (admin always can). last_sync / last_result are written by the system.',
    rows: [
      ['SCHED', 'K.E Schedule – monthly calendar', '1GAMJ-48KE1d-LWktGPG8i_RXiywHOcDXWnWidrrI9hY',
       '^(January|February|March|April|May|June|July|August|September|October|November|December)$', 'schedule',
       'admin,manager,office,technician', true, 'Technicians see this one', '', ''],
      ['SCHED_TRACK', 'K.E Schedule – trackers', '1GAMJ-48KE1d-LWktGPG8i_RXiywHOcDXWnWidrrI9hY',
       '^(RepairsLeadTo Do list|New Installation-Modernization)$', 'table', 'admin,manager,office', true, '', '', ''],
      ['MAINT', 'Maintenance Record', '1RflhAV5qhghDGzI6HIUgyJE8TO1ba-6a',
       'Maintenance-(Commercial|Residential)', 'table', 'admin,manager,office', true, 'Excel file: needs the Drive API service', '', ''],
      ['INVOICES', 'Overdue invoices', '1RflhAV5qhghDGzI6HIUgyJE8TO1ba-6a', '^Overdue Invoices$', 'table',
       'admin,manager,office', true, '', '', ''],
      ['TRACKER', 'Project tracker', '1eRPFFA_s5HmVAoA6W9cOASB-GKGkGIHd',
       '^(Quote & Lead follow up|Repair & Service Call|Project follow up|Install Schedule)$', 'table',
       'admin,manager,office', true, 'Excel file: needs the Drive API service', '', ''],
    ],
  },
  'Audit Log': {
    headers: ['time', 'email', 'action', 'target', 'detail'],
    widths: [150, 220, 160, 180, 460], rows: [],
  },
  'Backup Log': {
    headers: ['time', 'backup_file', 'file_id', 'trashed_old', 'result'],
    widths: [150, 300, 300, 100, 360], rows: [],
  },
};

const README = [
  ['Krysnor OA – Master Sheet', ''],
  ['What this is', 'The single source of truth for the Krysnor internal OA. Staff never edit this sheet; they use the OA web page. Only the owner (Kaixin) edits here.'],
  ['这是什么', 'Krysnor 内部 OA 的唯一数据来源。员工不直接改这张表，只通过 OA 网页操作。只有 Kaixin 在这里修改。'],
  ['', ''],
  ['Config tabs (you edit)', 'Settings · Roles · Permissions · Users · Segments · Project Types · Folder Templates · Call Types'],
  ['Record tabs (system writes)', 'Sites · Units · Projects · Service Reports · Audit Log · Backup Log'],
  ['', ''],
  ['Add a technician', 'Users → add a row: email, name, role_ids = technician, active = TRUE. Nothing else to change.'],
  ['新增技师', 'Users 表加一行：邮箱、名字、role_ids 填 technician、active 填 TRUE。其他不用改。'],
  ['Add a job title', 'Roles → add a row (e.g. dispatcher). Permissions → add a column headed with that role_id and fill TRUE/FALSE.'],
  ['新增职位', 'Roles 表加一行（如 dispatcher），Permissions 表加一列，表头写同样的 role_id，逐项填 TRUE/FALSE。'],
  ['Several roles', 'Users.role_ids can hold several roles, comma-separated (e.g. manager,technician). Permissions are combined.'],
  ['一人多职', 'Users.role_ids 可以用逗号分隔多个角色（如 manager,technician），权限合并。'],
  ['Add a project type', 'Project Types → add a row (e.g. MOD Modernization). Folder Templates → add its subfolders. Run setupFolders() once.'],
  ['新增项目类型', 'Project Types 加一行（如 MOD 改造），Folder Templates 加它的子文件夹，然后运行一次 setupFolders()。'],
  ['Remove access', 'Users → active = FALSE. Do not delete the row.'],
  ['取消权限', 'Users 里 active 改成 FALSE，不要删行。'],
  ['Records are append-only', 'Service Reports and Audit Log are never edited. A correction is a new report whose amends_report_id = the original report_id.'],
  ['记录只增不改', '维修报告和审计日志不修改。更正 = 新增一条报告，amends_report_id 填原报告编号。'],
  ['Company sheets', 'Data Sources lists the team\'s own sheets. The OA reads them every hour; staff keep working in them as before. roles = who may see each one.'],
  ['公司表格', 'Data Sources 分页列出团队自己的表格。OA 每小时读取一次，大家照常在原表格工作。roles 决定谁能看到。'],
  ['Deleting a report', 'People with report.delete delete from the OA with a reason; it is listed in Report Deletions and hidden. Remove that row to restore it.'],
  ['删除报告', '有 report.delete 权限的人在 OA 里删除并写原因，记录在 Report Deletions 分页，OA 里不再显示。删掉那一行即可恢复。'],
  ['Backups', 'Every week (Settings: BACKUP_WEEKDAY / BACKUP_HOUR) a copy of this sheet goes to Backups/Weekly. Copies older than BACKUP_RETENTION_DAYS go to Drive trash (recoverable for 30 days).'],
  ['备份', '每周自动复制这张表到 Backups/Weekly。超过 BACKUP_RETENTION_DAYS 天的备份移到 Drive 回收站（30 天内可恢复）。'],
];

const BACKUP_NAME_PREFIX = 'Krysnor OA Master backup ';
const TEXT_COLUMNS = ['report_id', 'project_id', 'site_id', 'unit_id', 'arrived', 'left', 'contact_phone', 'phone',
                      'client_id', 'amends_report_id', 'folder_id', 'file_id'];

// ───────────────────────────── Setup ─────────────────────────────

function setup() {
  const ss = SpreadsheetApp.getActive();
  buildTabs_(ss);
  const s = getSettings_();
  ss.setSpreadsheetTimeZone(s.TIMEZONE || 'America/Toronto');
  const folders = setupFolders();
  installBackupTrigger_();
  installSyncTrigger_();
  protectAllTabs_(ss);
  audit_(Session.getEffectiveUser().getEmail(), 'setup', ss.getName(),
         'Tabs checked; folders ensured: ' + folders.length + '; weekly backup trigger installed');
  Logger.log('Krysnor OA setup finished. Next: fill in the Google emails for Chris, Duke and Kyle ' +
             'in the Users tab, then run checkSetup().');
}

function buildTabs_(ss) {
  // README first
  let readme = ss.getSheetByName('README');
  if (!readme) {
    readme = ss.insertSheet('README', 0);
    readme.getRange(1, 1, README.length, 2).setValues(README);
    readme.getRange('A1').setFontSize(14).setFontWeight('bold');
    readme.getRange(2, 1, README.length - 1, 1).setFontWeight('bold');
    readme.setColumnWidth(1, 230); readme.setColumnWidth(2, 900);
    readme.getRange(1, 2, README.length, 1).setWrap(true);
  }
  Object.keys(SEED).forEach(function (name) {
    const def = SEED[name];
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
      if (def.rows.length) sh.getRange(2, 1, def.rows.length, def.headers.length).setValues(def.rows);
    } else {
      // Upgrade: add any column introduced by a newer version of this script, at the end.
      const have = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
      def.headers.forEach(function (h) {
        if (have.indexOf(h) < 0) { sh.getRange(1, have.length + 1).setValue(h); have.push(h); }
      });
      if (name === 'Settings' || name === 'Permissions') {
        // Upgrade: add new keys / permissions without touching values Kaixin already changed.
        const keys = sh.getRange(1, 1, sh.getLastRow(), 1).getValues().map(function (r) { return String(r[0]).trim(); });
        def.rows.forEach(function (r) {
          if (keys.indexOf(r[0]) >= 0) return;
          // Match by column name, so extra role columns Kaixin added later stay aligned.
          sh.appendRow(have.map(function (h) { const i = def.headers.indexOf(h); return i >= 0 ? r[i] : ''; }));
        });
      }
    }
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, sh.getLastColumn())
      .setBackground('#1F3A5F').setFontColor('#FFFFFF').setFontWeight('bold');
    (def.widths || []).forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
    if (def.note) sh.getRange('A1').setNote(def.note);
    // Keep ids, times and phone numbers as plain text so Sheets does not turn "08:30" into a date.
    const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    hdr.forEach(function (h, i) {
      if (TEXT_COLUMNS.indexOf(String(h).trim()) >= 0) sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
    });
  });
  // Highlight the users whose email still needs filling in
  const users = ss.getSheetByName('Users');
  const emails = users.getRange(2, 1, Math.max(users.getLastRow() - 1, 1), 1).getValues();
  emails.forEach(function (r, i) { if (!r[0]) users.getRange(i + 2, 1).setBackground('#FFF2CC'); });
  // Remove the empty default tab Google adds to a new sheet ("Sheet1", "工作表1", …), whatever the language.
  const known = Object.keys(SEED).concat(['README']);
  ss.getSheets().forEach(function (sh) {
    if (known.indexOf(sh.getName()) < 0 && sh.getLastRow() === 0 && sh.getLastColumn() === 0 && ss.getSheets().length > 1) {
      ss.deleteSheet(sh);
    }
  });
}

/** Only the owner can edit any tab, even if the file is ever shared by mistake. */
function protectAllTabs_(ss) {
  ss.getSheets().forEach(function (sh) {
    const existing = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    const p = existing.length ? existing[0] : sh.protect();
    p.setDescription('Krysnor OA: owner-only. Staff use the OA web page.');
    p.removeEditors(p.getEditors());
    if (p.canDomainEdit()) p.setDomainEdit(false);
  });
}

// ───────────────────────────── Config readers ─────────────────────────────

function readTable_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
  const headers = values.shift().map(function (h) { return String(h).trim(); });
  return values
    .filter(function (r) { return r.some(function (c) { return c !== '' && c !== null; }); })
    .map(function (r) {
      const o = {};
      headers.forEach(function (h, i) { if (h) o[h] = r[i]; });
      return o;
    });
}

function getSettings_() {
  const out = {};
  readTable_('Settings').forEach(function (r) { if (r.key) out[String(r.key).trim()] = String(r.value).trim(); });
  return out;
}

function isTrue_(v) { return v === true || String(v).trim().toUpperCase() === 'TRUE'; }
function norm_(s) { return String(s || '').trim().toLowerCase(); }

/**
 * Pure function: which permissions does a set of role ids grant?
 * permRows = rows of the Permissions tab as objects; roleIds = ['manager','technician'].
 */
function permissionsFor_(permRows, roleIds) {
  const granted = {};
  permRows.forEach(function (row) {
    if (!row.permission) return;
    if (roleIds.some(function (r) { return Object.prototype.hasOwnProperty.call(row, r) && isTrue_(row[r]); })) {
      granted[String(row.permission).trim()] = true;
    }
  });
  return Object.keys(granted).sort();
}

/** Returns {email, name, roles, permissions, color} for an active user, or null. */
function getUser_(email) {
  const e = norm_(email);
  if (!e) return null;
  const s = getSettings_();
  const activeRoles = readTable_('Roles').filter(function (r) { return isTrue_(r.active); })
    .map(function (r) { return String(r.role_id).trim(); });
  const permRows = readTable_('Permissions');
  const row = readTable_('Users').filter(function (u) { return norm_(u.email) === e && isTrue_(u.active); })[0];
  const isAdmin = e === norm_(s.ADMIN_EMAIL);
  if (!row && !isAdmin) return null;
  const roles = row ? String(row.role_ids).split(',').map(function (r) { return r.trim(); })
    .filter(function (r) { return r && activeRoles.indexOf(r) >= 0; }) : ['admin'];
  const permissions = isAdmin
    ? permRows.map(function (p) { return String(p.permission).trim(); }).filter(String)
    : permissionsFor_(permRows, roles);
  return {
    email: e,
    name: row ? row.display_name : 'Admin',
    roles: roles,
    permissions: permissions,
    color: row ? row.calendar_color : '',
    isAdmin: isAdmin,
  };
}

function can_(user, permission) {
  return !!user && (user.isAdmin || user.permissions.indexOf(permission) >= 0);
}

// ───────────────────────────── Drive folders ─────────────────────────────

function ensureFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** Makes sure every active project type has its folder inside every segment folder. */
function setupFolders() {
  const segments = readTable_('Segments');
  const types = readTable_('Project Types').filter(function (t) { return isTrue_(t.active); });
  const made = [];
  segments.forEach(function (seg) {
    const segFolder = DriveApp.getFolderById(String(seg.folder_id).trim());
    types.forEach(function (t) {
      const f = ensureFolder_(segFolder, String(t.folder_name || t.name).trim());
      made.push(seg.name + ' / ' + f.getName());
    });
  });
  Logger.log('Folders ready:\n' + made.join('\n'));
  return made;
}

/**
 * Creates the folder for one project, with the subfolders from Folder Templates.
 * Used from step 2 onward (new project / service report). Returns the project folder.
 */
function createProjectFolder_(typeId, segmentId, projectId, title) {
  const seg = readTable_('Segments').filter(function (r) { return r.segment_id === segmentId; })[0];
  const type = readTable_('Project Types').filter(function (r) { return r.type_id === typeId; })[0];
  if (!seg || !type) throw new Error('Unknown segment or project type: ' + segmentId + ' / ' + typeId);
  const typeFolder = ensureFolder_(DriveApp.getFolderById(String(seg.folder_id).trim()),
                                   String(type.folder_name || type.name).trim());
  const folder = ensureFolder_(typeFolder, projectId + '_' + String(title).replace(/[\\/]/g, '-').trim());
  readTable_('Folder Templates')
    .filter(function (r) {
      const scope = String(r.segments || 'ALL').trim().toUpperCase();
      return r.type_id === typeId && (scope === 'ALL' || scope === segmentId);
    })
    .sort(function (a, b) { return Number(a.order) - Number(b.order); })
    .forEach(function (r) { ensureFolder_(folder, String(r.subfolder).trim()); });
  return folder;
}

/** True if the folder sits inside ROOT_FOLDER_ID (so staff can never browse the private system folder). */
function isInsideRoot_(folderId) {
  const root = getSettings_().ROOT_FOLDER_ID;
  let current = DriveApp.getFolderById(folderId);
  for (let depth = 0; depth < 20; depth++) {
    if (current.getId() === root) return true;
    const parents = current.getParents();
    if (!parents.hasNext()) return false;
    current = parents.next();
  }
  return false;
}

/** Lists a Drive folder for the OA page, including files Kaixin dropped in by hand. */
function listFolder_(folderId) {
  if (!isInsideRoot_(folderId)) throw new Error('Folder is outside the Krysnor Elevator folder.');
  const folder = DriveApp.getFolderById(folderId);
  const out = { id: folderId, name: folder.getName(), folders: [], files: [] };
  const fs = folder.getFolders();
  while (fs.hasNext()) { const f = fs.next(); out.folders.push({ id: f.getId(), name: f.getName() }); }
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    out.files.push({ id: f.getId(), name: f.getName(), mimeType: f.getMimeType(), url: f.getUrl(),
                     size: f.getSize(), updated: f.getLastUpdated().toISOString() });
  }
  out.folders.sort(function (a, b) { return a.name.localeCompare(b.name); });
  out.files.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return out;
}

// ───────────────────────────── Backups ─────────────────────────────

function installBackupTrigger_() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'weeklyBackup'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  const s = getSettings_();
  const day = ScriptApp.WeekDay[String(s.BACKUP_WEEKDAY || 'MONDAY').toUpperCase()] || ScriptApp.WeekDay.MONDAY;
  ScriptApp.newTrigger('weeklyBackup').timeBased()
    .onWeekDay(day).atHour(Number(s.BACKUP_HOUR || 3)).inTimezone(s.TIMEZONE || 'America/Toronto')
    .create();
}

function weeklyBackup() {
  const ss = SpreadsheetApp.getActive();
  const s = getSettings_();
  const log = ss.getSheetByName('Backup Log');
  const now = new Date();
  try {
    const folder = DriveApp.getFolderById(s.BACKUP_FOLDER_ID);
    const stamp = Utilities.formatDate(now, s.TIMEZONE || 'America/Toronto', 'yyyy-MM-dd');
    const copy = DriveApp.getFileById(ss.getId()).makeCopy(BACKUP_NAME_PREFIX + stamp, folder);

    const keepDays = Number(s.BACKUP_RETENTION_DAYS || 365);
    const cutoff = new Date(now.getTime() - keepDays * 24 * 3600 * 1000);
    let trashed = 0;
    const files = folder.getFiles();
    while (files.hasNext()) {
      const f = files.next();
      if (f.getName().indexOf(BACKUP_NAME_PREFIX) === 0 && f.getDateCreated() < cutoff) {
        f.setTrashed(true);
        trashed++;
      }
    }
    log.appendRow([now, copy.getName(), copy.getId(), trashed, 'OK']);
  } catch (err) {
    log.appendRow([now, '', '', 0, 'FAILED: ' + err.message]);
    MailApp.sendEmail(s.ADMIN_EMAIL, 'Krysnor OA backup FAILED', 'The weekly backup failed:\n\n' + err.stack);
    throw err;
  }
}

// ───────────────────────────── Audit log ─────────────────────────────

function audit_(email, action, target, detail) {
  SpreadsheetApp.getActive().getSheetByName('Audit Log')
    .appendRow([new Date(), email || '', action, target || '', detail || '']);
}

// ───────────────────────────── Web API (used from step 2/3) ─────────────────────────────
// The OA web page signs people in with Google and sends their ID token with every request.
// The token is checked here, so the page itself never has access to the sheet or to Drive.

function verifyIdToken_(idToken) {
  const clientId = getSettings_().OAUTH_CLIENT_ID;
  if (!clientId) throw new Error('OAUTH_CLIENT_ID is not set yet (step 3).');
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
                                { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Sign-in expired. Please sign in again.');
  const info = JSON.parse(res.getContentText());
  if (info.aud !== clientId) throw new Error('Sign-in token is not for this app.');
  if (String(info.email_verified) !== 'true') throw new Error('Google email is not verified.');
  if (Number(info.exp) * 1000 < Date.now()) throw new Error('Sign-in expired. Please sign in again.');
  return norm_(info.email);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return json_({ ok: true, name: getSettings_().OA_NAME || 'Krysnor OA' });
}

function doPost(e) {
  let email = '';
  try {
    const body = JSON.parse(e.postData.contents);
    email = verifyIdToken_(body.token);
    const user = getUser_(email);
    if (!user) throw new Error('This Google account has no access to Krysnor OA. Ask Kaixin to add you.');
    const handler = ACTIONS[body.action];
    if (!handler) throw new Error('Unknown action: ' + body.action);
    if (handler.permission && !can_(user, handler.permission)) {
      throw new Error('You do not have permission to do this (' + handler.permission + ').');
    }
    return json_({ ok: true, data: handler.run(user, body.payload || {}) });
  } catch (err) {
    return json_({ ok: false, error: err.message });
  }
}

// ───────────────────────────── Records (append-only) ─────────────────────────────

/** Appends one record, matching object keys to the header row. Returns the stored object. */
function appendRecord_(sheetName, obj) {
  const sh = SpreadsheetApp.getActive().getSheetByName(sheetName);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  sh.appendRow(headers.map(function (h) { return Object.prototype.hasOwnProperty.call(obj, h) ? obj[h] : ''; }));
  return obj;
}

/** Next id like SR-2026-0007. Call while holding the script lock. */
function nextId_(sheetName, column, prefix, digits) {
  const year = Utilities.formatDate(new Date(), getSettings_().TIMEZONE || 'America/Toronto', 'yyyy');
  const stem = prefix + '-' + year + '-';
  let max = 0;
  readTable_(sheetName).forEach(function (r) {
    const id = String(r[column] || '');
    if (id.indexOf(stem) === 0) max = Math.max(max, Number(id.slice(stem.length)) || 0);
  });
  return stem + ('000000' + (max + 1)).slice(-(digits || 4));
}

function clean_(v, maxLen) {
  return String(v === undefined || v === null ? '' : v).trim().slice(0, maxLen || 5000);
}

/** Decodes a base64 file from the page and saves it in a Drive folder. */
function saveUpload_(folder, f) {
  const maxMb = Number(getSettings_().MAX_UPLOAD_MB || 15);
  const bytes = Utilities.base64Decode(String(f.base64 || '').replace(/^data:[^,]*,/, ''));
  if (bytes.length > maxMb * 1024 * 1024) throw new Error(f.name + ' is larger than ' + maxMb + ' MB.');
  const name = clean_(f.name, 200).replace(/[\\/]/g, '-') || ('upload-' + Date.now());
  const file = folder.createFile(Utilities.newBlob(bytes, f.mimeType || 'application/octet-stream', name));
  return { id: file.getId(), name: file.getName(), url: file.getUrl() };
}

/** Where a report's photos go: <project>/<…Photos…>/<report id>, else ROOT/<unlinked folder>/<year>/<report id>. */
function reportPhotoFolder_(projectId, reportId) {
  const s = getSettings_();
  const project = projectId ? readTable_('Projects').filter(function (p) { return p.project_id === projectId; })[0] : null;
  if (project && project.folder_id) {
    const pf = DriveApp.getFolderById(String(project.folder_id));
    let target = null;
    const subs = pf.getFolders();
    while (subs.hasNext()) {
      const f = subs.next();
      if (/photos/i.test(f.getName()) && (!target || f.getName() < target.getName())) target = f;
    }
    return ensureFolder_(target || pf, reportId);
  }
  const year = Utilities.formatDate(new Date(), s.TIMEZONE || 'America/Toronto', 'yyyy');
  const base = ensureFolder_(DriveApp.getFolderById(s.ROOT_FOLDER_ID), s.UNLINKED_REPORTS_FOLDER || '06_Service Reports (no project)');
  return ensureFolder_(ensureFolder_(base, year), reportId);
}

function createReport_(user, p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const clientId = clean_(p.client_id, 100);
    if (clientId) {
      // The phone may retry after a dropped connection: never store the same report twice.
      const dup = readTable_('Service Reports').filter(function (r) { return r.client_id === clientId; })[0];
      if (dup) return { report: dup, duplicate: true };
    }
    const amends = clean_(p.amends_report_id, 40);
    if (amends) {
      const orig = readTable_('Service Reports').filter(function (r) { return r.report_id === amends; })[0];
      if (!orig) throw new Error('Report ' + amends + ' does not exist.');
      if (!user.isAdmin && (!can_(user, 'report.amend_own') || norm_(orig.tech_email) !== user.email)) {
        throw new Error('You can only add corrections to your own reports.');
      }
    }
    const callTypes = readTable_('Call Types').map(function (c) { return String(c.call_type); });
    if (callTypes.indexOf(clean_(p.call_type)) < 0) throw new Error('Pick a call type from the list.');
    const site = p.site_id ? readTable_('Sites').filter(function (x) { return x.site_id === p.site_id; })[0] : null;
    const siteName = site ? site.name : clean_(p.site_name, 200);
    if (!siteName) throw new Error('Pick a site, or type the site name.');
    if (!clean_(p.work_done)) throw new Error('Describe the work done.');

    const s = getSettings_();
    const id = nextId_('Service Reports', 'report_id', s.REPORT_ID_PREFIX || 'SR', 4);
    let photosUrl = '';
    const photos = Array.isArray(p.photos) ? p.photos : [];
    if (photos.length) {
      const folder = reportPhotoFolder_(clean_(p.project_id, 40), id);
      photos.forEach(function (f) { saveUpload_(folder, f); });
      photosUrl = folder.getUrl();
    }
    const record = {
      report_id: id,
      server_time: new Date(),
      device_time: p.device_time ? new Date(p.device_time) : '',
      tech_email: user.email,
      tech_name: user.name,
      project_id: clean_(p.project_id, 40),
      site_id: site ? site.site_id : '',
      site_name: siteName,
      unit_id: clean_(p.unit_id, 40),
      call_type: clean_(p.call_type, 60),
      arrived: clean_(p.arrived, 10),
      left: clean_(p.left, 10),
      problem_found: clean_(p.problem_found),
      work_done: clean_(p.work_done),
      parts_used: clean_(p.parts_used, 2000),
      follow_up_needed: p.follow_up_needed === true || p.follow_up_needed === 'true',
      follow_up_note: clean_(p.follow_up_note, 2000),
      photos_folder_url: photosUrl,
      amends_report_id: amends,
      client_id: clientId,
    };
    appendRecord_('Service Reports', record);
    audit_(user.email, amends ? 'report.amend' : 'report.create', id,
           siteName + ' · ' + record.call_type + (photos.length ? ' · ' + photos.length + ' photo(s)' : ''));
    return { report: record, duplicate: false };
  } finally {
    lock.releaseLock();
  }
}

function deletedReportIds_() {
  const out = {};
  readTable_('Report Deletions').forEach(function (d) { if (d.report_id) out[String(d.report_id)] = true; });
  return out;
}

function deleteReport_(user, p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const id = clean_(p.report_id, 40);
    const reason = clean_(p.reason, 1000);
    if (!reason) throw new Error('Please give a reason for deleting the report.');
    if (!readTable_('Service Reports').some(function (r) { return r.report_id === id; })) throw new Error('Report ' + id + ' does not exist.');
    if (deletedReportIds_()[id]) throw new Error('Report ' + id + ' is already deleted.');
    appendRecord_('Report Deletions', { report_id: id, deleted_at: new Date(), deleted_by: user.email, reason: reason });
    audit_(user.email, 'report.delete', id, reason);
    return { report_id: id };
  } finally {
    lock.releaseLock();
  }
}

/** Reports visible in the OA: deleted ones and corrections of deleted ones are left out. */
function visibleReports_() {
  const gone = deletedReportIds_();
  return readTable_('Service Reports').filter(function (r) {
    return !gone[r.report_id] && !(r.amends_report_id && gone[r.amends_report_id]);
  });
}

function createSite_(user, p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const name = clean_(p.name, 200);
    if (!name) throw new Error('Site name is required.');
    const segs = readTable_('Segments').map(function (x) { return x.segment_id; });
    if (segs.indexOf(p.segment_id) < 0) throw new Error('Pick Commercial or Residential.');
    const existing = readTable_('Sites').filter(function (x) { return norm_(x.name) === norm_(name); })[0];
    if (existing) throw new Error('A site called "' + name + '" already exists (' + existing.site_id + ').');
    let max = 0;
    readTable_('Sites').forEach(function (r) { max = Math.max(max, Number(String(r.site_id).replace(/\D/g, '')) || 0); });
    const record = {
      site_id: 'S' + ('0000' + (max + 1)).slice(-4),
      name: name, segment_id: p.segment_id,
      address: clean_(p.address, 300), city: clean_(p.city, 100),
      contact_name: clean_(p.contact_name, 100), contact_phone: clean_(p.contact_phone, 50),
      contact_email: clean_(p.contact_email, 200), notes: clean_(p.notes, 2000),
      created_at: new Date(), created_by: user.email,
    };
    appendRecord_('Sites', record);
    audit_(user.email, 'site.create', record.site_id, name);
    return { site: record };
  } finally {
    lock.releaseLock();
  }
}

/** Each action names the permission it needs. */
const ACTIONS = {
  me: {
    permission: null,
    run: function (user) {
      const s = getSettings_();
      return { user: user, oaName: s.OA_NAME, rootFolderId: s.ROOT_FOLDER_ID };
    },
  },
  bootstrap: {
    // Everything the page caches for offline viewing.
    permission: 'view.all',
    run: function () {
      return {
        users: readTable_('Users').filter(function (u) { return isTrue_(u.active) && u.email; })
          .map(function (u) { return { name: u.display_name, roles: u.role_ids, color: u.calendar_color }; }),
        projectTypes: readTable_('Project Types').filter(function (t) { return isTrue_(t.active); }),
        segments: readTable_('Segments').map(function (s) { return { segment_id: s.segment_id, name: s.name }; }),
        callTypes: readTable_('Call Types').filter(function (c) { return isTrue_(c.active); })
          .map(function (c) { return c.call_type; }),
        sites: readTable_('Sites'),
        units: readTable_('Units'),
        projects: readTable_('Projects'),
        reports: visibleReports_(),
        indexVersion: PropertiesService.getScriptProperties().getProperty('INDEX_VERSION') || '',
        syncedAt: new Date().toISOString(),
      };
    },
  },
  listFolder: {
    permission: 'view.all',
    run: function (user, p) { return listFolder_(p.folderId || getSettings_().ROOT_FOLDER_ID); },
  },
  createReport: {
    permission: 'report.create',
    run: function (user, p) { return createReport_(user, p); },
  },
  searchIndex: {
    // Rows from the company sheets, only from the sources this person's roles may see.
    permission: 'view.all',
    run: function (user) {
      const allowed = visibleSourceIds_(user);
      const idx = loadIndex_();
      return {
        version: idx.version,
        sources: readTable_('Data Sources').filter(function (x) { return allowed.indexOf(String(x.source_id)) >= 0; })
          .map(function (x) { return { id: x.source_id, name: x.name, lastSync: x.last_sync }; }),
        items: idx.items.filter(function (it) { return allowed.indexOf(it.src) >= 0; }),
      };
    },
  },
  deleteReport: {
    permission: 'report.delete',
    run: function (user, p) { return deleteReport_(user, p); },
  },
  createSite: {
    permission: 'site.create',
    run: function (user, p) { return createSite_(user, p); },
  },
  uploadFile: {
    // Files land in Drive; anything Kaixin drops into the same folders shows up in the OA too.
    permission: 'file.upload',
    run: function (user, p) {
      if (!p.folderId || !isInsideRoot_(p.folderId)) throw new Error('That folder is outside the Krysnor Elevator folder.');
      const saved = saveUpload_(DriveApp.getFolderById(p.folderId), p);
      audit_(user.email, 'file.upload', saved.id, saved.name);
      return saved;
    },
  },
};

// ───────────────────────────── Checks you can run by hand ─────────────────────────────

function checkSetup() {
  const s = getSettings_();
  const lines = ['Settings: ' + Object.keys(s).length + ' keys, admin = ' + s.ADMIN_EMAIL];
  readTable_('Users').forEach(function (u) {
    if (!u.email) { lines.push('⚠ ' + u.display_name + ': no email yet'); return; }
    const user = getUser_(u.email);
    lines.push(user
      ? '✓ ' + user.name + ' <' + user.email + '> roles=' + user.roles.join(',') + ' → ' + user.permissions.join(', ')
      : '✗ ' + u.display_name + ' <' + u.email + '> is inactive or has no valid role');
  });
  ['ROOT_FOLDER_ID', 'SYSTEM_FOLDER_ID', 'BACKUP_FOLDER_ID', 'INBOX_FOLDER_ID'].forEach(function (k) {
    try { lines.push('✓ ' + k + ' → ' + DriveApp.getFolderById(s[k]).getName()); }
    catch (err) { lines.push('✗ ' + k + ' cannot be opened: ' + err.message); }
  });
  const triggers = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'weeklyBackup'; });
  lines.push(triggers.length ? '✓ weekly backup trigger installed' : '✗ weekly backup trigger missing – run setup()');
  const sync = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'syncSources'; });
  lines.push(sync.length ? '✓ hourly sync of company sheets installed' : '✗ hourly sync missing – run setup()');
  lines.push(typeof Drive === 'undefined' ? '✗ Drive API service is off – needed to read the Excel files' : '✓ Drive API service is on');
  readTable_('Data Sources').forEach(function (d) {
    try { lines.push('✓ source ' + d.source_id + ' → ' + DriveApp.getFileById(String(d.file_id)).getName() + (d.last_result ? ' · last: ' + d.last_result : '')); }
    catch (err) { lines.push('✗ source ' + d.source_id + ' cannot be opened: ' + err.message); }
  });
  Logger.log(lines.join('\n'));
  return lines;
}

// ───────────────────────────── Company sheets → search index (step 3) ─────────────────────────────
// The team keeps working in their own Google Sheets / Excel files. Every hour syncSources() reads the
// sources listed in the "Data Sources" tab, turns every useful row into a search item, and saves one
// index file in the private system folder. Who may see which source is set in Data Sources.roles.

const INDEX_FILE_NAME = 'oa-search-index.json';
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
                'october', 'november', 'december'];

// Words that follow a number but are not street names ("3 weeks", "9 am", "2 stops" …).
const NOT_STREET = ['am', 'pm', 'weeks', 'week', 'days', 'day', 'stops', 'stop', 'floors', 'floor', 'cars', 'car',
  'hours', 'hrs', 'hr', 'years', 'year', 'months', 'month', 'units', 'unit', 'sets', 'set', 'crew', 'crews',
  'and', 'the', 'for', 'to', 'of', 'min', 'mins', 'ext', 'locks', 'lock', 'sec', 'phones', 'photos', 'invoice',
  'invoices', 'yes', 'no', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'th', 'nd', 'rd', 'st', 'person', 'people', 'pcs', 'pc', 'ft', 'feet', 'mm', 'lbs', 'kg', 'fpm', 'hp', 'v'];

function cellText_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return isNaN(v) ? '' : Utilities.formatDate(v, 'America/Toronto', 'yyyy-MM-dd');
  return String(v).replace(/\r/g, '').trim();
}

/** "165 Division St Unit 107 Cobourg" → "165 divi". Same building, different spellings → same key. */
function addrKey_(text) {
  const s = String(text || '').replace(/_/g, ' ')
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')                       // ISO dates
    .replace(/\b\d{1,2}([:.]\d{2})?\s*(am|pm)\b/gi, ' ')      // 9am, 9:00 am, 7.00 pm
    .replace(/\d{1,2}:\d{2}/g, ' ')
    .replace(/[#$]\s*\d+/g, ' ');
  const re = /(?:^|[^\d\w])(\d{1,5})[a-z]?[ \t]*[-,]?[ \t]+([A-Za-z][A-Za-z'.]*)(?:[ \t]+([A-Za-z][A-Za-z'.]*))?/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    let word = m[2].replace(/[.']/g, '').toLowerCase();
    if (/^(st|saint|mt|mount|ste)$/.test(word) && m[3]) word = word.slice(0, 2) + m[3].replace(/[.']/g, '').toLowerCase();
    if (word.length < 3 || NOT_STREET.indexOf(word) >= 0) continue;
    return m[1] + ' ' + word.slice(0, 4);
  }
  return '';
}

const LABEL_RE = /\b(address|installation\s*#|name|cell|office|email|e|site\s*contact|contact|brand|#\s*of\s*stops|front-rear\s*door|expe?i?ry\s*date|type|term|customer|phone|backup\s*contact)\s*:/gi;

/** Contacts found anywhere in a block of text. */
function extractContacts_(text) {
  const t = String(text || '');
  const emails = (t.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map(function (e) { return e.toLowerCase(); });
  const phones = [];
  (t.match(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) || []).forEach(function (p) {
    const d = p.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    if (d.length === 10 && phones.indexOf(d) < 0) phones.push(d);
  });
  const people = [];
  const nameRe = /(?:^|\n|\s)(?:name|site\s*contact|contact|customer|backup\s*contact)\s*:\s*([^\n:]{2,60}?)(?=\s*(?:\n|cell|office|email|phone|$|\d{3}))/gi;
  let m;
  while ((m = nameRe.exec(t)) !== null) {
    const n = m[1].replace(/[_]+/g, '').replace(/\s+/g, ' ').trim();
    if (n && !/^[\W\d]*$/.test(n) && people.indexOf(n) < 0) people.push(n);
  }
  return { emails: unique_(emails), phones: phones, people: people };
}
function unique_(a) { return a.filter(function (x, i) { return x && a.indexOf(x) === i; }); }

/** True if a block only holds empty template labels ("Address: Installation #: Name: …"). */
function isTemplate_(text) {
  const rest = String(text || '').replace(LABEL_RE, ' ').replace(/WK\s*\d/gi, ' ').replace(/[_\s\/,.:-]+/g, ' ').trim();
  return rest.replace(/[^A-Za-z0-9]/g, '').length < 4;
}

function firstDate_(row) {
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    if (v instanceof Date && !isNaN(v) && v.getFullYear() > 2015 && v.getFullYear() < 2100) return v;
  }
  for (let i = 0; i < row.length; i++) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(20\d{2})$/.exec(cellText_(row[i]));
    if (m) { // these sheets write day/month/year
      const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
      if (!isNaN(d) && Number(m[2]) <= 12) return d;
    }
  }
  return null;
}

function makeItem_(ctx, row, fields) {
  const text = fields.text.replace(/\n{2,}/g, '\n').slice(0, 900);
  const c = extractContacts_(fields.raw || text);
  return {
    id: ctx.source.source_id + ':' + ctx.tab + ':' + row + (fields.suffix || ''),
    src: ctx.source.source_id,
    kind: fields.kind || ctx.source.name,
    tab: ctx.tab,
    title: fields.title.slice(0, 160),
    addr: (fields.addr || '').slice(0, 160),
    key: addrKey_(fields.addr || '') || addrKey_(fields.title) || addrKey_(text),
    text: text,
    people: c.people, phones: c.phones, emails: c.emails,
    date: fields.date ? Utilities.formatDate(fields.date, 'America/Toronto', 'yyyy-MM-dd') : '',
    person: fields.person || '',
    url: ctx.rowUrl(row),
  };
}

const HEADER_HINT = /(location|address|contact|customer|project|job\s*#|docket|scope|name|ref\s*#|item|memo|amount|status)/i;

/** Rows of a normal tracker table: header row, then one record per row. Handles several sub-tables per tab. */
function parseTable_(values, ctx) {
  const items = [];
  let headers = null;
  let section = '';
  for (let r = 0; r < values.length; r++) {
    const row = values[r];
    const cells = row.map(cellText_);
    const filled = cells.filter(String);
    if (!filled.length) continue;
    const hintCount = cells.filter(function (c) { return c.length < 45 && HEADER_HINT.test(c); }).length;
    if (filled.length >= 3 && hintCount >= 2 && !cells.some(function (c) { return /@|\d{3}[\s.-]\d{3}/.test(c); })) {
      headers = cells.map(function (h) { return h.replace(/\s+/g, ' '); });
      continue;
    }
    if (filled.length === 1 && filled[0].length < 60 && /(commercial|residential|quarterly|annual|monthly|inactive|tracker)/i.test(filled[0])) {
      section = filled[0]; continue;
    }
    if (!headers) continue;
    if (/total\s+year\s+value|new function|old function/i.test(cells.join(' '))) continue;
    const joined = cells.map(function (c, i) {
      return c ? ((headers[i] && headers[i].length < 40 ? headers[i] + ': ' : '') + c) : '';
    }).filter(String).join('\n');
    if (isTemplate_(cells.join(' '))) continue;
    const col = function (re) {
      for (let i = 0; i < headers.length; i++) if (re.test(headers[i]) && cells[i]) return cells[i];
      return '';
    };
    let addr = col(/location|address/i);
    const am = /address\s*:\s*([^\n]+)/i.exec(addr);
    if (am) addr = am[1].trim();
    if (!addr) addr = col(/job\s*#?_?\s*address/i);
    let title = col(/job\s*#|name|docket|ref\s*#|scope|customer/i) || addr || filled[0];
    title = title.replace(/\s+/g, ' ');
    items.push(makeItem_(ctx, r + 1, {
      kind: ctx.tab + (section && section !== ctx.tab ? ' · ' + section.replace(/:$/, '') : ''),
      title: title, addr: addr || (addrKey_(title) ? title : ''),
      text: joined, raw: cells.join('\n'), date: firstDate_(row),
    }));
  }
  return items;
}

/** Monthly schedule grid: technicians down the side, working days across, plus the monthly maintenance lists. */
function parseSchedule_(values, ctx) {
  const items = [];
  const monthIdx = MONTHS.indexOf(ctx.tab.trim().toLowerCase());
  if (monthIdx < 0) return items;
  const ym = /(20\d{2})/.exec(ctx.title);
  const year = ym ? Number(ym[1]) : new Date().getFullYear();

  // 1. Find the row of weekday names, then the row of day numbers under it.
  let dayRow = -1;
  for (let r = 0; r < Math.min(values.length, 15); r++) {
    const n = values[r].filter(function (c) { return /^(mon|tue|wed|thu|fri|sat|sun)/i.test(cellText_(c)); }).length;
    if (n >= 5) { dayRow = r; break; }
  }
  if (dayRow < 0) return items;
  const dateByCol = {};
  values[dayRow + 1].forEach(function (c, i) {
    const d = Number(cellText_(c));
    if (d >= 1 && d <= 31) dateByCol[i] = new Date(year, monthIdx, d);
  });

  // 2. Grid entries until the "maintenance to be done" block.
  let person = '';
  let r = dayRow + 2;
  for (; r < values.length; r++) {
    const row = values[r];
    const joined = row.map(cellText_).join(' ');
    if (/to be done/i.test(joined)) break;
    const label = cellText_(row[0]);
    if (label) person = label.replace(/\s+/g, ' ').trim();
    Object.keys(dateByCol).forEach(function (c) {
      const t = cellText_(row[c]);
      if (!t || !person || /^(office|off|holiday|vacation)\b[\s\d.]*$/i.test(t)) return;
      items.push(makeItem_(ctx, r + 1, {
        kind: 'Schedule', suffix: ':' + c, person: person, date: dateByCol[c],
        title: t.split('\n')[0].replace(/\s+/g, ' '), addr: '', text: t,
      }));
    });
  }

  // 3. Maintenance-to-do lists: blocks with LOCATION / CONTACT / NOTE columns side by side.
  const titleRow = r < values.length ? values[r] : null;
  let headerRow = -1;
  for (let k = r; k < Math.min(values.length, r + 5); k++) {
    if (values[k].some(function (c) { return /^location$/i.test(cellText_(c)); })) { headerRow = k; break; }
  }
  if (headerRow < 0) return items;
  const groups = [];
  values[headerRow].forEach(function (c, i) {
    if (!/^location$/i.test(cellText_(c))) return;
    let label = '';
    if (titleRow) for (let j = i; j >= 0 && !label; j--) { const t = cellText_(titleRow[j]); if (/maintenance/i.test(t)) label = t; }
    groups.push({ col: i, label: label.replace(/\(.*?\)/g, '').replace(/[\s:]+$/, '').trim() || 'Maintenance to be done' });
  });
  const monthName = MONTHS[monthIdx].charAt(0).toUpperCase() + MONTHS[monthIdx].slice(1);
  let freq = {};
  for (let k = headerRow + 1; k < values.length; k++) {
    const row = values[k];
    groups.forEach(function (g) {
      const f = cellText_(row[g.col - 1]);
      if (f && /annual|quarter|month/i.test(f)) freq[g.col] = f;
      const loc = cellText_(row[g.col]);
      if (!loc || isTemplate_(loc)) return;
      const parts = [loc, cellText_(row[g.col + 1]), cellText_(row[g.col + 2]), cellText_(row[g.col + 3])].filter(String);
      const am = /address\s*:\s*([^\n]+)/i.exec(loc);
      const addr = am ? am[1].trim() : loc.split('\n')[0].trim();
      items.push(makeItem_(ctx, k + 1, {
        kind: g.label + (freq[g.col] ? ' · ' + freq[g.col] : ''), suffix: ':' + g.col,
        title: monthName + ' maintenance · ' + addr, addr: addr, text: parts.join('\n'),
        date: new Date(year, monthIdx, 1),
      }));
    });
  }
  return items;
}

// ───────── sync ─────────

/** Opens a source file. Excel files are converted to a temporary Google Sheet (needs the Drive API service). */
function openSource_(fileId) {
  const file = DriveApp.getFileById(fileId);
  if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
    return { ss: SpreadsheetApp.openById(fileId), tempId: '', url: 'https://docs.google.com/spreadsheets/d/' + fileId + '/edit', native: true };
  }
  if (typeof Drive === 'undefined') {
    throw new Error(file.getName() + ' is an Excel file. Turn on the "Drive API" service in Apps Script (Services → +) so it can be read.');
  }
  const copy = Drive.Files.copy({ name: '_oa_temp_' + file.getName(), mimeType: MimeType.GOOGLE_SHEETS,
                                  parents: [getSettings_().SYSTEM_FOLDER_ID] }, fileId);
  return { ss: SpreadsheetApp.openById(copy.id), tempId: copy.id, url: file.getUrl(), native: false };
}

/** Reads every active Data Source and rebuilds the search index. Runs every hour; you can also run it by hand. */
function syncSources() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { Logger.log('A sync is already running.'); return; }
  const started = new Date();
  const items = [];
  const report = [];
  const opened = {};   // one conversion per file, even if several sources read it
  try {
    const sheet = SpreadsheetApp.getActive().getSheetByName('Data Sources');
    const rows = readTable_('Data Sources');
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
    rows.forEach(function (src, i) {
      if (!isTrue_(src.active)) return;
      let count = 0, result = 'OK';
      try {
        const fid = String(src.file_id).trim();
        const book = opened[fid] || (opened[fid] = openSource_(fid));
        {
          const re = new RegExp(String(src.tabs || '.*'), 'i');
          book.ss.getSheets().forEach(function (sh) {
            const tab = sh.getName().trim();
            if (!re.test(tab)) return;
            const gid = sh.getSheetId();
            const ctx = {
              source: src, tab: tab, title: book.ss.getName(),
              rowUrl: function (row) { return book.native ? book.url + '#gid=' + gid + '&range=A' + row : book.url; },
            };
            const values = sh.getDataRange().getValues();
            const found = String(src.parser).trim() === 'schedule' ? parseSchedule_(values, ctx) : parseTable_(values, ctx);
            found.forEach(function (it) { items.push(it); });
            count += found.length;
          });
        }
      } catch (err) {
        result = 'FAILED: ' + err.message;
      }
      report.push(src.source_id + ': ' + count + ' items · ' + result);
      // Write the status next to the source so Kaixin can see it in the sheet.
      const r = i + 2;
      const put = function (name, value) { const c = headers.indexOf(name); if (c >= 0) sheet.getRange(r, c + 1).setValue(value); };
      put('last_sync', started); put('last_result', count + ' items · ' + result);
    });
    // Version = fingerprint of the content, so phones only download the index again when something changed.
    const body = JSON.stringify(items);
    const version = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, body)).slice(0, 16);
    const index = { version: version, builtAt: started.toISOString(), items: items };
    const folder = DriveApp.getFolderById(getSettings_().SYSTEM_FOLDER_ID);
    const existing = folder.getFilesByName(INDEX_FILE_NAME);
    const json = JSON.stringify(index);
    if (existing.hasNext()) existing.next().setContent(json);
    else folder.createFile(INDEX_FILE_NAME, json, MimeType.PLAIN_TEXT);
    PropertiesService.getScriptProperties().setProperty('INDEX_VERSION', index.version);
    CacheService.getScriptCache().remove('index');
    Logger.log('Search index rebuilt: ' + items.length + ' items\n' + report.join('\n'));
    return report;
  } finally {
    Object.keys(opened).forEach(function (k) {
      if (opened[k].tempId) { try { Drive.Files.remove(opened[k].tempId); } catch (e) { /* already gone */ } }
    });
    lock.releaseLock();
  }
}

function loadIndex_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('index');
  if (hit) return JSON.parse(hit);
  const files = DriveApp.getFolderById(getSettings_().SYSTEM_FOLDER_ID).getFilesByName(INDEX_FILE_NAME);
  if (!files.hasNext()) return { version: '', items: [] };
  const text = files.next().getBlob().getDataAsString();
  if (text.length < 95000) cache.put('index', text, 600);   // the script cache holds at most 100 KB per key
  return JSON.parse(text);
}

/** Sources this user may see: Data Sources.roles lists role_ids (admin always sees everything). */
function visibleSourceIds_(user) {
  return readTable_('Data Sources').filter(function (s) {
    if (!isTrue_(s.active)) return false;
    if (user.isAdmin) return true;
    const allowed = String(s.roles || '').split(',').map(function (r) { return r.trim(); });
    return user.roles.some(function (r) { return allowed.indexOf(r) >= 0; });
  }).map(function (s) { return String(s.source_id); });
}

function installSyncTrigger_() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'syncSources'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncSources').timeBased().everyHours(1).create();
}
