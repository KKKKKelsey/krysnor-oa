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
 *   refreshNotifications()  rebuilds the bell list now (it also runs by itself every day at 9:00)
 */

const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

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
      ['SITES_IMPORT_SOURCE', 'MAINT', 'Data Source whose maintenance tab feeds Sites and the Maintenance Log'],
      ['SITES_IMPORT_TAB', '{YEAR} Maintenance-Commercial', 'Tab name to import ({YEAR} = this year). Add |{YEAR} Maintenance-Residential to include residential'],
      ['PAYMENT_PLANS', '50/50=50,50|45/45/10=45,45,10', 'Invoice splits offered on a project (name=percentages). Each part is billed at a step you pick'],
      ['HST_RATE', '13', 'Sales tax % added to maintenance invoice amounts on the This month checklist'],
      ['RES_MAINT_ROLES', 'office', 'Who gets residential maintenance reminders and email drafts'],
      ['MAINT_REMINDER_ROLES', 'office', 'Who gets the monthly maintenance reminders and invoice checklist (role_ids, comma-separated)'],
      ['ORDER_STAGES', 'Asked supplier|Supplier quoted|Confirmed with supplier|Pickup / delivery set|Received', 'Steps of a material order, in order, separated by |'],
      ['ORDER_CHASE_DAYS', '3', 'Remind when an order has waited this many days for a supplier quote or for our confirmation'],
      ['ORDER_REMINDER_ROLES', 'office', 'Who gets order reminders'],
      ['PROJECT_REMINDER_ROLES', 'office', 'Who gets project follow-up reminders (e.g. quote sent 7 days ago)'],
      ['MAIL_LOOKBACK_DAYS', '3', 'The mailbox collector looks at mail from the last N days each run (already-saved mail is skipped)'],
      ['MAIL_KEEP_DAYS_IN_OA', '120', 'The OA page shows mail records from the last N days (older ones stay in the Mail tab)'],
      ['CRM_LIFECYCLE', 'Lead|Opportunity|Customer|Past customer|Other', 'CRM lifecycle stages, in order, separated by |'],
      ['CRM_COMPANY_TYPES', 'Property manager|Building owner|General contractor|Architect / consultant|Condo corporation|Homeowner|Supplier|Other', 'CRM company types, separated by |'],
      ['CRM_IMPORT', 'TRUE', 'TRUE = the hourly sync adds contacts and companies from the Project Tracker, Sites and residential maintenance (never overwrites what you typed)'],
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
      ['sales', 'Sales', 'Screens new leads, sends quotes and follows up from the sales mailbox. Give it to whoever does sales (Kyle for now).', true],
      ['viewer', 'Viewer', 'Read-only access to everything.', true],
    ],
  },
  'Permissions': {
    headers: ['permission', 'description', 'admin', 'manager', 'technician', 'office', 'viewer', 'sales'],
    widths: [150, 340, 80, 80, 90, 80, 80, 80],
    note: 'One column per role_id (header must match Roles.role_id exactly). To add a role, add a column. ' +
          'The ADMIN_EMAIL in Settings always has every permission regardless of this table.',
    rows: [
      ['view.all', 'See projects, calendar, reports and files', true, true, true, true, true, true],
      ['report.create', 'Write a new service report', true, true, true, false, false, false],
      ['report.amend_own', "Add a correction to one's own report", true, true, true, false, false, false],
      ['report.delete', 'Delete any report (kept in the sheet with who/when/why)', true, true, false, false, false, false],
      ['file.upload', 'Upload files/photos to a project folder', true, true, true, true, false, true],
      ['site.create', 'Add a customer site or elevator unit', true, true, false, true, false, true],
      ['site.delete', 'Remove a site from the Sites list (kept in the sheet as archived)', true, true, false, true, false, false],
      ['project.create', 'Open a new project (creates its Drive folders)', true, true, false, true, false, true],
      ['quote.submit', 'Submit a quote for approval', true, false, false, true, false, true],
      ['quote.approve', 'Approve or send back a quote', true, true, false, false, false, false],
      ['order.submit', 'Submit a material order for approval', true, false, false, true, false, false],
      ['order.approve', 'Approve or send back a material order', true, true, false, false, false, false],
      ['order.view', 'See material orders, supplier quotes and part prices', true, true, false, true, false, false],
      ['order.edit', 'Open orders, move them through the steps, record part prices and suppliers', true, true, false, true, false, false],
      ['project.view', 'See installation / repair projects and their steps', true, true, true, true, false, true],
      ['project.edit', 'Move projects through their steps and edit them', true, true, false, true, false, true],
      ['mail.view', 'See mail records collected from connected mailboxes (Kyle has agreed to his)', true, false, false, true, false, true],
      ['crm.view', 'See CRM contacts, companies, notes and deals', true, true, true, true, true, true],
      ['crm.edit', 'Add and edit CRM contacts and companies, write notes, link them to sites and projects', true, true, false, true, false, true],
    ],
  },
  'Users': {
    headers: ['email', 'display_name', 'role_ids', 'active', 'calendar_color', 'phone', 'added_on', 'note', 'on_calendar'],
    widths: [240, 120, 170, 70, 110, 120, 100, 220],
    note: 'email = the Google account the person signs in with. role_ids = one or more Roles.role_id, comma-separated. ' +
          'To remove access set active = FALSE (never delete the row: old reports still point to it).',
    rows: [
      ['kxli9742@gmail.com', 'Kaixin', 'admin', true, '', '', '2026-10-18', 'Owner', false],
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
              'contact_email', 'notes', 'created_at', 'created_by', 'site_contact', 'frequency', 'installation_no',
              'contract_expiry', 'contract_type', 'contract_value', 'units_qty', 'scheduled_week', 'source', 'updated_at',
              'archived', 'archived_at', 'archived_by', 'archive_reason'],
    widths: [90, 220, 90, 260, 110, 150, 130, 200, 220, 150, 200, 260, 100, 160, 110, 160, 100, 80, 100, 150, 150, 80, 150, 200, 260],
    note: 'Fixed addresses. Rows with source = "Maintenance Record" are imported every hour from the company maintenance ' +
          'record (Monthly / Quarterly / Semi-annual contracts) and kept up to date. Sites added by hand are never overwritten.',
    rows: [],
  },
  'Units': {
    headers: ['unit_id', 'site_id', 'label', 'elevator_type', 'capacity_lbs', 'speed_fpm', 'stops', 'notes', 'installation_no', 'source'],
    widths: [90, 90, 120, 130, 100, 90, 70, 220, 120, 150], rows: [],
  },
  'Projects': {
    headers: ['project_id', 'type_id', 'segment_id', 'site_id', 'title', 'status', 'owner_email',
              'folder_id', 'folder_url', 'created_at', 'created_by', 'notes', 'stage', 'stage_at', 'site_name', 'addr_key',
              'customer', 'contact', 'value', 'updated_at', 'payment_plan', 'scope', 'materials', 'scope_by', 'scope_at', 'source_ref'],
    widths: [130, 70, 90, 90, 240, 130, 200, 260, 300, 150, 200, 220, 180, 150, 220, 100, 180, 220, 90, 150, 300], rows: [],
  },
  'Project Stages': {
    headers: ['type_id', 'order', 'stage', 'segments', 'follow_up_days', 'reminder', 'notes', 'assign_roles', 'form', 'next'],
    widths: [80, 60, 260, 90, 110, 280, 320, 130, 80, 420],
    note: 'Steps of each project type, in order (from the flowchart). segments: ALL, COM or RES. assign_roles: who takes care of ' +
          'this step (sales, manager = Chris, office = Kyle, technician); they get a checkbox and ticking it moves the project on. ' +
          'follow_up_days: remind if a project stays in this step longer. form = scope: Chris writes the work and materials. ' +
          'next: choices instead of "next in order", written  choice→step | choice→step . Edit freely; the OA follows this tab.',
    rows: [
      ['INS', 1, 'Lead screening', 'ALL', 0, 'Screen the lead', 'Sources: property manager lists, referrals, calls. Check need, budget and timing.', 'sales', '', ''],
      ['INS', 2, 'Site assessment & scope', 'ALL', 3, 'Chris: assess the site and confirm the work and materials', 'Hoistway size, stops, capacity, power, commercial or residential.', 'manager', 'scope', ''],
      ['INS', 3, 'Send quote', 'ALL', 2, 'Send the quote', 'Quote states validity and payment milestones. Sent from the sales mailbox.', 'sales', '', ''],
      ['INS', 4, 'Waiting for reply', 'ALL', 7, 'No reply in 7 days: follow up', 'The OA checks the sales mailbox for a reply.', 'sales', '',
       'Customer replied→Customer confirmed · deposit | No reply→Follow up customer | Lost→Lost / cancelled'],
      ['INS', 5, 'Follow up customer', 'ALL', 0, 'Follow up the customer', 'Call or email, then wait 7 more days. After several tries with no reply, mark as lost and note why.', 'sales', '',
       'Followed up, wait again→Waiting for reply | Customer replied→Customer confirmed · deposit | Lost→Lost / cancelled'],
      ['INS', 6, 'Customer confirmed · deposit', 'ALL', 0, 'Contract signed and deposit received', 'Sign the contract, confirm the project type.', 'office', '', ''],
      ['INS', 7, 'Order materials', 'ALL', 14, 'Order the materials', 'Record supplier and delivery date (Orders page).', 'office', '', ''],
      ['INS', 8, 'Schedule workers', 'ALL', 0, 'Schedule the workers', '', 'office', '', ''],
      ['INS', 9, 'Confirm install date with customer', 'ALL', 0, 'Confirm the installation date with the customer', '', 'office', '', ''],
      ['INS', 10, 'Installation', 'ALL', 0, 'Installation done', '', 'technician', '', ''],
      ['INS', 11, 'Apply for TSSA inspection', 'COM', 14, 'Apply for the TSSA inspection', 'Record application number and booked date.', 'office', '', ''],
      ['INS', 12, 'TSSA inspection', 'COM', 0, 'Attend the TSSA inspection', 'Workers attend the inspection.', 'technician', '', ''],
      ['INS', 13, 'TSSA report received', 'COM', 0, 'TSSA report received: passed?', 'Save the report in 06_TSSA Reports & Issues.', 'office', '',
       'Passed→Send maintenance contract | Not passed→Deficiencies to fix'],
      ['INS', 14, 'Deficiencies to fix', 'COM', 0, 'Write down what has to be fixed', 'List the deficiencies from the TSSA report.', 'technician', '', ''],
      ['INS', 15, 'Schedule workers for fixes', 'COM', 0, 'Schedule workers for the fixes', '', 'office,manager', '', ''],
      ['INS', 16, 'Fix deficiencies', 'COM', 0, 'Fixes done', 'Then apply for the TSSA inspection again.', 'technician', '', 'Fixed, apply again→Apply for TSSA inspection'],
      ['INS', 17, 'Send maintenance contract', 'COM', 14, 'Send the custom maintenance contract', 'Custom to the equipment and usage.', 'office', '', ''],
      ['INS', 17, 'Send maintenance packages', 'RES', 14, 'Send the maintenance package options', 'Residential: give the customer a few package options.', 'office', '', ''],
      ['INS', 18, 'Maintenance customer', 'ALL', 0, '', 'Closed: now a maintenance customer.', '', '', ''],
      ['REP', 1, 'Request received', 'ALL', 0, 'Look at the repair request', 'Repair / replacement request.', 'office', '', ''],
      ['REP', 2, 'Site visit & scope', 'ALL', 3, 'Chris: confirm the work and materials', 'What has to be done and which parts.', 'manager', 'scope', ''],
      ['REP', 3, 'Send quote', 'ALL', 2, 'Send the repair quote', 'Sent from the sales mailbox.', 'sales', '', ''],
      ['REP', 4, 'Waiting for reply', 'ALL', 7, 'No reply in 7 days: follow up', '', 'sales', '',
       'Customer approved→Parts ordered | No reply→Follow up customer | Lost→Lost / cancelled'],
      ['REP', 5, 'Follow up customer', 'ALL', 0, 'Follow up the customer', '', 'sales', '',
       'Followed up, wait again→Waiting for reply | Customer approved→Parts ordered | Lost→Lost / cancelled'],
      ['REP', 6, 'Parts ordered', 'ALL', 14, 'Order the parts', '', 'office', '', ''],
      ['REP', 7, 'Schedule workers', 'ALL', 0, 'Schedule the repair', '', 'office', '', ''],
      ['REP', 8, 'Repair done', 'ALL', 0, 'Repair done', '', 'technician', '', ''],
      ['REP', 9, 'Closed', 'ALL', 0, '', '', '', '', ''],
    ],
  },
  'Project Events': {
    headers: ['project_id', 'at', 'stage', 'by', 'note', 'mail_id', 'event_id'],
    widths: [130, 150, 220, 200, 460, 160, 110], rows: [],
  },
  'Orders': {
    headers: ['order_id', 'created_at', 'created_by', 'title', 'supplier', 'site_id', 'site_name', 'addr_key', 'project_id', 'stage',
              'stage_at', 'quote_amount', 'quote_ref', 'ready_date', 'delivery_method', 'notes', 'mail_thread_ids', 'updated_at'],
    widths: [130, 150, 200, 280, 180, 80, 240, 100, 120, 180, 150, 110, 120, 110, 120, 300, 200, 150],
    note: 'Material orders. stage follows Settings ORDER_STAGES. Every step is also written to Order Events with who/when.', rows: [],
  },
  'Order Events': {
    headers: ['order_id', 'at', 'stage', 'by', 'note', 'amount', 'date_value', 'mail_id', 'event_id'],
    widths: [130, 150, 180, 200, 420, 100, 110, 160, 110], rows: [],
  },
  'Part Prices': {
    headers: ['price_id', 'date', 'supplier', 'part', 'part_no', 'qty', 'unit', 'unit_price', 'total', 'currency', 'order_id',
              'site_name', 'status', 'note', 'entered_by', 'entered_at'],
    widths: [80, 100, 180, 280, 130, 60, 60, 100, 100, 70, 130, 220, 90, 260, 200, 150],
    note: 'What we were quoted or paid for each part, when and by which supplier. status: quoted / bought.', rows: [],
  },
  'Suppliers': {
    headers: ['name', 'contact', 'email', 'phone', 'email_domain', 'parts', 'notes', 'updated_at'],
    widths: [200, 160, 220, 130, 160, 260, 300, 150],
    note: 'email_domain (e.g. citielevator.com) lets the OA recognise supplier emails in Kyle\'s mailbox as order mail.', rows: [],
  },
  'Maintenance Plan': {
    headers: ['site_id', 'address', 'frequency', 'due_months', 'due_months_override', 'basis', 'value', 'qty', 'contact_name',
              'contact_email', 'contact_phone', 'done_months', 'year', 'updated_at', 'segment', 'package'],
    widths: [80, 280, 100, 200, 180, 220, 90, 60, 180, 220, 130, 200, 60, 150],
    note: 'Rebuilt every hour from this year\'s company Maintenance Record. due_months is worked out from the visits in the record ' +
          '(quarterly / semi-annual months follow last year\'s pattern). To correct a site, type months in due_months_override ' +
          '(e.g. Mar,Jun,Sep,Dec): that column is kept. done_months = visits written in the record or OA maintenance reports.',
    rows: [],
  },
  'Mailboxes': {
    headers: ['mailbox', 'owner_name', 'key', 'active', 'last_ingest', 'last_count', 'note', 'purpose', 'follow_up_days',
              'unanswered_days', 'track_all_sent'],
    widths: [220, 120, 300, 70, 150, 90, 420, 120, 110, 120, 110],
    note: 'Mailboxes whose owner installed the read-only collector in their own Google account. key is a password the ' +
          'collector sends; setup() fills it. active = FALSE stops accepting mail from that box.',
    rows: [
      ['pm@krysnorelevator.ca', 'Kyle', '', false, '', '', 'Project manager box: customers we already work with. The OA flags emails left unanswered.',
       'project manager', '', 2, false],
      ['sales@krysnorelevator.ca', 'Kyle', '', false, '', '', 'Sales box: quotes, follow-ups and outreach to new customers. The OA flags quotes with no reply after 7 days.',
       'sales', 7, 2, true],
    ],
  },
  'Mail Rules': {
    headers: ['category', 'pattern', 'where', 'gmail_terms', 'create_task', 'assign_roles', 'active', 'notes'],
    widths: [110, 420, 70, 360, 90, 110, 70, 300],
    note: 'Which emails are kept and how they are labelled. pattern = regular expression (case-insensitive) checked on subject + ' +
          'start of the message. gmail_terms = Gmail search words the collector uses. create_task = remind assign_roles under the bell.',
    rows: [
      ['Quote', '\\b(estimates?|quotes?|quotation|proposal|pricing|replace|replacement|repairs?)\\b', 'any',
       '{estimate quote quotation proposal pricing replace replacement repair}', true, 'office', true, 'Quote requests and supplier quotes'],
      ['Order', '\\b(purchase order|p\\.?o\\.? ?#|ordered|order|pick ?up|ready for pick|deliver(y|ed)|shipp(ed|ing)|tracking|back ?order|lead time|in stock)\\b', 'any',
       '{order "purchase order" pickup "pick up" delivery shipped tracking backorder "lead time"}', false, 'office', true, 'Supplier emails are always Order'],
      ['Installation', '\\b(install(ation)?|new elevator|new lift|permit|shop drawings?)\\b', 'any',
       '{install installation permit "shop drawing"}', false, 'office', true, ''],
      ['Maintenance', '\\b(maintenance|preventive|service call|breakdown|entrap\\w*|stuck|not working|out of service)\\b', 'any',
       '{maintenance "service call" breakdown entrapment stuck "not working" "out of service"}', false, 'office', true, ''],
      ['Inspection', '\\b(tssa|inspection|deficienc(y|ies))\\b', 'any', '{TSSA inspection deficiency deficiencies}', false, 'office', true, ''],
      ['Invoice', '\\b(invoice|payment|remittance|overdue|e-?transfer|cheque)\\b', 'any', '{invoice payment remittance overdue e-transfer cheque}', false, 'office', true, ''],
      ['Task', '\\b(urgent|asap|reminder|action required|deadline)\\b', 'any', '{urgent asap reminder "action required" deadline}', false, 'office', true, ''],
    ],
  },
  'Project Suggestions': {
    headers: ['ref', 'source', 'title', 'type_id', 'segment_id', 'site_name', 'stage', 'contact', 'value', 'inquiry_date',
              'proposal_date', 'accepted_date', 'next_steps', 'link', 'status', 'project_id', 'updated_at'],
    widths: [120, 120, 280, 70, 80, 240, 200, 220, 90, 100, 100, 100, 260, 220, 80, 120, 150],
    note: 'Jobs that look ongoing, found every hour in the company Project Tracker (Quote & Lead follow up, last 12 months, ' +
          'not marked lost) and in mail conversations about quotes / installs. Add them from the Projects page. ' +
          'status: new / added / dismissed (kept, so a dismissed job is not suggested again).',
    rows: [],
  },
  'Mail Queue': {
    headers: ['queued_at', 'mailbox', 'kind', 'payload'],
    widths: [150, 200, 80, 600],
    note: 'Mail the collectors just sent, waiting to be filed (usually for seconds; up to 10 minutes while the hourly sync runs). Rows disappear once processed.',
    rows: [],
  },
  'Mail Threads': {
    headers: ['thread_id', 'mailbox', 'subject', 'counterpart', 'categories', 'site_name', 'first_at', 'last_in_at', 'last_out_at',
              'waiting_on', 'updated_at', 'link'],
    widths: [160, 200, 320, 240, 160, 200, 150, 150, 150, 100, 150, 260],
    note: 'One row per email conversation the collector saw: when the customer last wrote and when we last wrote. ' +
          'waiting_on = us (they wrote last) or them (we wrote last). Used for "not answered" and "no reply in 7 days" reminders.',
    rows: [],
  },
  'Email Templates': {
    headers: ['template_id', 'subject', 'body', 'notes'],
    widths: [140, 360, 600, 300],
    note: 'Drafts the OA prepares for Kyle. {first_name} {customer} {address} {month} {package} {frequency} are filled in.',
    rows: [['RES_MAINT', 'Krysnor Elevator – your home elevator maintenance in {month}',
      'Hi {first_name},\n\nThis is Kyle from Krysnor Elevator. Your home elevator at {address} is due for its {frequency} maintenance visit in {month}.\n\n' +
      'Could you let us know a few days and times that work for you? The visit takes about one to two hours and includes a full safety check, ' +
      'lubrication and adjustment.\n\nThank you,\nKyle\nKrysnor Elevator\npm@krysnorelevator.ca',
      'Residential maintenance reminder. Kyle opens it as a Gmail draft from the This month page, checks it and sends it.']],
  },
  'Mail': {
    headers: ['mail_id', 'thread_id', 'mailbox', 'received_at', 'direction', 'from', 'to', 'subject', 'snippet', 'excerpt', 'categories',
              'supplier', 'site_id', 'site_name', 'addr_key', 'amounts', 'attachments', 'link', 'ingested_at', 'linked_type', 'linked_id', 'status'],
    widths: [160, 160, 180, 150, 70, 220, 220, 320, 300, 300, 160, 140, 80, 200, 100, 140, 200, 260, 150, 90, 120, 80],
    note: 'Short records of emails that match Mail Rules (subject, sender, the first part of the message, a link back to Gmail). ' +
          'Written by the read-only collector in the mailbox owner\'s account. The full email stays in their Gmail.', rows: [],
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
       'Maintenance-(Commercial|Residential)', 'table', 'admin,manager,office', true, 'Excel file, read in memory (read-only)', '', ''],
      ['INVOICES', 'Overdue invoices', '1RflhAV5qhghDGzI6HIUgyJE8TO1ba-6a', '^Overdue Invoices$', 'table',
       'admin,manager,office', true, '', '', ''],
      ['TRACKER', 'Project tracker', '1eRPFFA_s5HmVAoA6W9cOASB-GKGkGIHd',
       '^(Quote & Lead follow up|Repair & Service Call|Project follow up|Install Schedule)$', 'table',
       'admin,manager,office', true, 'Excel file, read in memory (read-only)', '', ''],
    ],
  },
  'Pipelines': {
    headers: ['rule_id', 'trigger', 'call_types', 'task_type', 'title_template', 'assign_roles', 'active', 'notes'],
    widths: [190, 130, 220, 110, 420, 160, 70, 300],
    note: 'When trigger happens, a task is created for the roles in assign_roles. trigger: report.create. ' +
          'call_types: blank = every call type, or a comma list. Placeholders: {report_id} {site_name} {call_type} {tech_name}.',
    rows: [
      ['INVOICE_AFTER_REPORT', 'report.create', '', 'Invoice', 'Make invoice for {report_id} · {site_name} ({call_type}, {tech_name})',
       'office', true, 'Duke/Chris submit a report → Kyle makes the invoice'],
    ],
  },
  'Tasks': {
    headers: ['task_id', 'created_at', 'rule_id', 'type', 'title', 'ref_id', 'assign_roles', 'status', 'done_at', 'done_by', 'note',
              'key', 'month', 'site_id', 'link', 'amount'],
    widths: [110, 150, 190, 90, 420, 130, 140, 80, 150, 200, 260, 220, 80, 80, 200, 90],
    note: 'Created by Pipelines. status: open / done. Marked done in the OA by the person who handled it.',
    rows: [],
  },
  'Notifications': {
    headers: ['batch_at', 'role', 'task_id', 'title', 'status_at_batch'],
    widths: [160, 100, 110, 420, 110],
    note: 'Every morning at 9:00 (Toronto) the open tasks are written here as one batch. The bell in the OA shows the latest ' +
          'batch; "Past notifications" shows older batches.',
    rows: [],
  },
  'Maintenance Log': {
    headers: ['site_id', 'address', 'frequency', 'installation_no', 'scheduled_week'].concat(MONTH_ABBR),
    widths: [80, 260, 100, 160, 100, 140, 140, 140, 140, 140, 140, 140, 140, 140, 140, 140, 140],
    note: 'Rebuilt every hour from the company Maintenance Record plus visits found in OA service reports (marked "OA"). ' +
          'Do not edit here; Kyle can copy cells from this tab into the company sheet.',
    rows: [],
  },
  'CRM Companies': {
    headers: ['company_id', 'name', 'type', 'lifecycle', 'phone', 'email', 'domain', 'address', 'city', 'owner', 'notes',
              'source', 'source_ref', 'created_at', 'created_by', 'updated_at', 'archived', 'archived_at', 'archived_by'],
    widths: [90, 240, 150, 110, 130, 220, 160, 260, 110, 200, 300, 140, 160, 150, 200, 150, 70, 150, 200],
    note: 'CRM companies. owner = the email of the person looking after them. Removing one in the OA only sets archived = TRUE.', rows: [],
  },
  'CRM Contacts': {
    headers: ['contact_id', 'first_name', 'last_name', 'email', 'phone', 'mobile', 'job_title', 'company_id', 'lifecycle', 'owner',
              'address', 'notes', 'source', 'source_ref', 'created_at', 'created_by', 'updated_at', 'archived', 'archived_at', 'archived_by'],
    widths: [90, 120, 140, 220, 130, 130, 150, 90, 110, 200, 260, 300, 140, 160, 150, 200, 150, 70, 150, 200],
    note: 'CRM contacts. company_id = their company in CRM Companies. Removing one in the OA only sets archived = TRUE.', rows: [],
  },
  'CRM Notes': {
    headers: ['note_id', 'object_type', 'object_id', 'text', 'by', 'at'],
    widths: [110, 90, 100, 520, 200, 150], rows: [],
  },
  'CRM Links': {
    headers: ['a_type', 'a_id', 'b_type', 'b_id', 'by', 'at', 'source'],
    widths: [80, 110, 80, 130, 200, 150, 140],
    note: 'Which contact / company belongs to which site or project. a_type = contact or company; b_type = site or project.', rows: [],
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
  ['Record tabs (system writes)', 'Sites · Units · Projects · Service Reports · CRM Companies · CRM Contacts · CRM Notes · CRM Links · Audit Log · Backup Log'],
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
  ['Invoice reminders', 'Pipelines: when a report comes in, a task is created (e.g. invoice for Kyle). Every day at 9:00 open tasks appear under the bell (!) in the OA.'],
  ['发票提醒', 'Pipelines：收到报告后自动生成任务（例如 Kyle 开发票）。每天早上 9 点，未完成的任务会出现在 OA 右上角的「!」里。'],
  ['Removing a site', 'Kyle, Chris and Kaixin can remove a site in the OA. It stays in Sites with archived = TRUE and is never re-imported. Adding the same name again restores it.'],
  ['删除站点', 'Kyle、Chris、Kaixin 可以在 OA 里移除站点。它会留在 Sites 表里并标记 archived = TRUE，以后不会被重新导入。再次添加同名站点即可恢复。'],
  ['Deleting a report', 'People with report.delete delete from the OA with a reason; it is listed in Report Deletions and hidden. Remove that row to restore it.'],
  ['删除报告', '有 report.delete 权限的人在 OA 里删除并写原因，记录在 Report Deletions 分页，OA 里不再显示。删掉那一行即可恢复。'],
  ['Backups', 'Every week (Settings: BACKUP_WEEKDAY / BACKUP_HOUR) a copy of this sheet goes to Backups/Weekly. Copies older than BACKUP_RETENTION_DAYS go to Drive trash (recoverable for 30 days).'],
  ['备份', '每周自动复制这张表到 Backups/Weekly。超过 BACKUP_RETENTION_DAYS 天的备份移到 Drive 回收站（30 天内可恢复）。'],
];

const BACKUP_NAME_PREFIX = 'Krysnor OA Master backup ';
const TEXT_COLUMNS = ['report_id', 'project_id', 'site_id', 'unit_id', 'arrived', 'left', 'contact_phone', 'phone', 'task_id', 'ref_id',
                      'installation_no', 'scheduled_week', 'contract_expiry',
                      'client_id', 'amends_report_id', 'folder_id', 'file_id', 'order_id', 'price_id', 'part_no', 'mail_id',
                      'thread_id', 'quote_ref', 'key', 'contact_id', 'company_id', 'note_id', 'mobile', 'a_id', 'b_id', 'object_id', 'month', 'ready_date', 'date', 'date_value', 'due_months', 'due_months_override', 'done_months', 'event_id', 'payment_plan', 'template_id', 'ref', 'source_ref',
                      'inquiry_date', 'proposal_date', 'accepted_date'];

// ───────────────────────────── Setup ─────────────────────────────

function setup() {
  const ss = SpreadsheetApp.getActive();
  buildTabs_(ss);
  const s = getSettings_();
  ss.setSpreadsheetTimeZone(s.TIMEZONE || 'America/Toronto');
  const folders = setupFolders();
  installBackupTrigger_();
  installSyncTrigger_();
  installNotificationTrigger_();
  installMailQueueTrigger_();
  addMissingSeedRows_('Mailboxes', 'mailbox');
  addMissingSeedRows_('Roles', 'role_id');
  fillRoleColumn_('sales');
  migrateProjectStages_();
  fillMailboxKeys_();
  fillEventIds_();
  protectAllTabs_(ss);
  audit_(Session.getEffectiveUser().getEmail(), 'setup', ss.getName(),
         'Tabs checked; folders ensured: ' + folders.length + '; weekly backup trigger installed');
  Logger.log('Krysnor OA setup finished. Next: fill in the Google emails for Chris, Duke and Kyle ' +
             'in the Users tab, then run checkSetup().');
}

/** Gives each mailbox a random key (a password the collector in that person's account sends with the mail). */
function fillMailboxKeys_() {
  const sh = SpreadsheetApp.getActive().getSheetByName('Mailboxes');
  if (!sh) return;
  const head = headersOf_('Mailboxes');
  readTable_('Mailboxes').forEach(function (m, i) {
    if (!String(m.key || '').trim()) writeRowFields_(sh, head, i + 2, { key: Utilities.getUuid().replace(/-/g, '') });
  });
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
    // The read-only mail collector in Kyle's own account has no Google sign-in here: it sends its mailbox key instead.
    if (body.action === 'ingestMail' || body.action === 'mailConfig' || body.action === 'threadStatus') return json_({ ok: true, data: ingestMail_(body) });
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
  if ((sheetName === 'Order Events' || sheetName === 'Project Events') && !obj.event_id) obj.event_id = newEventId_();
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
    if (!amends) runPipelines_('report.create', record);
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

function archiveSite_(user, p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const reason = clean_(p.reason, 500);
    if (!reason) throw new Error('Please give a reason for removing the site.');
    const all = readTable_('Sites');
    const i = all.findIndex(function (x) { return x.site_id === p.site_id; });
    if (i < 0) throw new Error('Site ' + p.site_id + ' does not exist.');
    const sh = SpreadsheetApp.getActive().getSheetByName('Sites');
    const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
    writeRowFields_(sh, head, i + 2, { archived: true, archived_at: new Date(), archived_by: user.email, archive_reason: reason });
    audit_(user.email, 'site.archive', p.site_id, reason);
    return { site_id: p.site_id };
  } finally {
    lock.releaseLock();
  }
}

function createSite_(user, p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const name = clean_(p.name, 200);
    if (!name) throw new Error('Site name is required.');
    const segs = readTable_('Segments').map(function (x) { return x.segment_id; });
    if (segs.indexOf(p.segment_id) < 0) throw new Error('Pick Commercial or Residential.');
    const all = readTable_('Sites');
    const existing = all.filter(function (x) { return norm_(x.name) === norm_(name); })[0];
    if (existing && isTrue_(existing.archived)) {
      // Adding a removed site again brings it back.
      const sh = SpreadsheetApp.getActive().getSheetByName('Sites');
      const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
      writeRowFields_(sh, head, all.indexOf(existing) + 2, { archived: false, archived_at: '', archived_by: '', archive_reason: '', updated_at: new Date() });
      audit_(user.email, 'site.restore', existing.site_id, name);
      return { site: Object.assign(existing, { archived: false }), restored: true };
    }
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
          .map(function (u) {
            // Not on the calendar: on_calendar = FALSE, or left blank for someone who is only admin (Kaixin).
            const onCal = String(u.on_calendar).trim() === '' ? String(u.role_ids).trim() !== 'admin' : isTrue_(u.on_calendar);
            return { name: u.display_name, roles: u.role_ids, color: onCal ? u.calendar_color : '', on_calendar: onCal };
          }),
        projectTypes: readTable_('Project Types').filter(function (t) { return isTrue_(t.active); }),
        segments: readTable_('Segments').map(function (s) { return { segment_id: s.segment_id, name: s.name }; }),
        callTypes: readTable_('Call Types').filter(function (c) { return isTrue_(c.active); })
          .map(function (c) { return c.call_type; }),
        sites: readTable_('Sites').filter(function (x) { return !isTrue_(x.archived); }),
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
          .map(function (x) { return { id: x.source_id, name: x.name, parser: x.parser, lastSync: x.last_sync }; }),
        items: idx.items.filter(function (it) { return allowed.indexOf(it.src) >= 0; }),
        tableCount: (idx.tables || []).filter(function (t) { return allowed.indexOf(t.src) >= 0; }).length,
      };
    },
  },
  tables: {
    // Raw rows of the company sheets for the Tables page, only from sources this person may see.
    permission: 'view.all',
    run: function (user) {
      const allowed = visibleSourceIds_(user);
      const idx = loadIndex_();
      return { version: idx.version, tables: (idx.tables || []).filter(function (t) { return allowed.indexOf(t.src) >= 0; }) };
    },
  },
  archiveSite: {
    permission: 'site.delete',
    run: function (user, p) { return archiveSite_(user, p); },
  },
  notifications: {
    permission: 'view.all',
    run: function (user, p) { return notificationsFor_(user, p.batch_at || ''); },
  },
  completeTask: {
    permission: 'view.all',
    run: function (user, p) { return completeTask_(user, p); },
  },
  work: {
    // Orders, prices, projects and mail — each part only if this person's role may see it.
    permission: 'view.all',
    run: function (user) { return workData_(user); },
  },
  monthChecklist: {
    permission: 'view.all',
    run: function (user, p) { return monthChecklist_(user, p.month); },
  },
  setTask: {
    permission: 'view.all',
    run: function (user, p) { return p.done === false ? reopenTask_(user, p) : completeTask_(user, p); },
  },
  saveOrder: { permission: 'order.edit', run: function (user, p) { return saveOrder_(user, p); } },
  orderStep: { permission: 'order.edit', run: function (user, p) { return orderStep_(user, p); } },
  savePrices: { permission: 'order.edit', run: function (user, p) { return savePrices_(user, p); } },
  saveSupplier: { permission: 'order.edit', run: function (user, p) { return saveSupplier_(user, p); } },
  saveProject: {
    permission: 'project.edit',
    run: function (user, p) {
      if (!p.project_id && !can_(user, 'project.create')) throw new Error('You do not have permission to open projects (project.create).');
      return saveProject_(user, p);
    },
  },
  suggestions: { permission: 'project.create', run: function (user) { return { items: readTable_('Project Suggestions').filter(function (x) { return x.status === 'new'; }).map(isoRow_) }; } },
  acceptSuggestions: { permission: 'project.create', run: function (user, p) { return acceptSuggestions_(user, p); } },
  dismissSuggestion: {
    permission: 'project.create',
    run: function (user, p) { return withLock_(function () { updateRecord_('Project Suggestions', 'ref', p.ref, { status: 'dismissed', updated_at: new Date() }); return { ref: p.ref }; }); },
  },
  projectStep: {
    // project.edit may move a project to any step; the person a step is assigned to may finish that step (next step or one of its choices).
    permission: 'view.all',
    run: function (user, p) {
      if (!can_(user, 'project.edit')) checkStepOwner_(user, p);
      return projectStep_(user, p);
    },
  },
  confirmScope: {
    // Chris: what has to be done and which materials, before Kyle prepares the quote.
    permission: 'project.edit',
    run: function (user, p) { return confirmScope_(user, p); },
  },
  linkMail: { permission: 'mail.view', run: function (user, p) { return linkMail_(user, p); } },
  crm: { permission: 'crm.view', run: function (user) { return crmData_(user); } },
  crmSave: { permission: 'crm.edit', run: function (user, p) { return crmSave_(user, p); } },
  crmNote: { permission: 'crm.edit', run: function (user, p) { return crmNote_(user, p); } },
  crmLink: { permission: 'crm.edit', run: function (user, p) { return crmLink_(user, p); } },
  crmArchive: { permission: 'crm.edit', run: function (user, p) { return crmArchive_(user, p); } },
  crmImport: {
    // Reads the Project Tracker first (slow) without the lock, then writes under the lock for a moment.
    permission: 'crm.edit',
    run: function (user) { const tabs = crmTrackerTabs_(); return withLock_(function () { const r = crmImport_(tabs); audit_(user.email, 'crm.import', '', JSON.stringify(r)); return r; }); },
  },
  invoices: { permission: 'view.all', run: function (user) { return invoicesFor_(user); } },
  editTime: {
    // Only the admin (Kaixin) can correct a recorded time. Every change is written to the Audit Log with the old value.
    permission: 'view.all',
    run: function (user, p) { return editTime_(user, p); },
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
  const nine = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'refreshNotifications'; });
  lines.push(nine.length ? '✓ 9:00 notification refresh installed' : '✗ 9:00 notification refresh missing – run setup()');
  const sync = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'syncSources'; });
  lines.push(sync.length ? '✓ hourly sync of company sheets installed' : '✗ hourly sync missing – run setup()');
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
  const text = fields.text.split('\n')
    .map(function (l) { return l.replace(/_{2,}/g, '').replace(/\b(Cell|Email|Office|Phone|Name|Site contact|Installation #)\s*:\s*(?=$|\b(Cell|Email|Office|Phone|Name)\s*:)/gi, '').trim(); })
    .filter(function (l) { return l && !/^[^:]{1,30}:\s*$/.test(l); })
    .join('\n').slice(0, 900);
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
    // Year the row belongs to: its date, else a year in the tab name ("2025 Maintenance-Commercial").
    year: fields.date ? String(fields.date.getFullYear()) : (((/\b(20\d{2})\b/.exec(ctx.tab) || [])[1]) || ''),
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
    // "CHRIS", "Chris " and "chris" are the same person: store one spelling.
    if (label) person = label.replace(/\s+/g, ' ').trim().toLowerCase().replace(/\b[a-z]/g, function (ch) { return ch.toUpperCase(); });
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

/**
 * Opens a source file READ-ONLY. Google Sheets are opened directly. Excel files are read in memory
 * (unzipped and parsed here): nothing is created, converted or deleted in anyone's Drive.
 */
function openSource_(fileId) {
  const file = DriveApp.getFileById(fileId);
  if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
    return { ss: SpreadsheetApp.openById(fileId), url: 'https://docs.google.com/spreadsheets/d/' + fileId + '/edit', native: true };
  }
  const tabs = readXlsx_(file.getBlob());
  const ss = {
    getName: function () { return file.getName(); },
    getSheets: function () {
      return tabs.map(function (t, i) {
        return { getName: function () { return t.name; }, getSheetId: function () { return i; },
                 getDataRange: function () { return { getValues: function () { return t.values; } }; } };
      });
    },
  };
  return { ss: ss, url: file.getUrl(), native: false };
}

function xmlText_(s) {
  return String(s).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(Number(n)); })
    .replace(/&amp;/g, '&');
}
function colIndex_(ref) {
  const letters = /^[A-Z]+/.exec(ref)[0];
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + letters.charCodeAt(i) - 64;
  return n - 1;
}

/** Minimal .xlsx reader: returns [{name, values}] with dates as Date objects. */
function readXlsx_(blob) {
  const parts = {};
  Utilities.unzip(blob.setContentType('application/zip')).forEach(function (b) { parts[b.getName()] = b; });
  const text = function (name) { return parts[name] ? parts[name].getDataAsString('UTF-8') : ''; };

  const shared = [];
  (text('xl/sharedStrings.xml').match(/<si>[\s\S]*?<\/si>/g) || []).forEach(function (si) {
    shared.push(xmlText_((si.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).join('')));
  });

  // Which cell styles are dates (built-in formats 14–22 and 45–47, or custom formats using d/m/y).
  const styles = text('xl/styles.xml');
  const customDate = {};
  (styles.match(/<numFmt [^>]*>/g) || []).forEach(function (f) {
    const id = /numFmtId="(\d+)"/.exec(f), code = /formatCode="([^"]*)"/.exec(f);
    if (id && code && /[dmy]/i.test(code[1].replace(/\[[^\]]*\]|"[^"]*"|&quot;[^&]*&quot;/g, ''))) customDate[id[1]] = true;
  });
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles);
  const dateStyle = [];
  ((xfs && xfs[1].match(/<xf [^>]*>/g)) || []).forEach(function (xf) {
    const id = Number((/numFmtId="(\d+)"/.exec(xf) || [0, 0])[1]);
    dateStyle.push((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || !!customDate[id]);
  });

  // Tab names → sheet files, via workbook.xml and its relationships.
  const rels = {};
  (text('xl/_rels/workbook.xml.rels').match(/<Relationship [^>]*>/g) || []).forEach(function (r) {
    rels[/Id="([^"]+)"/.exec(r)[1]] = /Target="([^"]+)"/.exec(r)[1].replace(/^\/?xl\//, '');
  });
  const out = [];
  (text('xl/workbook.xml').match(/<sheet [^>]*>/g) || []).forEach(function (sh) {
    const name = xmlText_(/name="([^"]*)"/.exec(sh)[1]);
    const rid = /r:id="([^"]+)"/.exec(sh)[1];
    const xml = text('xl/' + rels[rid]);
    const grid = [];
    let width = 0;
    (xml.match(/<row[^>]*\/>|<row[^>]*>[\s\S]*?<\/row>/g) || []).forEach(function (row) {
      const rm = / r="(\d+)"/.exec(row);
      if (!rm) return;
      const vals = [];
      (row.match(/<c [^>]*\/>|<c [^>]*>[\s\S]*?<\/c>/g) || []).forEach(function (c) {
        const ref = / r="([A-Z]+)\d+"/.exec(c);
        if (!ref) return;
        const t = (/ t="([^"]+)"/.exec(c) || [0, ''])[1];
        const sIdx = Number((/ s="(\d+)"/.exec(c) || [0, 0])[1]);
        const v = /<v>([\s\S]*?)<\/v>/.exec(c);
        let val = '';
        if (t === 's' && v) val = shared[Number(v[1])] || '';
        else if (t === 'inlineStr') val = xmlText_((c.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).join(''));
        else if (t === 'str' || t === 'e') val = v ? xmlText_(v[1]) : '';
        else if (t === 'b') val = v ? v[1] === '1' : '';
        else if (v) {
          const num = Number(v[1]);
          if (dateStyle[sIdx] && num > 0 && num < 2958466) {
            const d = new Date(Math.round((num - 25569) * 86400000));       // Excel serial day → UTC
            val = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
          } else val = num;
        }
        vals[colIndex_(ref[1])] = val;
      });
      grid[Number(rm[1]) - 1] = vals;
      width = Math.max(width, vals.length);
    });
    const values = [];
    for (let r = 0; r < grid.length; r++) {
      const src = grid[r] || [];
      const row = [];
      for (let c = 0; c < width; c++) row.push(src[c] === undefined ? '' : src[c]);
      values.push(row);
    }
    out.push({ name: name, values: values });
  });
  return out;
}

/** Reads every active Data Source and rebuilds the search index. Runs every hour; you can also run it by hand. */
function syncSources() {
  // Only one sync at a time — but this does NOT block reports, mail or ticks while the company files are being read.
  const lock = LockService.getDocumentLock() || LockService.getUserLock();
  if (!lock.tryLock(5000)) { Logger.log('A sync is already running.'); return; }
  const started = new Date();
  const items = [];
  const tables = [];
  const report = [];
  const settings = getSettings_();
  const year = started.getFullYear();
  const importTab = new RegExp('^(' + String(settings.SITES_IMPORT_TAB || '{YEAR} Maintenance-Commercial')
    .replace(/\{YEAR\}/g, String(year)) + ')$', 'i');
  const importRaw = [];
  const contractsByYear = {};   // commercial maintenance contracts per year → Maintenance Plan
  const trackerQuotes = [];     // company Project Tracker "Quote & Lead follow up" → Project Suggestions
  const opened = {};   // each file is read once, even if several sources use it
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
            if (String(src.source_id) === 'TRACKER' && /quote.*lead/i.test(tab)) trackerQuotes.push({ values: values, url: book.url, gid: gid });
            const isTable = String(src.parser).trim() !== 'schedule';
            const found = isTable ? parseTable_(values, ctx) : parseSchedule_(values, ctx);
            if (isTable) {
              const snap = tableSnapshot_(values);
              tables.push({ src: String(src.source_id), source: src.name, tab: tab, url: book.url, native: book.native, gid: gid,
                            headers: snap.headers, rows: snap.rows });
            }
            if (String(src.source_id) === String(settings.SITES_IMPORT_SOURCE || 'MAINT') && importTab.test(tab)) importRaw.push(values);
            const ym = /^(20\d{2}) Maintenance-/i.exec(tab);
            if (ym && String(src.source_id) === String(settings.SITES_IMPORT_SOURCE || 'MAINT')) {
              const parsed = parseMaintenanceContracts_(values);
              if (/commercial/i.test(tab)) contractsByYear[ym[1]] = (contractsByYear[ym[1]] || []).concat(parsed.map(function (c) { c.segment = 'COM'; return c; }));
              if (/residential/i.test(tab)) contractsByYear[ym[1]] = (contractsByYear[ym[1]] || []).concat(parsed.map(residentialFrequency_));
              const v = maintenanceVisits_(parsed, Number(ym[1]), ctx);
              v.forEach(function (it) { items.push(it); });
              count += v.length;
            }
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
    // The writes below take the shared write lock for a few seconds only.
    const writeLock = LockService.getScriptLock();
    writeLock.waitLock(120000);
    try {
    // Fixed maintenance addresses → Sites / Units, and the Maintenance Log tab (both in Kaixin's sheet only).
    if (importRaw.length) {
      try {
        let contracts = [];
        importRaw.forEach(function (v) { contracts = contracts.concat(parseMaintenanceContracts_(v)); });
        const res = importMaintenanceSites_(contracts);
        const log = buildMaintenanceLog_(contracts, year);
        tables.push({ src: String(settings.SITES_IMPORT_SOURCE || 'MAINT'), source: 'Krysnor OA', tab: 'Maintenance Log ' + year + ' (with OA reports)',
                      url: '', native: false, gid: 0, headers: log.header,
                      rows: log.rows.map(function (r, i) { return { r: i + 2, c: r.map(cellText_) }; }) });
        report.push('Sites: ' + res.added + ' added, ' + res.updated + ' updated, ' + res.units + ' units added; maintenance log ' + log.rows.length + ' rows');
        const planRows = writeMaintenancePlan_(maintenancePlan_(contractsByYear, year), year);
        try { report.push('Project suggestions: ' + rebuildSuggestions_(trackerQuotes) + ' new'); } catch (err) { report.push('Project suggestions FAILED: ' + err.message); }
        try { if (String(settings.CRM_IMPORT || 'TRUE').toUpperCase() !== 'FALSE') { const ci = crmImport_(trackerQuotes); report.push('CRM: ' + ci.contacts + ' contacts, ' + ci.companies + ' companies, ' + ci.links + ' links added'); } } catch (err) { report.push('CRM import FAILED: ' + err.message); }
        const mt = ensureMonthTasks_();
        report.push('Maintenance plan ' + planRows + ' sites; ' + mt.month + ': ' + mt.created + ' new reminders, ' + mt.closed + ' ticked off from the record');
      } catch (err) {
        report.push('Sites import FAILED: ' + err.message);
      }
    }
    // Version = fingerprint of the content, so phones only download the index again when something changed.
    const body = JSON.stringify([items, tables]);
    const version = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, body)).slice(0, 16);
    const index = { version: version, builtAt: started.toISOString(), items: items, tables: tables };
    const folder = DriveApp.getFolderById(getSettings_().SYSTEM_FOLDER_ID);
    const existing = folder.getFilesByName(INDEX_FILE_NAME);
    const json = JSON.stringify(index);
    if (existing.hasNext()) existing.next().setContent(json);
    else folder.createFile(INDEX_FILE_NAME, json, MimeType.PLAIN_TEXT);
    PropertiesService.getScriptProperties().setProperty('INDEX_VERSION', index.version);
    CacheService.getScriptCache().remove('index');
    } finally {
      writeLock.releaseLock();
    }
    Logger.log('Search index rebuilt: ' + items.length + ' items\n' + report.join('\n'));
    return report;
  } finally {
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

// ───────────────────────────── Table snapshots, maintenance sites, maintenance log ─────────────────────────────

/** Raw view of a tab for the Tables page: header row + data rows, empty columns removed. */
function tableSnapshot_(values) {
  let h = -1;
  for (let r = 0; r < Math.min(values.length, 20) && h < 0; r++) {
    const cells = values[r].map(cellText_);
    const filled = cells.filter(String).length;
    const hints = cells.filter(function (c) { return c.length < 45 && HEADER_HINT.test(c); }).length;
    if (filled >= 3 && hints >= 2) h = r;
  }
  const start = h >= 0 ? h + 1 : 0;
  const width = values.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
  const headers = [];
  for (let c = 0; c < width; c++) {
    const t = h >= 0 ? cellText_(values[h][c]).replace(/\s+/g, ' ') : '';
    headers.push(t || String.fromCharCode(65 + (c % 26)) + (c >= 26 ? Math.floor(c / 26) : ''));
  }
  const rows = [];
  for (let r = start; r < values.length; r++) {
    const cells = [];
    for (let c = 0; c < width; c++) cells.push(cellText_(values[r][c]).slice(0, 400));
    if (!cells.some(String) || isTemplate_(cells.join(' '))) continue;
    rows.push({ r: r + 1, c: cells });
  }
  const keep = [];
  for (let c = 0; c < width; c++) {
    if ((h >= 0 && cellText_(values[h][c])) || rows.some(function (row) { return row.c[c]; })) keep.push(c);
  }
  return {
    headers: keep.map(function (c) { return headers[c]; }),
    rows: rows.map(function (row) { return { r: row.r, c: keep.map(function (c) { return row.c[c]; }) }; }),
  };
}

/** Value after a label inside a multi-line cell: "Expiry Date: 05/2028\nType: Full   Term: 3". */
function labelValue_(text, label) {
  const m = new RegExp('(?:^|\\n|\\s)' + label + '[ \\t]*:[ \\t]*([^\\n]*)', 'i').exec(String(text || ''));
  if (!m) return '';
  return m[1].split(/\s{2,}[A-Z#][A-Za-z #-]{1,20}:|\s+(?:Type|Term|Cell|Email|Office|Name)\s*:/)[0]
    .replace(/_{2,}/g, '').trim();
}


/** Contracts in a "YYYY Maintenance-Commercial" tab, with their frequency section (Monthly / Quarterly / Semi-annual). */
function parseMaintenanceContracts_(values) {
  const out = [];
  let cols = null;
  let freq = 'Monthly';            // the first block in the sheet has no title: it is the monthly list
  for (let r = 0; r < values.length; r++) {
    const cells = values[r].map(cellText_);
    const filled = cells.filter(String);
    if (!filled.length) continue;
    if (cells.some(function (c) { return /^location/i.test(c); }) && cells.some(function (c) { return /^contact$/i.test(c); })) {
      cols = { months: [] };
      cells.forEach(function (c, i) {
        const u = c.toUpperCase().trim();
        if (/^location/i.test(c)) cols.loc = i;
        else if (/^contact$/i.test(c)) cols.contact = i;
        else if (/contract/i.test(c)) cols.detail = i;
        else if (/^value$/i.test(c)) cols.value = i;
        else if (/^qty$/i.test(c)) cols.qty = i;
        else if (/^type$/i.test(c)) cols.type = i;
        else if (/schedul/i.test(c)) cols.week = i;
        else if (MONTH_ABBR.indexOf(u) >= 0) cols.months[MONTH_ABBR.indexOf(u)] = i;
      });
      cols.after = Math.max.apply(null, cols.months.filter(function (x) { return x !== undefined; })) + 1;
      continue;
    }
    if (filled.length === 1 && filled[0].length < 40 && !/:/.test(filled[0])) {
      const f = filled[0].toLowerCase();
      if (/inactive|no contract/.test(f)) freq = 'Inactive';
      else if (/quarter/.test(f)) freq = 'Quarterly';
      else if (/bi.?annual|semi/.test(f)) freq = 'Semi-annual';
      else if (/annual|year/.test(f)) freq = 'Annual';
      else if (/month/.test(f)) freq = 'Monthly';
      continue;
    }
    if (!cols || freq === 'Inactive') continue;
    const loc = cells[cols.loc] || '';
    const address = (labelValue_(loc, 'Address') || (/address\s*:/i.test(loc) ? '' : loc.split('\n')[0])).replace(/\s+/g, ' ').trim();
    if (!address || !addrKey_(address)) continue;
    const contact = cells[cols.contact] || '';
    const detail = cols.detail !== undefined ? cells[cols.detail] : '';
    const type = cols.type !== undefined ? cells[cols.type] : '';
    const notes = cells.slice(cols.after).filter(String).join('\n');
    const phones = extractContacts_(contact).phones;
    out.push({
      row: r + 1, frequency: freq, address: address,
      installation: labelValue_(loc, 'Installation\\s*#').replace(/\s+/g, ' '),
      contactName: labelValue_(contact, 'Name'),
      contactPhone: phones.length ? phones[0].replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3') : labelValue_(contact, 'Cell'),
      contactEmail: (extractContacts_(contact).emails[0] || ''),
      siteContact: isTemplate_(notes) ? '' : notes.replace(/\s+/g, ' ').replace(/_{2,}/g, '').trim(),
      expiry: labelValue_(detail, 'Exp\\w*\\s*Date'), contractType: labelValue_(detail, 'Type'), term: labelValue_(detail, 'Term'),
      value: cols.value !== undefined ? values[r][cols.value] : '',
      qty: cols.qty !== undefined ? values[r][cols.qty] : '',
      brand: labelValue_(type, 'Brand'), stops: labelValue_(type, '#\\s*of\\s*Stops'),
      week: cols.week !== undefined ? cells[cols.week] : '',
      months: MONTH_ABBR.map(function (m, i) { return cols.months[i] !== undefined ? cells[cols.months[i]] : ''; }),
    });
  }
  return out;
}

/** Writes one object into a row of a tab by column name (only the given keys). */
function writeRowFields_(sheet, headers, rowNumber, obj) {
  Object.keys(obj).forEach(function (k) {
    const c = headers.indexOf(k);
    if (c >= 0) sheet.getRange(rowNumber, c + 1).setValue(obj[k]);
  });
}

/**
 * Adds the fixed maintenance-contract addresses to Sites (and their installation numbers to Units).
 * Never deletes. Sites first created by this import are kept up to date; sites someone added by hand
 * only get their empty fields filled in.
 */
function importMaintenanceSites_(contracts) {
  const ss = SpreadsheetApp.getActive();
  const sitesSheet = ss.getSheetByName('Sites');
  const unitsSheet = ss.getSheetByName('Units');
  const sHead = sitesSheet.getRange(1, 1, 1, sitesSheet.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  const uHead = unitsSheet.getRange(1, 1, 1, unitsSheet.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  const sites = readTable_('Sites');
  const units = readTable_('Units');
  const byKey = {};
  sites.forEach(function (s, i) { const k = addrKey_(s.address || s.name); if (k && !byKey[k]) byKey[k] = { site: s, row: i + 2 }; });
  let nextSite = sites.reduce(function (m, s) { return Math.max(m, Number(String(s.site_id).replace(/\D/g, '')) || 0); }, 0);
  let nextUnit = units.reduce(function (m, u) { return Math.max(m, Number(String(u.unit_id).replace(/\D/g, '')) || 0); }, 0);
  const now = new Date();
  let added = 0, updated = 0, unitsAdded = 0;

  contracts.forEach(function (c) {
    const key = addrKey_(c.address);
    const parts = c.address.split(',');
    const fields = {
      name: parts[0].replace(/\(.*?\)/g, '').trim() || c.address, segment_id: 'COM', address: c.address,
      city: parts.length > 1 ? parts.slice(1).join(',').replace(/\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i, '').replace(/\bON\b/, '').replace(/[,\s]+$/, '').trim() : '',
      contact_name: c.contactName, contact_phone: c.contactPhone, contact_email: c.contactEmail,
      site_contact: c.siteContact, frequency: c.frequency, installation_no: c.installation,
      contract_expiry: c.expiry, contract_type: [c.contractType, c.term ? 'Term ' + c.term : ''].filter(String).join(' · '),
      contract_value: c.value, units_qty: c.qty, scheduled_week: c.week,
    };
    const hit = byKey[key];
    let siteId;
    if (!hit) {
      siteId = 'S' + ('0000' + (++nextSite)).slice(-4);
      appendRecord_('Sites', Object.assign({ site_id: siteId, created_at: now, created_by: 'Maintenance Record import',
                                            source: 'Maintenance Record', updated_at: now }, fields));
      byKey[key] = { site: Object.assign({ site_id: siteId, source: 'Maintenance Record' }, fields), row: sitesSheet.getLastRow() };
      added++;
    } else {
      siteId = hit.site.site_id;
      if (isTrue_(hit.site.archived)) return;          // removed by Kyle / Chris / Kaixin: never bring it back
      const imported = String(hit.site.source || '') === 'Maintenance Record';
      const changes = {};
      Object.keys(fields).forEach(function (k) {
        const now_ = fields[k] === undefined || fields[k] === null ? '' : fields[k];
        const was = hit.site[k] === undefined || hit.site[k] === null ? '' : hit.site[k];
        if (String(now_) === String(was)) return;
        if (imported ? now_ !== '' : was === '') changes[k] = now_;
      });
      if (Object.keys(changes).length) {
        changes.updated_at = now;
        writeRowFields_(sitesSheet, sHead, hit.row, changes);
        Object.assign(hit.site, changes);
        updated++;
      }
    }
    // One unit per installation number.
    (c.installation.match(/\d{4,}/g) || []).forEach(function (inst) {
      if (units.some(function (u) { return u.site_id === siteId && String(u.installation_no) === inst; })) return;
      const unit = { unit_id: 'U' + ('0000' + (++nextUnit)).slice(-4), site_id: siteId, label: 'Inst. #' + inst,
                     elevator_type: c.brand, stops: c.stops, installation_no: inst, source: 'Maintenance Record' };
      appendRecord_('Units', unit); units.push(unit); unitsAdded++;
    });
  });
  void uHead;
  return { added: added, updated: updated, units: unitsAdded };
}

/**
 * Rebuilds the "Maintenance Log" tab: one row per contract, one column per month. Each month shows what the
 * company sheet says, plus visits found in OA service reports (marked "OA"). Kyle can copy it back as needed.
 */
function buildMaintenanceLog_(contracts, year) {
  const sh = SpreadsheetApp.getActive().getSheetByName('Maintenance Log');
  const sites = readTable_('Sites');
  const siteFor = function (address) {
    const k = addrKey_(address);
    return sites.filter(function (s) { return addrKey_(s.address || s.name) === k; })[0] || {};
  };
  const reports = visibleReports_().filter(function (r) {
    return /maint/i.test(String(r.call_type)) && r.server_time instanceof Date && r.server_time.getFullYear() === year;
  });
  const rows = contracts.map(function (c) {
    const site = siteFor(c.address);
    const months = c.months.slice();
    reports.forEach(function (r) {
      const same = (site.site_id && r.site_id === site.site_id) || (addrKey_(r.site_name) && addrKey_(r.site_name) === addrKey_(c.address));
      if (!same) return;
      const m = r.server_time.getMonth();
      const note = r.tech_name + ' ' + MONTH_ABBR[m].charAt(0) + MONTH_ABBR[m].slice(1).toLowerCase() + ' ' + r.server_time.getDate() +
                   ' (OA ' + r.report_id + ')';
      if (months[m].indexOf(r.report_id) < 0) months[m] = months[m] ? months[m] + '\n' + note : note;
    });
    return [site.site_id || '', c.address, c.frequency, c.installation, c.week].concat(months);
  });
  const header = ['site_id', 'address', 'frequency', 'installation_no', 'scheduled_week'].concat(MONTH_ABBR);
  sh.clearContents();
  sh.getRange(1, 1, 1, header.length).setValues([header]);
  if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  sh.getRange(1, header.length + 2).setValue('Built ' + Utilities.formatDate(new Date(), getSettings_().TIMEZONE || 'America/Toronto', 'yyyy-MM-dd HH:mm') +
    ' from the company Maintenance Record + OA service reports. Rebuilt every hour — edit the company sheet, not this tab.');
  return { header: header, rows: rows };
}

// ───────────────────────────── Past maintenance visits (site history + calendar) ─────────────────────────────

const VISIT_STOP = ['done', 'and', 'maintenance', 'maintenanance', 'service', 'call', 'site', 'visit', 'repair', 'tssa', 'inspection',
  'inspecction', 'inspector', 'deficiences', 'deficiencies', 'cleared', 'completed', 'the', 'on', 'by', 'with', 'replaced', 'packing',
  'seals', 'shutdown', 'need', 'needs', 'ropes', 'replacement', 'invoice', 'sent', 'follow', 'up'];
const MONTH_WORDS = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*$/i;

/** Month cells like "Duke June 9", "Jayden done Jan 12", "02 Chris Duke" → dated visit events. */
function maintenanceVisits_(contracts, year, ctx) {
  const out = [];
  contracts.forEach(function (c) {
    c.months.forEach(function (cell, m) {
      const t = String(cell || '').trim();
      if (!t || /no response|not available|not access|no access|shutdown|won't|no mainten|cancel|^want|^will |^ask |let me know|call me|emailed|called|texted/i.test(t)) return;
      const names = [];
      (t.replace(/[_\-&,\/]/g, ' ').match(/[A-Za-z][A-Za-z']*/g) || []).forEach(function (w) {
        if (!/^[A-Z]/.test(w) || MONTH_WORDS.test(w) || VISIT_STOP.indexOf(w.toLowerCase()) >= 0 || w.length < 3) return;
        const n = w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
        if (names.indexOf(n) < 0) names.push(n);
      });
      if (!names.length) return;
      let day = 1, exact = false;
      const dm = /(?:^|[^\d])(\d{1,2})(?:st|nd|rd|th)?(?![\d\/])/.exec(t.replace(/20\d{2}/g, ' '));
      if (dm && Number(dm[1]) >= 1 && Number(dm[1]) <= 31) { day = Number(dm[1]); exact = true; }
      const date = new Date(year, m, Math.min(day, new Date(year, m + 1, 0).getDate()));
      const it = makeItem_(ctx, c.row, {
        kind: 'Maintenance visit', suffix: ':v' + m, person: names[0], date: date, addr: c.address,
        title: names.join(' & ') + ' · ' + c.address + (exact ? '' : ' (day not recorded)'),
        text: t + '\n' + c.frequency + ' maintenance · ' + c.address,
      });
      it.approx = !exact;
      out.push(it);
    });
  });
  return out;
}

// ───────────────────────────── Pipelines → tasks → 9:00 notifications ─────────────────────────────

function fillTemplate_(tpl, rec) {
  return String(tpl || '').replace(/\{(\w+)\}/g, function (m, k) { return rec[k] !== undefined ? String(rec[k]) : ''; });
}

/** Creates tasks for every active Pipelines rule that matches this event. */
function runPipelines_(trigger, record) {
  const rules = readTable_('Pipelines').filter(function (r) {
    if (!isTrue_(r.active) || String(r.trigger).trim() !== trigger) return false;
    const types = String(r.call_types || '').split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(String);
    return !types.length || types.indexOf(String(record.call_type || '').toLowerCase()) >= 0;
  });
  if (!rules.length) return [];
  let max = 0;
  readTable_('Tasks').forEach(function (t) { max = Math.max(max, Number(String(t.task_id).replace(/\D/g, '')) || 0); });
  return rules.map(function (r) {
    const task = {
      task_id: 'T' + ('00000' + (++max)).slice(-5), created_at: new Date(), rule_id: r.rule_id, type: r.task_type,
      title: fillTemplate_(r.title_template, record), ref_id: record.report_id || '', assign_roles: r.assign_roles,
      status: 'open', done_at: '', done_by: '', note: '',
    };
    appendRecord_('Tasks', task);
    return task;
  });
}

/** Runs every day at 9:00: writes the open tasks as one batch. The bell shows the newest batch. */
function refreshNotifications() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    try { processMailQueueCore_(200); } catch (err) { Logger.log('Mail queue: ' + err.message); }
    try { ensureMonthTasks_(); ensureOrderTasks_(); ensureProjectTasks_(); ensureMailTasks_(); } catch (err) { Logger.log('Reminders: ' + err.message); }
    let now = new Date();
    const last = PropertiesService.getScriptProperties().getProperty('NOTIFY_BATCH');
    if (last && new Date(last).getTime() >= now.getTime()) now = new Date(new Date(last).getTime() + 1000);  // batches never share a time
    const open = readTable_('Tasks').filter(function (t) { return String(t.status) === 'open'; });
    const rows = [];
    open.forEach(function (t) {
      String(t.assign_roles || '').split(',').map(function (x) { return x.trim(); }).filter(String).forEach(function (role) {
        rows.push([now, role, t.task_id, t.title, 'open']);
      });
    });
    if (!rows.length) rows.push([now, '*', '', 'No open tasks', 'none']);   // keeps a record that the 9:00 run happened
    const sh = SpreadsheetApp.getActive().getSheetByName('Notifications');
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
    PropertiesService.getScriptProperties().setProperty('NOTIFY_BATCH', now.toISOString());
    return rows.length;
  } finally {
    lock.releaseLock();
  }
}

function installNotificationTrigger_() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'refreshNotifications'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('refreshNotifications').timeBased().everyDays(1).atHour(9).nearMinute(0)
    .inTimezone(getSettings_().TIMEZONE || 'America/Toronto').create();
}

/** Latest batch (or the batch asked for) for this person's roles, with each task's current status. */
function notificationsFor_(user, batchAt) {
  const rows = readTable_('Notifications');
  const iso = function (d) { return d instanceof Date ? d.toISOString() : String(d); };
  const batches = [];
  rows.forEach(function (r) { const b = iso(r.batch_at); if (batches.indexOf(b) < 0) batches.push(b); });
  batches.sort().reverse();
  const want = batchAt || batches[0] || '';
  const tasks = {};
  readTable_('Tasks').forEach(function (t) { tasks[t.task_id] = t; });
  const mine = function (role) { return user.isAdmin || role === '*' || user.roles.indexOf(role) >= 0; };
  const seen = {};
  const items = rows.filter(function (r) { return iso(r.batch_at) === want && r.task_id && mine(String(r.role)); })
    .filter(function (r) { if (seen[r.task_id]) return false; seen[r.task_id] = true; return true; })
    .map(function (r) {
      const t = tasks[r.task_id] || {};
      return { task_id: r.task_id, title: r.title, ref_id: t.ref_id || '', type: t.type || '', created_at: t.created_at || '',
               key: t.key || '', link: t.link || '', amount: t.amount || '',
               status: t.status || r.status_at_batch, done_by: t.done_by || '', done_at: t.done_at || '', note: t.note || '',
               can_complete: user.isAdmin || String(t.assign_roles || '').split(',').some(function (x) { return user.roles.indexOf(x.trim()) >= 0; }) };
    });
  // The monthly maintenance list is one line per kind under the bell; the full checklist is on the This month page.
  const groups = {};
  const out = [];
  items.forEach(function (it) {
    const m = /^(MNT|MINV|MEML):(\d{4}-\d{2}):/.exec(it.key);
    if (!m) { out.push(it); return; }
    const g = groups[m[1] + m[2]] || (groups[m[1] + m[2]] = { task_id: '', group: true, type: it.type, ref_id: '', created_at: it.created_at,
      link: '#/month?m=' + m[2], can_complete: false, total: 0, open: 0, month: m[2], kind: m[1] });
    g.total++; if (it.status !== 'done') g.open++;
    if (g.total === 1) out.push(g);
  });
  const allTasks = readTable_('Tasks');
  Object.keys(groups).forEach(function (k) {
    const g = groups[k];
    const same = allTasks.filter(function (t) {
      return String(t.key).indexOf(g.kind + ':' + g.month + ':') === 0 &&
             (user.isAdmin || String(t.assign_roles || '').split(',').some(function (x) { return user.roles.indexOf(x.trim()) >= 0; }));
    });
    g.total = same.length;
    g.open = same.filter(function (t) { return String(t.status) === 'open'; }).length;
    const label = Utilities.formatDate(new Date(g.month + '-15T12:00:00'), 'America/Toronto', 'MMMM');
    g.status = g.open ? 'open' : 'done';
    g.title = g.kind === 'MNT' ? label + ' maintenance: ' + g.open + ' of ' + g.total + ' sites not done yet'
            : g.kind === 'MEML' ? label + ' residential booking emails: ' + g.open + ' of ' + g.total + ' not sent yet'
                               : label + ' maintenance invoices: ' + g.open + ' of ' + g.total + ' not sent yet';
  });
  return { batch_at: want, batches: batches.slice(0, 90), items: out };
}

function completeTask_(user, p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const all = readTable_('Tasks');
    const i = all.findIndex(function (t) { return t.task_id === p.task_id; });
    if (i < 0) throw new Error('Task ' + p.task_id + ' does not exist.');
    const t = all[i];
    const allowed = String(t.assign_roles || '').split(',').some(function (x) { return user.roles.indexOf(x.trim()) >= 0; });
    if (!user.isAdmin && !allowed) throw new Error('This task is for ' + t.assign_roles + '.');
    if (String(t.status) === 'done') return { task_id: t.task_id, status: 'done' };
    const sh = SpreadsheetApp.getActive().getSheetByName('Tasks');
    const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
    if (/^PSTEP:/.test(String(t.key)) && String(t.key).split(':')[3] === 'scope') throw new Error('Chris confirms this on the project page (work to do and materials).');
    if (/^PSTEP:/.test(String(t.key)) && String(t.key).split(':')[3] === 'choice') throw new Error('This step has choices (e.g. passed / not passed): pick one on the project page.');
    writeRowFields_(sh, head, i + 2, { status: 'done', done_at: new Date(), done_by: user.email, note: clean_(p.note, 500) });
    audit_(user.email, 'task.done', t.task_id, t.title + (p.note ? ' · ' + p.note : ''));
    // Ticking a project step's checkbox moves the project to its next step.
    if (/^PSTEP:/.test(String(t.key))) advanceProjectFromTask_(user, t, p.note);
    return { task_id: t.task_id, status: 'done' };
  } finally {
    lock.releaseLock();
  }
}

// ═════════════════════════════ Step 5: work tracking (orders, prices, projects, monthly maintenance, mail) ═════════════════════════════

const ORDER_STAGES_DEFAULT = 'Asked supplier|Supplier quoted|Confirmed with supplier|Pickup / delivery set|Received';

function tz_() { return getSettings_().TIMEZONE || 'America/Toronto'; }
function ym_(d) { return Utilities.formatDate(d || new Date(), tz_(), 'yyyy-MM'); }
function day_(d) { return d ? Utilities.formatDate(d instanceof Date ? d : new Date(d), tz_(), 'yyyy-MM-dd') : ''; }
function headersOf_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
}
function orderStages_() { return String(getSettings_().ORDER_STAGES || ORDER_STAGES_DEFAULT).split('|').map(function (s) { return s.trim(); }).filter(String); }
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}
/** Updates the row whose idColumn = id with the given fields. Returns the merged record. */
function updateRecord_(name, idColumn, id, fields) {
  const all = readTable_(name);
  const i = all.findIndex(function (r) { return String(r[idColumn]) === String(id); });
  if (i < 0) throw new Error(name + ' ' + id + ' does not exist.');
  writeRowFields_(SpreadsheetApp.getActive().getSheetByName(name), headersOf_(name), i + 2, fields);
  return Object.assign(all[i], fields);
}
function siteById_(id) { return readTable_('Sites').filter(function (s) { return s.site_id === id; })[0] || null; }
/** The site whose address matches this text (same rule as search: house number + street). */
function siteForText_(text, sites) {
  const k = addrKey_(text);
  if (!k) return null;
  return (sites || readTable_('Sites')).filter(function (s) { return !isTrue_(s.archived) && addrKey_(s.address || s.name) === k; })[0] || null;
}
function money_(v) { const n = Number(String(v === undefined ? '' : v).replace(/[$,\s]/g, '')); return isFinite(n) && String(v).trim() !== '' ? Math.round(n * 100) / 100 : ''; }

// ───────── tasks (shared by every reminder) ─────────

/** Creates each task whose key is new. Returns the tasks created. Call while holding the lock. */
function ensureTasks_(tasks) {
  if (!tasks.length) return [];
  const existing = readTable_('Tasks');
  const keys = {};
  existing.forEach(function (t) { if (t.key) keys[t.key] = true; });
  let max = 0;
  existing.forEach(function (t) { max = Math.max(max, Number(String(t.task_id).replace(/\D/g, '')) || 0); });
  const made = [];
  tasks.forEach(function (t) {
    if (t.key && keys[t.key]) return;
    keys[t.key] = true;
    const rec = Object.assign({ task_id: 'T' + ('00000' + (++max)).slice(-5), created_at: new Date(), status: 'open',
                                rule_id: '', ref_id: '', done_at: '', done_by: '', note: '' }, t);
    appendRecord_('Tasks', rec);
    made.push(rec);
  });
  return made;
}
/** Closes open tasks matching a test (system closes, e.g. visit found in the maintenance record). */
function closeTasks_(test, by, note) {
  const sh = SpreadsheetApp.getActive().getSheetByName('Tasks');
  const head = headersOf_('Tasks');
  let n = 0;
  readTable_('Tasks').forEach(function (t, i) {
    if (String(t.status) !== 'open' || !test(t)) return;
    writeRowFields_(sh, head, i + 2, { status: 'done', done_at: new Date(), done_by: by, note: note || '' });
    n++;
  });
  return n;
}
function reopenTask_(user, p) {
  return withLock_(function () {
    const t = readTable_('Tasks').filter(function (x) { return x.task_id === p.task_id; })[0];
    if (!t) throw new Error('Task ' + p.task_id + ' does not exist.');
    const allowed = String(t.assign_roles || '').split(',').some(function (x) { return user.roles.indexOf(x.trim()) >= 0; });
    if (!user.isAdmin && !allowed) throw new Error('This task is for ' + t.assign_roles + '.');
    updateRecord_('Tasks', 'task_id', p.task_id, { status: 'open', done_at: '', done_by: '', note: '' });
    audit_(user.email, 'task.reopen', t.task_id, t.title);
    return { task_id: t.task_id, status: 'open' };
  });
}

// ───────── monthly maintenance plan, reminders and invoice checklist ─────────

/** Technician names in a month cell ("Duke June 9", "Jayden done Jan 12") — empty if it is a note, not a visit. */
function visitNames_(cell) {
  const t = String(cell || '').trim();
  if (!t || /no response|not available|not access|no access|shutdown|won't|no mainten|cancel|^want|^will |^ask |let me know|call me|emailed|called|texted|follow up/i.test(t)) return [];
  const names = [];
  (t.replace(/[_\-&,\/]/g, ' ').match(/[A-Za-z][A-Za-z']*/g) || []).forEach(function (w) {
    if (!/^[A-Z]/.test(w) || MONTH_WORDS.test(w) || VISIT_STOP.indexOf(w.toLowerCase()) >= 0 || w.length < 3) return;
    const n = w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    if (names.indexOf(n) < 0) names.push(n);
  });
  return names;
}

const FREQ_STEP = { 'Monthly': 1, 'Quarterly': 3, 'Semi-annual': 6, 'Annual': 12 };

/**
 * Which months each contract is due. Monthly = every month. Quarterly / semi-annual: the months that match the
 * visits recorded this year and last year (e.g. Mar-Jun-Sep-Dec). Kaixin can override in due_months_override.
 */
function maintenancePlan_(byYear, year) {
  const now = byYear[year] || [];
  const prev = {};
  (byYear[year - 1] || []).forEach(function (c) { prev[addrKey_(c.address)] = c; });
  return now.map(function (c) {
    const step = FREQ_STEP[c.frequency] || 0;
    const done = [];
    c.months.forEach(function (cell, m) { if (visitNames_(cell).length) done.push(m); });
    let due = [], basis = '';
    if (step === 1) { due = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]; basis = 'monthly'; }
    else if (step) {
      const counts = {};
      const add = function (m) { counts[m % step] = (counts[m % step] || 0) + 1; };
      done.forEach(add);
      const old = prev[addrKey_(c.address)];
      if (old) old.months.forEach(function (cell, m) { if (visitNames_(cell).length) add(m); });
      let phase = 0, best = -1;
      Object.keys(counts).forEach(function (k) { if (counts[k] > best || (counts[k] === best && Number(k) < phase)) { best = counts[k]; phase = Number(k); } });
      for (let m = phase; m < 12; m += step) due.push(m);
      basis = best > 0 ? 'from visits ' + (old ? (year - 1) + '–' : '') + year : 'no visits recorded yet: assumed';
    }
    return { segment: c.segment || 'COM', package: c.contractType || '', address: c.address, frequency: c.frequency, due: due, done: done, basis: basis, value: c.value, qty: c.qty,
             contact_name: c.contactName, contact_email: c.contactEmail, contact_phone: c.contactPhone, months: c.months };
  });
}

/** Rewrites the "Maintenance Plan" tab, keeping Kaixin's due_months_override per address. */
function writeMaintenancePlan_(plan, year) {
  const sh = SpreadsheetApp.getActive().getSheetByName('Maintenance Plan');
  const sites = readTable_('Sites');
  const overrides = {};
  readTable_('Maintenance Plan').forEach(function (r) { if (String(r.due_months_override || '').trim()) overrides[addrKey_(r.address)] = String(r.due_months_override).trim(); });
  // OA maintenance reports also count as done.
  const reports = visibleReports_().filter(function (r) {
    return /maint/i.test(String(r.call_type)) && r.server_time instanceof Date && r.server_time.getFullYear() === year;
  });
  const names = function (ms) { return ms.map(function (m) { return MONTH_ABBR[m].charAt(0) + MONTH_ABBR[m].slice(1).toLowerCase(); }).join(','); };
  const head = headersOf_('Maintenance Plan');
  const rows = plan.map(function (p) {
    const site = siteForText_(p.address, sites) || {};
    const done = p.done.slice();
    reports.forEach(function (r) {
      const same = (site.site_id && r.site_id === site.site_id) || (addrKey_(r.site_name) && addrKey_(r.site_name) === addrKey_(p.address));
      if (same && done.indexOf(r.server_time.getMonth()) < 0) done.push(r.server_time.getMonth());
    });
    done.sort(function (a, b) { return a - b; });
    const rec = { segment: p.segment, package: p.package, site_id: site.site_id || '', address: p.address, frequency: p.frequency, due_months: names(p.due),
                  due_months_override: overrides[addrKey_(p.address)] || '', basis: p.basis, value: p.value, qty: p.qty,
                  contact_name: p.contact_name, contact_email: p.contact_email, contact_phone: p.contact_phone,
                  done_months: names(done), year: year, updated_at: new Date() };
    return head.map(function (h) { return rec[h] === undefined ? '' : rec[h]; });
  });
  sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), head.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
  return rows.length;
}

/** Stable id of a contract in task keys: its address key (stays the same if the site is removed and added back). */
function planId_(r) { return addrKey_(r.address).replace(/\s/g, '-'); }

function monthList_(text) {
  return String(text || '').split(/[,\s]+/).map(function (m) { return MONTH_ABBR.indexOf(m.slice(0, 3).toUpperCase()); })
    .filter(function (m) { return m >= 0; });
}

/** For the month (default: this month): one maintenance reminder + one invoice checkbox per site due. */
function ensureMonthTasks_(when) {
  const d = when || new Date();
  const ym = ym_(d);
  const m = Number(ym.slice(5, 7)) - 1;
  const monthName = Utilities.formatDate(d, tz_(), 'MMMM');
  const s = getSettings_();
  const roles = s.MAINT_REMINDER_ROLES || 'office';
  const hst = Number(s.HST_RATE || 13);
  // Sites Kyle / Chris / Kaixin removed from the Sites list get no more reminders.
  const removed = {};
  readTable_('Sites').forEach(function (x) { if (isTrue_(x.archived)) removed[addrKey_(x.address || x.name)] = true; });
  const plan = readTable_('Maintenance Plan').filter(function (r) { return Number(r.year) === Number(ym.slice(0, 4)) && !removed[addrKey_(r.address)]; });
  const tasks = [];
  plan.forEach(function (r) {
    const due = monthList_(r.due_months_override || r.due_months);
    if (due.indexOf(m) < 0) return;
    const id = planId_(r);
    const value = money_(r.value);
    if (String(r.segment) === 'RES') {
      const rr = s.RES_MAINT_ROLES || roles;
      tasks.push({ key: 'MNT:' + ym + ':' + id, type: 'Maintenance', month: ym, site_id: r.site_id, assign_roles: rr,
                   title: monthName + ' residential maintenance due · ' + r.address + ' (' + r.frequency + ')', link: '#/month' });
      tasks.push({ key: 'MEML:' + ym + ':' + id, type: 'Residential email', month: ym, site_id: r.site_id, assign_roles: rr,
                   title: 'Email ' + (r.contact_name || 'the customer') + ' to book ' + monthName + ' maintenance · ' + r.address, link: '#/month' });
      return;
    }
    tasks.push({ key: 'MNT:' + ym + ':' + id, type: 'Maintenance', month: ym, site_id: r.site_id, assign_roles: roles,
                 title: monthName + ' maintenance due · ' + r.address + ' (' + r.frequency + ')', link: r.site_id ? '#/sites/' + r.site_id : '' });
    tasks.push({ key: 'MINV:' + ym + ':' + id, type: 'Maintenance invoice', month: ym, site_id: r.site_id, assign_roles: roles, amount: value,
                 title: 'Send ' + monthName + ' maintenance invoice · ' + r.address +
                        (value !== '' ? ' · $' + value.toFixed(2) + ' + HST ' + hst + '% = $' + (value * (1 + hst / 100)).toFixed(2) : ''),
                 link: '#/month' });
  });
  const made = ensureTasks_(tasks);
  // A visit written in the maintenance record (or an OA maintenance report) ticks the reminder off.
  const doneKeys = {};
  plan.forEach(function (r) { if (monthList_(r.done_months).indexOf(m) >= 0) doneKeys['MNT:' + ym + ':' + planId_(r)] = true; });
  const closed = closeTasks_(function (t) { return doneKeys[t.key]; }, 'Maintenance Record', 'Visit recorded');
  return { month: ym, created: made.length, closed: closed };
}

/** Everything for the "This month" page. */
function monthChecklist_(user, ym) {
  const month = /^\d{4}-\d{2}$/.test(String(ym || '')) ? ym : ym_();
  const mine = function (t) { return user.isAdmin || String(t.assign_roles || '').split(',').some(function (x) { return user.roles.indexOf(x.trim()) >= 0; }); };
  const all = readTable_('Tasks').filter(function (t) { return /^(MNT|MINV|MEML):/.test(String(t.key)) && mine(t); });
  const months = unique_(all.map(function (t) { return String(t.month || String(t.key).split(':')[1]); })).sort().reverse();
  const plan = {};
  readTable_('Maintenance Plan').forEach(function (r) { plan[planId_(r)] = r; });
  const items = all.filter(function (t) { return String(t.key).split(':')[1] === month; }).map(function (t) {
    const p = plan[String(t.key).split(':')[2]] || {};
    return { task_id: t.task_id, type: t.type, title: t.title, status: t.status, done_by: t.done_by, done_at: t.done_at, note: t.note,
             site_id: t.site_id || p.site_id || '', address: p.address || '', frequency: p.frequency || '', amount: t.amount,
             contact_name: p.contact_name || '', contact_email: p.contact_email || '', contact_phone: p.contact_phone || '',
             due_months: p.due_months_override || p.due_months || '', basis: p.basis || '', segment: p.segment || 'COM', package: p.package || '' };
  });
  const tpl = readTable_('Email Templates').filter(function (x) { return x.template_id === 'RES_MAINT'; })[0] || {};
  const box = readTable_('Mailboxes').filter(function (b) { return /project/i.test(String(b.purpose)); })[0] || {};
  return { month: month, months: months.length ? months : [month], hst: Number(getSettings_().HST_RATE || 13), items: items,
           template: { subject: tpl.subject || '', body: String(tpl.body || '').replace(/\\n/g, '\n') }, sendFrom: box.mailbox || 'pm@krysnorelevator.ca' };
}

// ───────── orders, supplier quotes and part prices ─────────

function saveOrder_(user, p) {
  return withLock_(function () {
    const site = p.site_id ? siteById_(p.site_id) : siteForText_(p.site_name);
    const fields = {
      title: clean_(p.title, 300), supplier: clean_(p.supplier, 200), site_id: site ? site.site_id : '',
      site_name: clean_(p.site_name || (site ? site.name : ''), 300), project_id: clean_(p.project_id, 40),
      delivery_method: clean_(p.delivery_method, 40), notes: clean_(p.notes, 3000), updated_at: new Date(),
    };
    fields.addr_key = addrKey_(fields.site_name) || (site ? addrKey_(site.address || site.name) : '');
    if (!fields.title) throw new Error('What is being ordered? (title is required)');
    if (p.order_id) {
      const o = updateRecord_('Orders', 'order_id', p.order_id, fields);
      audit_(user.email, 'order.update', p.order_id, fields.title);
      return { order: o };
    }
    const stages = orderStages_();
    const rec = Object.assign({ order_id: nextId_('Orders', 'order_id', 'ORD', 4), created_at: new Date(), created_by: user.email,
                                stage: stages[0], stage_at: new Date(), mail_thread_ids: clean_(p.mail_thread_id, 200) }, fields);
    appendRecord_('Orders', rec);
    appendRecord_('Order Events', { order_id: rec.order_id, at: new Date(), stage: rec.stage, by: user.email,
                                    note: clean_(p.first_note, 1000) || 'Order opened', mail_id: clean_(p.mail_id, 100) });
    if (p.mail_id) linkMailRow_(p.mail_id, 'order', rec.order_id);
    audit_(user.email, 'order.create', rec.order_id, rec.title);
    return { order: rec };
  });
}

/** Moves an order to a stage (or just adds a note) with the date/amount that stage needs. */
function orderStep_(user, p) {
  return withLock_(function () {
    const o = readTable_('Orders').filter(function (x) { return x.order_id === p.order_id; })[0];
    if (!o) throw new Error('Order ' + p.order_id + ' does not exist.');
    const stages = orderStages_().concat(['Cancelled']);
    const stage = clean_(p.stage, 60);
    if (stage && stages.indexOf(stage) < 0) throw new Error('Unknown stage: ' + stage);
    const fields = { updated_at: new Date() };
    if (stage && stage !== o.stage) { fields.stage = stage; fields.stage_at = new Date(); }
    if (p.quote_amount !== undefined && String(p.quote_amount).trim() !== '') fields.quote_amount = money_(p.quote_amount);
    if (p.quote_ref) fields.quote_ref = clean_(p.quote_ref, 100);
    if (p.ready_date) fields.ready_date = clean_(p.ready_date, 20);
    if (p.delivery_method) fields.delivery_method = clean_(p.delivery_method, 40);
    if (p.mail_thread_id) fields.mail_thread_ids = unique_(String(o.mail_thread_ids || '').split(',').concat([p.mail_thread_id])).join(',');
    updateRecord_('Orders', 'order_id', o.order_id, fields);
    const ev = { order_id: o.order_id, at: new Date(), stage: stage || '', by: user.email, note: clean_(p.note, 2000),
                 amount: fields.quote_amount !== undefined ? fields.quote_amount : '', date_value: fields.ready_date || '', mail_id: clean_(p.mail_id, 100) };
    appendRecord_('Order Events', ev);
    if (p.mail_id) linkMailRow_(p.mail_id, 'order', o.order_id);
    // Reminders for the stage it left are no longer needed.
    if (fields.stage) closeTasks_(function (t) { return /^ORD/.test(String(t.key)) && String(t.key).split(':')[1] === o.order_id; }, user.email, 'Order moved to ' + fields.stage);
    audit_(user.email, 'order.step', o.order_id, (stage || 'note') + (p.note ? ' · ' + p.note : ''));
    return { order: Object.assign(o, fields), event: ev };
  });
}

/** Part prices: one row per part line, so next time we know our cost without asking the supplier again. */
function savePrices_(user, p) {
  return withLock_(function () {
    const lines = (p.lines || []).filter(function (l) { return clean_(l.part, 300) && String(l.unit_price || '').trim() !== ''; });
    if (!lines.length) throw new Error('Add at least one part with a unit price.');
    let max = 0;
    readTable_('Part Prices').forEach(function (r) { max = Math.max(max, Number(String(r.price_id).replace(/\D/g, '')) || 0); });
    const out = lines.map(function (l) {
      const qty = Number(l.qty) || 1, unit = money_(l.unit_price);
      if (unit === '') throw new Error('Unit price for "' + l.part + '" is not a number.');
      const rec = { price_id: 'P' + ('00000' + (++max)).slice(-5), date: clean_(p.date || l.date, 20) || day_(new Date()),
                    supplier: clean_(p.supplier || l.supplier, 200), part: clean_(l.part, 300), part_no: clean_(l.part_no, 100),
                    qty: qty, unit: clean_(l.unit, 20) || 'ea', unit_price: unit, total: Math.round(qty * unit * 100) / 100,
                    currency: clean_(p.currency, 5) || 'CAD', order_id: clean_(p.order_id, 40), site_name: clean_(p.site_name, 300),
                    status: clean_(p.status || l.status, 20) || 'quoted', note: clean_(l.note, 500), entered_by: user.email, entered_at: new Date() };
      appendRecord_('Part Prices', rec);
      return rec;
    });
    audit_(user.email, 'prices.add', p.order_id || '', out.length + ' lines');
    return { prices: out };
  });
}

function saveSupplier_(user, p) {
  return withLock_(function () {
    const name = clean_(p.name, 200);
    if (!name) throw new Error('Supplier name is required.');
    const all = readTable_('Suppliers');
    const hit = all.filter(function (s) { return norm_(s.name) === norm_(name); })[0];
    const fields = { name: name, contact: clean_(p.contact, 200), email: clean_(p.email, 200), phone: clean_(p.phone, 50),
                     email_domain: clean_(p.email_domain || String(p.email || '').split('@')[1] || '', 100).toLowerCase(),
                     parts: clean_(p.parts, 500), notes: clean_(p.notes, 1000), updated_at: new Date() };
    if (hit) { updateRecord_('Suppliers', 'name', hit.name, fields); return { supplier: Object.assign(hit, fields) }; }
    appendRecord_('Suppliers', fields);
    audit_(user.email, 'supplier.add', name, fields.email);
    return { supplier: fields };
  });
}

/** Daily: remind about orders that are waiting on someone. */
function ensureOrderTasks_() {
  const s = getSettings_();
  const roles = s.ORDER_REMINDER_ROLES || 'office';
  const chase = Number(s.ORDER_CHASE_DAYS || 3);
  const stages = orderStages_();
  const now = new Date();
  const today = day_(now);
  const tomorrow = day_(new Date(now.getTime() + 86400000));
  const tasks = [];
  readTable_('Orders').forEach(function (o) {
    if (o.stage === 'Cancelled' || o.stage === stages[stages.length - 1]) return;
    const since = o.stage_at instanceof Date ? o.stage_at : new Date(o.stage_at);
    const days = Math.floor((now - since) / 86400000);
    const where = o.site_name ? ' · ' + o.site_name : '';
    if (o.stage === stages[0] && days >= chase) {
      tasks.push({ key: 'ORDCHASE:' + o.order_id + ':' + day_(since), type: 'Order', assign_roles: roles, ref_id: o.order_id, link: '#/orders/' + o.order_id,
                   title: 'No quote yet from ' + (o.supplier || 'supplier') + ' (' + days + ' days): ' + o.title + where });
    }
    if (o.stage === stages[1] && days >= chase) {
      tasks.push({ key: 'ORDCONF:' + o.order_id + ':' + day_(since), type: 'Order', assign_roles: roles, ref_id: o.order_id, link: '#/orders/' + o.order_id,
                   title: 'Quote received ' + days + ' days ago, not confirmed yet: ' + o.title + where });
    }
    const ready = day_(o.ready_date instanceof Date ? o.ready_date : (o.ready_date ? new Date(String(o.ready_date) + 'T12:00:00') : null));
    if (ready && ready <= tomorrow) {
      tasks.push({ key: 'ORDREADY:' + o.order_id + ':' + ready, type: 'Order', assign_roles: roles, ref_id: o.order_id, link: '#/orders/' + o.order_id,
                   title: (o.delivery_method || 'Pickup / delivery') + (ready < today ? ' was due ' : ready === today ? ' today ' : ' tomorrow ') +
                          ready + ': ' + o.title + ' (' + (o.supplier || 'supplier') + ')' + where });
    }
  });
  return ensureTasks_(tasks).length;
}

// ───────── projects (installation flow) ─────────

function projectStages_(typeId, segmentId) {
  return readTable_('Project Stages').filter(function (r) {
    const seg = String(r.segments || 'ALL').trim().toUpperCase();
    return r.type_id === typeId && (seg === 'ALL' || seg === String(segmentId || '').toUpperCase());
  }).sort(function (a, b) { return Number(a.order) - Number(b.order); });
}

function saveProject_(user, p) {
  return withLock_(function () {
    const title = clean_(p.title, 200);
    if (!title) throw new Error('Project title is required.');
    const types = readTable_('Project Types').map(function (t) { return t.type_id; });
    if (types.indexOf(p.type_id) < 0) throw new Error('Pick a project type.');
    const site = p.site_id ? siteById_(p.site_id) : siteForText_(p.site_name);
    const fields = { title: title, site_id: site ? site.site_id : '', site_name: clean_(p.site_name || (site ? site.name : ''), 300),
                     customer: clean_(p.customer, 200), contact: clean_(p.contact, 300), value: money_(p.value),
                     notes: clean_(p.notes, 3000), updated_at: new Date() };
    fields.addr_key = addrKey_(fields.site_name);
    if (p.payment_plan !== undefined) fields.payment_plan = checkPlan_(p.payment_plan, p.type_id, p.segment_id);
    if (p.project_id) {
      const pr = updateRecord_('Projects', 'project_id', p.project_id, fields);
      ensureProjectInvoices_(pr);
      audit_(user.email, 'project.update', p.project_id, title + (fields.payment_plan ? ' · plan ' + fields.payment_plan : ''));
      return { project: pr };
    }
    const type = readTable_('Project Types').filter(function (t) { return t.type_id === p.type_id; })[0];
    const segment = p.segment_id || (site ? site.segment_id : 'COM');
    const id = nextId_('Projects', 'project_id', String(type.id_prefix || type.type_id), 3);
    const stages = projectStages_(p.type_id, segment);
    let folderId = '', folderUrl = '';
    try { const f = createProjectFolder_(p.type_id, segment, id, title); folderId = f.getId(); folderUrl = f.getUrl(); }
    catch (err) { fields.notes = (fields.notes ? fields.notes + '\n' : '') + 'Folder not created: ' + err.message; }
    const rec = Object.assign({ project_id: id, type_id: p.type_id, segment_id: segment, status: 'open', owner_email: user.email,
                                folder_id: folderId, folder_url: folderUrl, created_at: new Date(), created_by: user.email,
                                stage: stages.length ? stages[0].stage : '', stage_at: new Date() }, fields);
    appendRecord_('Projects', rec);
    appendRecord_('Project Events', { project_id: id, at: new Date(), stage: rec.stage, by: user.email, note: clean_(p.first_note, 1000) || 'Project opened' });
    ensureStepTask_(rec);
    if (p.mail_id) linkMailRow_(p.mail_id, 'project', id);
    audit_(user.email, 'project.create', id, title);
    return { project: rec };
  });
}

function projectStep_(user, p) { return withLock_(function () { return projectStepCore_(user, p); }); }
function projectStepCore_(user, p) {
  return (function () {
    const pr = readTable_('Projects').filter(function (x) { return x.project_id === p.project_id; })[0];
    if (!pr) throw new Error('Project ' + p.project_id + ' does not exist.');
    const names = projectStages_(pr.type_id, pr.segment_id).map(function (s) { return s.stage; }).concat(['Lost / cancelled']);
    const stage = clean_(p.stage, 80);
    if (stage && names.indexOf(stage) < 0) throw new Error('Unknown stage: ' + stage);
    // Every quote goes to Chris first: no one but the admin moves past his step before the work and materials are written.
    if (stage && stage !== 'Lost / cancelled' && !user.isAdmin && !String(pr.scope || '').trim() && !p.scopeConfirmed) {
      const sc = projectStages_(pr.type_id, pr.segment_id).filter(function (x) { return String(x.form) === 'scope'; })[0];
      if (sc && names.indexOf(stage) > names.indexOf(sc.stage)) throw new Error('Chris needs to confirm the work and materials first (step "' + sc.stage + '").');
    }
    const fields = { updated_at: new Date() };
    if (stage && stage !== pr.stage) {
      fields.stage = stage; fields.stage_at = new Date();
      if (stage === names[names.length - 2] || stage === 'Lost / cancelled') fields.status = 'closed';
      else fields.status = 'open';
    }
    updateRecord_('Projects', 'project_id', pr.project_id, fields);
    appendRecord_('Project Events', { project_id: pr.project_id, at: new Date(), stage: stage || '', by: user.email, note: clean_(p.note, 2000), mail_id: clean_(p.mail_id, 100) });
    if (p.mail_id) linkMailRow_(p.mail_id, 'project', pr.project_id);
    if (fields.stage) closeTasks_(function (t) { return /^PRJ/.test(String(t.key)) && String(t.key).split(':')[1] === pr.project_id; }, user.email, 'Moved to ' + fields.stage);
    if (fields.stage) ensureProjectInvoices_(Object.assign({}, pr, fields));
    if (fields.stage) {
      // The step it left: its checkbox is no longer needed. The step it entered: give that role its checkbox.
      closeTasks_(function (t) { return /^PSTEP:/.test(String(t.key)) && String(t.key).split(':')[1] === pr.project_id; }, user.email, 'Moved to ' + fields.stage);
      ensureStepTask_(Object.assign({}, pr, fields));
    }
    audit_(user.email, 'project.step', pr.project_id, (stage || 'note') + (p.note ? ' · ' + p.note : ''));
    return { project: Object.assign(pr, fields) };
  })();
}

/** Daily: "quote sent 7 days ago, follow up" and any other stage with follow_up_days. */
function ensureProjectTasks_() {
  readTable_('Projects').forEach(function (pr) { try { ensureProjectInvoices_(pr); } catch (e) { Logger.log(pr.project_id + ': ' + e.message); } });
  const roles = getSettings_().PROJECT_REMINDER_ROLES || 'office';
  const now = new Date();
  const tasks = [];
  readTable_('Projects').forEach(function (pr) {
    if (String(pr.status) === 'closed' || !pr.stage) return;
    const st = projectStages_(pr.type_id, pr.segment_id).filter(function (s) { return s.stage === pr.stage; })[0];
    const days = st ? Number(st.follow_up_days || 0) : 0;
    if (!days) return;
    const since = pr.stage_at instanceof Date ? pr.stage_at : new Date(pr.stage_at);
    const age = Math.floor((now - since) / 86400000);
    if (age < days) return;
    tasks.push({ key: 'PRJFU:' + pr.project_id + ':' + pr.stage + ':' + day_(since), type: 'Follow up', assign_roles: roles,
                 ref_id: pr.project_id, link: '#/projects/' + pr.project_id,
                 title: (st.reminder || 'Follow up') + ': ' + pr.title + (pr.site_name ? ' · ' + pr.site_name : '') + ' (' + pr.stage + ' ' + age + ' days ago)' });
  });
  return ensureTasks_(tasks).length;
}

// ───────── mail from Kyle's mailbox (sent by the read-only collector in his own account) ─────────

/** Called by the collector script. Not signed in with Google: checked with the mailbox key instead. */
function ingestMail_(body) {
  const box = readTable_('Mailboxes').filter(function (m) { return norm_(m.mailbox) === norm_(body.mailbox) && isTrue_(m.active); })[0];
  if (!box || !String(box.key || '').trim() || String(box.key).trim() !== String(body.key || '').trim()) throw new Error('Mailbox not allowed.');
  if (body.action === 'mailConfig') {
    const q = mailQuery_();
    return { query: isTrue_(box.track_all_sent) ? '(in:sent OR ' + q + ')' : q, lookbackDays: Number(getSettings_().MAIL_LOOKBACK_DAYS || 3),
             watch: watchedThreads_(norm_(body.mailbox)) };
  }
  // Put the mail in the queue right away (appendRow needs no lock), then try to process it now.
  // If the sheet is busy (e.g. the hourly sync), the 10-minute job processes it — the collector never has to wait.
  const q = SpreadsheetApp.getActive().getSheetByName('Mail Queue');
  const mb = norm_(body.mailbox), now = new Date();
  let queued = 0;
  (body.messages || []).slice(0, 200).forEach(function (m) { q.appendRow([now, mb, 'message', JSON.stringify(m)]); queued++; });
  (body.threads || []).slice(0, 300).forEach(function (t) { q.appendRow([now, mb, 'thread', JSON.stringify(t)]); queued++; });
  const processed = processMailQueue_(8000);
  return { added: queued, queued: queued, processed_now: processed };
}

/** Takes the write lock (waiting up to waitMs) and processes queued mail in small rounds. Returns rows processed. */
function processMailQueue_(waitMs) {
  const started = Date.now();
  let total = 0, n = 0;
  do {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(total ? 2000 : (waitMs || 20000))) break;
    try { n = processMailQueueCore_(25); } finally { lock.releaseLock(); }
    total += n;
  } while (n > 0 && Date.now() - started < 20000);
  return total;
}
/** Every 10 minutes (trigger): anything still in the queue. */
function processMailQueue() {
  const started = Date.now();
  let n = 0;
  do { n = processMailQueue_(30000); } while (n > 0 && Date.now() - started < 240000);
}
/** Call while holding the script lock. */
function processMailQueueCore_(max) {
  const sh = SpreadsheetApp.getActive().getSheetByName('Mail Queue');
  if (!sh) return 0;
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const n = Math.min(last - 1, max || 25);
  const rows = sh.getRange(2, 1, n, 4).getValues();
  const boxes = {};
  readTable_('Mailboxes').forEach(function (b) { boxes[norm_(b.mailbox)] = b; });
  const byBox = {};
  rows.forEach(function (r) {
    let p; try { p = JSON.parse(r[3]); } catch (e) { Logger.log('Mail queue: unreadable row skipped'); return; }
    const k = norm_(r[1]);
    const g = byBox[k] || (byBox[k] = { messages: [], threads: [] });
    (r[2] === 'thread' ? g.threads : g.messages).push(p);
  });
  Object.keys(byBox).forEach(function (k) { if (boxes[k] && isTrue_(boxes[k].active)) ingestCore_(boxes[k], byBox[k]); });
  if (n >= sh.getMaxRows() - 1) sh.insertRowAfter(sh.getMaxRows());   // Sheets refuses to delete every row below the header
  sh.deleteRows(2, n);   // new mail is only ever added below, so these are exactly the rows just read
  return n;
}

function installMailQueueTrigger_() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'processMailQueue'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('processMailQueue').timeBased().everyMinutes(10).create();
}

/** Saves queued messages / conversation timings for one mailbox. Call while holding the script lock. */
function ingestCore_(box, body) {
  return (function () {
    const have = {};
    readTable_('Mail').forEach(function (m) { have[String(m.mail_id)] = true; });
    const rules = readTable_('Mail Rules').filter(function (r) { return isTrue_(r.active) && r.pattern; });
    const suppliers = readTable_('Suppliers');
    const sites = readTable_('Sites');
    const orders = readTable_('Orders');
    const added = [];
    const tasks = [];
    (body.messages || []).slice(0, 200).forEach(function (msg) {
      const id = clean_(msg.id, 100);
      if (!id || have[id]) return;
      have[id] = true;
      const subject = clean_(msg.subject, 300), from = clean_(msg.from, 300), excerpt = clean_(msg.excerpt, 2000);
      const text = subject + '\n' + excerpt;
      const cats = [];
      rules.forEach(function (r) {
        let re; try { re = new RegExp(String(r.pattern), 'i'); } catch (e) { return; }
        const where = String(r.where || 'any').toLowerCase();
        const hay = where === 'subject' ? subject : where === 'from' ? from : text;
        if (re.test(hay) && cats.indexOf(r.category) < 0) cats.push(r.category);
      });
      const fromDomain = ((/@([\w.-]+)/.exec(from) || [])[1] || '').toLowerCase();
      const supplier = suppliers.filter(function (s) { return s.email_domain && fromDomain && fromDomain.slice(-String(s.email_domain).length) === String(s.email_domain).toLowerCase(); })[0];
      if (supplier && cats.indexOf('Order') < 0) cats.push('Order');
      const site = siteForText_(text, sites);
      const thread = clean_(msg.threadId, 100);
      const order = orders.filter(function (o) { return thread && String(o.mail_thread_ids || '').split(',').indexOf(thread) >= 0; })[0];
      const rec = {
        mail_id: id, thread_id: thread, mailbox: norm_(box.mailbox), received_at: msg.date ? new Date(msg.date) : new Date(),
        direction: msg.direction === 'out' ? 'out' : 'in', from: from, to: clean_(msg.to, 500), subject: subject,
        snippet: clean_(msg.snippet, 300), excerpt: excerpt, categories: cats.join(','), supplier: supplier ? supplier.name : '',
        site_id: site ? site.site_id : '', site_name: site ? site.name : '', addr_key: addrKey_(text),
        amounts: unique_((text.match(/\$\s?\d[\d,]*(\.\d{2})?/g) || []).map(function (a) { return a.replace(/\s/g, ''); })).slice(0, 6).join(' '),
        attachments: clean_((msg.attachments || []).join(', '), 500),
        link: 'https://mail.google.com/mail/u/?authuser=' + encodeURIComponent(norm_(box.mailbox)) + '#all/' + thread,
        ingested_at: new Date(), linked_type: order ? 'order' : '', linked_id: order ? order.order_id : '', status: 'new',
      };
      appendRecord_('Mail', rec);
      added.push(rec);
      if (msg.thread) updateThread_(box, msg.thread, rec);
      if (order) appendRecord_('Order Events', { order_id: order.order_id, at: rec.received_at, stage: '', by: rec.mailbox,
                                                 note: (rec.direction === 'out' ? 'Email sent: ' : 'Email from ' + from + ': ') + subject, mail_id: id });
      rules.forEach(function (r) {
        if (!isTrue_(r.create_task) || cats.indexOf(r.category) < 0 || rec.direction === 'out') return;
        tasks.push({ key: 'MAIL:' + r.category + ':' + (thread || id), type: r.category + ' email', assign_roles: r.assign_roles || 'office',
                     ref_id: id, link: rec.link, site_id: rec.site_id,
                     title: r.category + ' email · ' + subject + ' — ' + from.replace(/<.*>/, '').trim() + (rec.site_name ? ' · ' + rec.site_name : '') });
      });
    });
    ensureTasks_(tasks);
    (body.threads || []).forEach(function (th) { updateThread_(box, th, null); });
    ensureMailTasks_();
    const sh = SpreadsheetApp.getActive().getSheetByName('Mailboxes');
    const i = readTable_('Mailboxes').findIndex(function (m) { return norm_(m.mailbox) === norm_(box.mailbox); });
    writeRowFields_(sh, headersOf_('Mailboxes'), i + 2, { last_ingest: new Date(), last_count: added.length });
    return { added: added.length };
  })();
}

/** Gmail search the collector runs: the keyword terms of every active rule, plus supplier domains. */
function mailQuery_() {
  const terms = [];
  readTable_('Mail Rules').forEach(function (r) { if (isTrue_(r.active) && r.gmail_terms) terms.push('(' + String(r.gmail_terms).trim() + ')'); });
  readTable_('Suppliers').forEach(function (s) { if (s.email_domain) terms.push('from:' + String(s.email_domain).trim()); });
  return '(' + (terms.length ? terms.join(' OR ') : 'quote OR estimate') + ') -category:promotions -category:social';
}

function linkMailRow_(mailId, type, id) {
  const all = readTable_('Mail');
  const i = all.findIndex(function (m) { return String(m.mail_id) === String(mailId); });
  if (i < 0) return;
  writeRowFields_(SpreadsheetApp.getActive().getSheetByName('Mail'), headersOf_('Mail'), i + 2, { linked_type: type, linked_id: id, status: 'linked' });
  if (type === 'order' && all[i].thread_id) {
    const o = readTable_('Orders').filter(function (x) { return x.order_id === id; })[0];
    if (o) updateRecord_('Orders', 'order_id', id, { mail_thread_ids: unique_(String(o.mail_thread_ids || '').split(',').concat([all[i].thread_id])).join(',') });
  }
}

function linkMail_(user, p) {
  return withLock_(function () {
    if (p.ignore) { updateRecordIf_('Mail', 'mail_id', p.mail_id, { status: 'ignored' }); return { mail_id: p.mail_id, status: 'ignored' }; }
    if (['order', 'project', 'site'].indexOf(p.type) < 0) throw new Error('Link to an order, a project or a site.');
    linkMailRow_(p.mail_id, p.type, clean_(p.id, 40));
    audit_(user.email, 'mail.link', p.mail_id, p.type + ' ' + p.id);
    return { mail_id: p.mail_id, linked_type: p.type, linked_id: p.id };
  });
}
function updateRecordIf_(name, col, id, fields) { try { return updateRecord_(name, col, id, fields); } catch (e) { return null; } }

/** One payload for the Orders / Prices / Projects / Mail pages (cached on the phone for offline viewing). */
function workData_(user) {
  const out = { stages: { order: orderStages_() }, permissions: user.permissions };
  const iso = function (r) { const o = {}; Object.keys(r).forEach(function (k) { o[k] = r[k] instanceof Date ? r[k].toISOString() : r[k]; }); return o; };
  if (can_(user, 'order.view')) {
    out.orders = readTable_('Orders').map(iso);
    out.orderEvents = readTable_('Order Events').map(iso);
    out.prices = readTable_('Part Prices').map(iso);
    out.suppliers = readTable_('Suppliers').map(iso);
  }
  if (can_(user, 'project.create')) out.suggestions = readTable_('Project Suggestions').filter(function (x) { return x.status === 'new'; }).map(iso);
  if (can_(user, 'project.view')) {
    out.projects = readTable_('Projects').map(iso);
    out.projectEvents = readTable_('Project Events').map(iso);
    out.projectStages = readTable_('Project Stages').map(iso);
  }
  if (can_(user, 'mail.view')) {
    const days = Number(getSettings_().MAIL_KEEP_DAYS_IN_OA || 120);
    const since = Date.now() - days * 86400000;
    out.mail = readTable_('Mail').filter(function (m) { return new Date(m.received_at).getTime() >= since; }).map(function (m) {
      const o = iso(m); return o;
    }).sort(function (a, b) { return String(b.received_at).localeCompare(String(a.received_at)); }).slice(0, 600);
    out.mailboxes = readTable_('Mailboxes').map(function (b) { return { mailbox: b.mailbox, owner: b.owner_name, active: isTrue_(b.active), last_ingest: b.last_ingest instanceof Date ? b.last_ingest.toISOString() : b.last_ingest }; });
  }
  out.syncedAt = new Date().toISOString();
  return out;
}

// ═════════════════════════════ Invoices: what was sent, what was not · admin time corrections ═════════════════════════════

function newEventId_() { return 'E' + Utilities.getUuid().replace(/-/g, '').slice(0, 10); }
function fillEventIds_() {
  ['Order Events', 'Project Events'].forEach(function (name) {
    const sh = SpreadsheetApp.getActive().getSheetByName(name);
    if (!sh) return;
    const head = headersOf_(name);
    readTable_(name).forEach(function (r, i) { if (!String(r.event_id || '').trim()) writeRowFields_(sh, head, i + 2, { event_id: newEventId_() }); });
  });
}

/** "50@Quote accepted;50@Installed" → [{pct, stage}], checked against the project's steps. */
function parsePlan_(text) {
  return String(text || '').split(';').map(function (x) { return x.trim(); }).filter(String).map(function (x) {
    const m = /^(\d+(?:\.\d+)?)\s*@\s*(.+)$/.exec(x);
    if (!m) throw new Error('Payment plan part "' + x + '" should look like 50@Quote accepted');
    return { pct: Number(m[1]), stage: m[2].trim() };
  });
}
function checkPlan_(text, typeId, segmentId) {
  const plan = parsePlan_(text);
  if (!plan.length) return '';
  const total = plan.reduce(function (s, x) { return s + x.pct; }, 0);
  if (Math.abs(total - 100) > 0.01) throw new Error('The invoice parts add up to ' + total + '%, not 100%.');
  const names = projectStages_(typeId, segmentId).map(function (s) { return s.stage; });
  plan.forEach(function (x) { if (names.length && names.indexOf(x.stage) < 0) throw new Error('"' + x.stage + '" is not a step of this project.'); });
  return plan.map(function (x) { return x.pct + '@' + x.stage; }).join(';');
}

/** When a project reaches the step of an invoice part, that part becomes an invoice to send. Call while holding the lock. */
function ensureProjectInvoices_(pr) {
  if (!pr || !String(pr.payment_plan || '').trim() || String(pr.stage) === 'Lost / cancelled') return 0;
  const names = projectStages_(pr.type_id, pr.segment_id).map(function (s) { return s.stage; });
  const at = names.indexOf(pr.stage);
  const plan = parsePlan_(pr.payment_plan);
  const hst = Number(getSettings_().HST_RATE || 13);
  const value = Number(pr.value) || 0;
  const tasks = [];
  plan.forEach(function (x, i) {
    const need = names.indexOf(x.stage);
    if (need < 0 || at < need) return;
    const amt = Math.round(value * x.pct) / 100;
    tasks.push({ key: 'PINV:' + pr.project_id + ':' + (i + 1), type: 'Project invoice', assign_roles: getSettings_().PROJECT_REMINDER_ROLES || 'office',
                 ref_id: pr.project_id, site_id: pr.site_id || '', link: '#/projects/' + pr.project_id, amount: value ? amt : '',
                 title: 'Invoice ' + (i + 1) + ' of ' + plan.length + ' (' + x.pct + '%) · ' + pr.title +
                        (value ? ' · $' + amt.toFixed(2) + ' + HST ' + hst + '% = $' + (amt * (1 + hst / 100)).toFixed(2) : '') });
  });
  return ensureTasks_(tasks).length;
}

/** Every invoice to send — maintenance, after service reports, project parts — with sent / not sent, plus parts not due yet. */
function invoicesFor_(user) {
  const mine = function (t) { return user.isAdmin || String(t.assign_roles || '').split(',').some(function (x) { return user.roles.indexOf(x.trim()) >= 0; }); };
  const iso = function (v) { return v instanceof Date ? v.toISOString() : v; };
  const kind = function (t) {
    if (/^MINV:/.test(String(t.key))) return 'Maintenance';
    if (/^PINV:/.test(String(t.key))) return 'Project';
    return 'Service report';
  };
  const items = readTable_('Tasks').filter(function (t) { return /invoice/i.test(String(t.type)) && mine(t); }).map(function (t) {
    return { task_id: t.task_id, kind: kind(t), title: t.title, amount: t.amount, created_at: iso(t.created_at), status: t.status === 'done' ? 'sent' : 'not sent',
             done_at: iso(t.done_at), done_by: t.done_by, note: t.note, link: t.link, ref_id: t.ref_id, site_id: t.site_id,
             month: t.month || String(iso(t.created_at) || '').slice(0, 7) };
  });
  // Parts of a project's payment plan whose step has not been reached yet (office, Chris and admin only).
  if (can_(user, 'order.view')) {
    const have = {};
    readTable_('Tasks').forEach(function (t) { if (t.key) have[t.key] = true; });
    readTable_('Projects').forEach(function (pr) {
      if (!String(pr.payment_plan || '').trim() || String(pr.stage) === 'Lost / cancelled') return;
      let plan; try { plan = parsePlan_(pr.payment_plan); } catch (e) { return; }
      plan.forEach(function (x, i) {
        if (have['PINV:' + pr.project_id + ':' + (i + 1)]) return;
        const amt = Number(pr.value) ? Math.round(Number(pr.value) * x.pct) / 100 : '';
        items.push({ task_id: '', kind: 'Project', status: 'upcoming', amount: amt, ref_id: pr.project_id, site_id: pr.site_id || '',
                     link: '#/projects/' + pr.project_id, created_at: '', month: '', due_step: x.stage,
                     title: 'Invoice ' + (i + 1) + ' of ' + plan.length + ' (' + x.pct + '%) · ' + pr.title + ' — when "' + x.stage + '"' });
      });
    });
  }
  return { hst: Number(getSettings_().HST_RATE || 13), plans: getSettings_().PAYMENT_PLANS || '', items: items };
}

/** Which recorded times the admin may correct, by tab. */
const TIME_FIELDS = {
  'Service Reports': { id: 'report_id', fields: ['server_time'] },
  'Tasks': { id: 'task_id', fields: ['created_at', 'done_at'] },
  'Orders': { id: 'order_id', fields: ['created_at', 'stage_at', 'ready_date'] },
  'Order Events': { id: 'event_id', fields: ['at'] },
  'Projects': { id: 'project_id', fields: ['created_at', 'stage_at'] },
  'Project Events': { id: 'event_id', fields: ['at'] },
  'Sites': { id: 'site_id', fields: ['created_at', 'archived_at'] },
};

function editTime_(user, p) {
  if (!user.isAdmin) throw new Error('Only the admin can change recorded times.');
  const spec = TIME_FIELDS[p.table];
  if (!spec || spec.fields.indexOf(p.field) < 0) throw new Error('That time cannot be changed here.');
  const value = p.field === 'ready_date' ? clean_(p.value, 10) : new Date(p.value);
  if (p.field === 'ready_date' ? !/^\d{4}-\d{2}-\d{2}$/.test(value) : isNaN(value.getTime())) throw new Error('Not a valid date / time.');
  return withLock_(function () {
    const row = readTable_(p.table).filter(function (r) { return String(r[spec.id]) === String(p.id); })[0];
    if (!row) throw new Error(p.table + ' ' + p.id + ' does not exist.');
    const old = row[p.field] instanceof Date ? row[p.field].toISOString() : String(row[p.field] || '');
    const fields = {}; fields[p.field] = value;
    updateRecord_(p.table, spec.id, p.id, fields);
    // Moving the time of the step an order / project is in also moves its "in this step since" date (used by reminders).
    if (p.table === 'Order Events' || p.table === 'Project Events') {
      const parentTab = p.table === 'Order Events' ? 'Orders' : 'Projects', key = p.table === 'Order Events' ? 'order_id' : 'project_id';
      const parent = readTable_(parentTab).filter(function (r) { return r[key] === row[key]; })[0];
      if (parent && row.stage && row.stage === parent.stage) {
        const latest = readTable_(p.table).filter(function (e) { return e[key] === row[key] && e.stage === row.stage; })
          .sort(function (a, b) { return new Date(b.at) - new Date(a.at); })[0];
        if (latest && latest.event_id === row.event_id) updateRecord_(parentTab, key, row[key], { stage_at: value });
      }
    }
    audit_(user.email, 'time.edit', p.table + ' ' + p.id, p.field + ': ' + old + ' → ' + (value instanceof Date ? value.toISOString() : value));
    return { table: p.table, id: p.id, field: p.field, old: old, value: value instanceof Date ? value.toISOString() : value };
  });
}

// ═════════════════════════════ Step 6: Chris confirms quotes · sales / PM mailbox checks · residential maintenance ═════════════════════════════

/** Residential rows: frequency from the package ("Silver 2", "(No Contract) 1 visit", "4 visits"). */
function residentialFrequency_(c) {
  const t = String(c.contractType || '');
  const n = Number((/(\d+)\s*visits?/i.exec(t) || /(?:gold|silver|sliver)\s*(\d+)/i.exec(t) || [0, 1])[1]) || 1;
  c.frequency = n >= 12 ? 'Monthly' : n >= 4 ? 'Quarterly' : n >= 2 ? 'Semi-annual' : 'Annual';
  c.segment = 'RES';
  return c;
}

/** Adds seed rows whose key column value is missing (e.g. the sales mailbox added in a later version). */
function addMissingSeedRows_(name, keyCol) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) return;
  const head = headersOf_(name);
  const have = readTable_(name).map(function (r) { return norm_(r[keyCol]); });
  const def = SEED[name];
  def.rows.forEach(function (r) {
    const rec = {}; def.headers.forEach(function (h, i) { rec[h] = r[i]; });
    if (have.indexOf(norm_(rec[keyCol])) >= 0) {
      // Fill new columns on an existing row only where they are still blank.
      const i = readTable_(name).findIndex(function (x) { return norm_(x[keyCol]) === norm_(rec[keyCol]); });
      const cur = readTable_(name)[i];
      const fill = {};
      ['purpose', 'follow_up_days', 'unanswered_days', 'track_all_sent'].forEach(function (k) { if (head.indexOf(k) >= 0 && String(cur[k]).trim() === '' && rec[k] !== undefined) fill[k] = rec[k]; });
      if (Object.keys(fill).length) writeRowFields_(sh, head, i + 2, fill);
      return;
    }
    sh.appendRow(head.map(function (h) { return rec[h] === undefined ? '' : rec[h]; }));
  });
}

/** Version 2 of the project steps (Chris confirms scope & materials; Kyle's checkboxes). Runs once. */
function migrateProjectStages_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('STAGES_VERSION') === '3') return;
  const sh = SpreadsheetApp.getActive().getSheetByName('Project Stages');
  const newNames = SEED['Project Stages'].rows.map(function (r) { return r[0] + '|' + r[2]; });
  const stuck = readTable_('Projects').filter(function (p) { return String(p.status) !== 'closed' && p.stage && newNames.indexOf(p.type_id + '|' + p.stage) < 0; });
  if (stuck.length) { Logger.log('Project steps not replaced: open projects use old steps (' + stuck.map(function (p) { return p.project_id; }).join(', ') + ')'); return; }
  {
    const head = headersOf_('Project Stages');
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, head.length).clearContent();
    const def = SEED['Project Stages'];
    const out = def.rows.map(function (r) { return head.map(function (h) { const i = def.headers.indexOf(h); return i >= 0 ? r[i] : ''; }); });
    sh.getRange(2, 1, out.length, head.length).setValues(out);
  }
  props.setProperty('STAGES_VERSION', '3');
}

/** The checkbox for the step a project just entered (if that step has assign_roles). */
function ensureStepTask_(pr) {
  const st = projectStages_(pr.type_id, pr.segment_id).filter(function (s) { return s.stage === pr.stage; })[0];
  if (!st || !String(st.assign_roles || '').trim()) return 0;
  let form = String(st.form || '').trim();
  if (!form && stepChoices_(st).length) form = 'choice';
  return ensureTasks_([{ key: 'PSTEP:' + pr.project_id + ':' + pr.stage + ':' + (form || 'tick') + ':' + day_(new Date()), type: 'Project step',
    assign_roles: st.assign_roles, ref_id: pr.project_id, site_id: pr.site_id || '', link: '#/projects/' + pr.project_id,
    title: (st.reminder || pr.stage) + ': ' + pr.title + (pr.site_name ? ' · ' + pr.site_name : '') }]).length;
}

/** "Passed→Send maintenance contract | Not passed→Deficiencies to fix" → [{label, stage}] */
function stepChoices_(st) {
  return String((st && st.next) || '').split('|').map(function (x) { return x.trim(); }).filter(String).map(function (x) {
    const m = x.split(/\s*(?:→|->)\s*/); return { label: m.length > 1 ? m[0] : m[0], stage: (m.length > 1 ? m[1] : m[0]).trim() };
  });
}

/** Fills a role's column in Permissions from the defaults the first time that column appears. */
function fillRoleColumn_(role) {
  const sh = SpreadsheetApp.getActive().getSheetByName('Permissions');
  const head = headersOf_('Permissions');
  const rows = readTable_('Permissions');
  if (head.indexOf(role) < 0 || rows.some(function (r) { return String(r[role]).trim() !== ''; })) return;
  const def = SEED.Permissions, col = def.headers.indexOf(role);
  rows.forEach(function (r, i) {
    const seed = def.rows.filter(function (x) { return x[0] === r.permission; })[0];
    const f = {}; f[role] = seed ? seed[col] : false;
    writeRowFields_(sh, head, i + 2, f);
  });
}

function checkStepOwner_(user, p) {
  const pr = readTable_('Projects').filter(function (x) { return x.project_id === p.project_id; })[0];
  if (!pr) throw new Error('Project ' + p.project_id + ' does not exist.');
  const steps = projectStages_(pr.type_id, pr.segment_id);
  const cur = steps.filter(function (s) { return s.stage === pr.stage; })[0];
  const mine = cur && String(cur.assign_roles || '').split(',').some(function (r) { return user.roles.indexOf(r.trim()) >= 0; });
  if (!mine) throw new Error('Only the person this step is assigned to can finish it.');
  const names = steps.map(function (s) { return s.stage; });
  const allowed = stepChoices_(cur).map(function (c) { return c.stage; });
  if (!allowed.length) allowed.push(names[names.indexOf(pr.stage) + 1]);
  if (p.stage && allowed.indexOf(p.stage) < 0) throw new Error('From "' + pr.stage + '" you can go to: ' + allowed.join(', ') + '.');
}

function advanceProjectFromTask_(user, t, note) {
  const parts = String(t.key).split(':');
  const pr = readTable_('Projects').filter(function (x) { return x.project_id === parts[1]; })[0];
  if (!pr || pr.stage !== parts[2]) return;
  const names = projectStages_(pr.type_id, pr.segment_id).map(function (s) { return s.stage; });
  const next = names[names.indexOf(pr.stage) + 1];
  if (next) projectStepCore_(user, { project_id: pr.project_id, stage: next, note: '✓ ' + pr.stage + (note ? ' · ' + note : '') });
}

function confirmScope_(user, p) {
  return withLock_(function () {
    const pr = readTable_('Projects').filter(function (x) { return x.project_id === p.project_id; })[0];
    if (!pr) throw new Error('Project ' + p.project_id + ' does not exist.');
    if (!user.isAdmin && user.roles.indexOf('manager') < 0) throw new Error('Chris (manager) confirms the scope.');
    const scope = clean_(p.scope, 4000), materials = clean_(p.materials, 4000);
    if (!scope) throw new Error('Write what needs to be done.');
    updateRecord_('Projects', 'project_id', pr.project_id, { scope: scope, materials: materials, scope_by: user.email, scope_at: new Date() });
    closeTasks_(function (t) { return /^PSTEP:/.test(String(t.key)) && String(t.key).split(':')[1] === pr.project_id && String(t.key).split(':')[3] === 'scope'; }, user.email, 'Scope confirmed');
    const names = projectStages_(pr.type_id, pr.segment_id).map(function (s) { return s.stage; });
    const st = projectStages_(pr.type_id, pr.segment_id).filter(function (s) { return String(s.form) === 'scope'; })[0];
    const next = st ? names[names.indexOf(st.stage) + 1] : '';
    const res = next && names.indexOf(pr.stage) <= names.indexOf(st.stage)
      ? projectStepCore_(user, { project_id: pr.project_id, stage: next, scopeConfirmed: true, note: 'Scope: ' + scope.slice(0, 300) + (materials ? ' · Materials: ' + materials.slice(0, 300) : '') })
      : { project: pr };
    audit_(user.email, 'project.scope', pr.project_id, scope.slice(0, 200));
    return res;
  });
}

// ───────── mail conversations: unanswered (PM box) and no reply after 7 days (sales box) ─────────

/** Threads still waiting for something, so the collector re-checks them even without new matching mail. */
function watchedThreads_(mailbox) {
  const since = Date.now() - 45 * 86400000;
  return readTable_('Mail Threads').filter(function (t) {
    return norm_(t.mailbox) === mailbox && (t.waiting_on === 'us' || t.waiting_on === 'them') && new Date(t.updated_at).getTime() > since;
  }).map(function (t) { return t.thread_id; }).slice(0, 200);
}

/** th = { id, msgs: [{ at, out, from, to }] } from the collector (dates and addresses only). */
function updateThread_(box, th, rec) {
  if (!th || !th.id || !(th.msgs || []).length) return;
  const msgs = th.msgs.map(function (m) { return { at: new Date(m.at), out: !!m.out, from: String(m.from || ''), to: String(m.to || '') }; })
    .sort(function (a, b) { return a.at - b.at; });
  const ins = msgs.filter(function (m) { return !m.out; }), outs = msgs.filter(function (m) { return m.out; });
  const last = msgs[msgs.length - 1];
  const fields = {
    mailbox: norm_(box.mailbox), first_at: msgs[0].at, last_in_at: ins.length ? ins[ins.length - 1].at : '', last_out_at: outs.length ? outs[outs.length - 1].at : '',
    waiting_on: last.out ? 'them' : 'us', updated_at: new Date(),
    counterpart: clean_((last.out ? last.to : last.from) || (ins.length ? ins[0].from : ''), 300),
    link: 'https://mail.google.com/mail/u/?authuser=' + encodeURIComponent(norm_(box.mailbox)) + '#all/' + th.id,
  };
  if (th.subject) fields.subject = clean_(th.subject, 300);
  if (rec) { fields.subject = fields.subject || rec.subject; fields.categories = rec.categories; fields.site_name = rec.site_name; }
  const all = readTable_('Mail Threads');
  const i = all.findIndex(function (t) { return String(t.thread_id) === String(th.id); });
  if (i < 0) appendRecord_('Mail Threads', Object.assign({ thread_id: th.id, subject: '', categories: '', site_name: '' }, fields));
  else {
    if (rec && all[i].categories) fields.categories = unique_(String(all[i].categories).split(',').concat(String(rec.categories || '').split(','))).filter(String).join(',');
    writeRowFields_(SpreadsheetApp.getActive().getSheetByName('Mail Threads'), headersOf_('Mail Threads'), i + 2, fields);
  }
}

/** Daily and after each collector run. */
function ensureMailTasks_() {
  const boxes = {};
  readTable_('Mailboxes').forEach(function (b) { boxes[norm_(b.mailbox)] = b; });
  const roles = getSettings_().MAIL_REMINDER_ROLES || 'office';
  const now = Date.now();
  const tasks = [];
  const threads = readTable_('Mail Threads');
  threads.forEach(function (t) {
    const b = boxes[norm_(t.mailbox)]; if (!b) return;
    const lastIn = t.last_in_at ? new Date(t.last_in_at).getTime() : 0, lastOut = t.last_out_at ? new Date(t.last_out_at).getTime() : 0;
    const who = String(t.counterpart || '').replace(/<.*>/, '').trim() || t.counterpart;
    const unans = Number(b.unanswered_days || 0), fu = Number(b.follow_up_days || 0);
    const workRelated = !!String(t.categories || '').trim();
    if (unans && lastIn > lastOut && workRelated && now - lastIn >= unans * 86400000) {
      tasks.push({ key: 'UNANS:' + t.thread_id + ':' + day_(new Date(lastIn)), type: 'Not answered', assign_roles: roles, link: t.link, ref_id: t.thread_id,
                   title: 'Not answered for ' + Math.floor((now - lastIn) / 86400000) + ' days: ' + (t.subject || '(no subject)') + ' — ' + who + ' (' + t.mailbox + ')' });
    }
    if (fu && lastOut > lastIn && now - lastOut >= fu * 86400000) {
      tasks.push({ key: 'FU:' + t.thread_id + ':' + day_(new Date(lastOut)), type: 'Follow up', assign_roles: roles, link: t.link, ref_id: t.thread_id,
                   title: 'No reply in ' + Math.floor((now - lastOut) / 86400000) + ' days — follow up: ' + (t.subject || '(no subject)') + ' → ' + who });
    }
    if (fu && lastIn > lastOut && lastOut > 0) {
      tasks.push({ key: 'RPLY:' + t.thread_id + ':' + day_(new Date(lastIn)), type: 'Reply', assign_roles: roles, link: t.link, ref_id: t.thread_id,
                   title: 'Reply from ' + who + ': ' + (t.subject || '(no subject)') + ' (' + t.mailbox + ')' });
    }
  });
  const made = ensureTasks_(tasks).length;
  // Close reminders the conversation has moved past.
  const byId = {}; threads.forEach(function (t) { byId[t.thread_id] = t; });
  closeTasks_(function (k) {
    const m = /^(UNANS|FU):([^:]+):/.exec(String(k.key)); if (!m || !byId[m[2]]) return false;
    const t = byId[m[2]];
    const lastIn = t.last_in_at ? new Date(t.last_in_at).getTime() : 0, lastOut = t.last_out_at ? new Date(t.last_out_at).getTime() : 0;
    return m[1] === 'UNANS' ? lastOut > lastIn : lastIn > lastOut;
  }, 'Mailbox', 'Answered');
  return made;
}

// ═════════════════════════════ Ongoing jobs found automatically (Project Tracker + mail) ═════════════════════════════

function isoRow_(r) { const o = {}; Object.keys(r).forEach(function (k) { o[k] = r[k] instanceof Date ? r[k].toISOString() : r[k]; }); return o; }

/** "2026-02-11", 11/02/2026, 9/2/2026 (Site visit), Date → Date or null */
function looseDate_(v) {
  if (v instanceof Date) return isNaN(v) ? null : v;
  const t = String(v || '');
  let m = /(20\d\d)-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Math.min(Number(m[3]), 28));
  m = /(\d{1,2})\/(\d{1,3})\/(20\d\d)/.exec(t);
  if (m) { let a = Number(m[1]), b = Number(m[2]); if (a > 12) { const x = a; a = b; b = x; } return new Date(Number(m[3]), Math.min(Math.max(a, 1), 12) - 1, Math.min(Math.max(b, 1), 28)); }
  return null;
}

/** Rows of the tracker's "Quote & Lead follow up" tab → suggested projects. */
function trackerSuggestions_(values, url) {
  const hi = values.findIndex(function (r) { return r.some(function (c) { return /proposal\s*sent/i.test(String(c)); }); });
  if (hi < 0) return [];
  const head = values[hi].map(function (h) { return String(h).replace(/\s+/g, ' ').trim(); });
  const col = function (re) { return head.findIndex(function (h) { return re.test(h); }); };
  const C = { job: col(/^job/i), contact: col(/contact/i), type: col(/client type/i), loc: col(/location/i), inq: col(/inquiry/i),
              prop: col(/proposal sent/i), acc: col(/accepted/i), quote: col(/quote/i), next: col(/next step/i), win: col(/win/i), note: col(/^note/i) };
  const since = Date.now() - 365 * 86400000;
  const out = [];
  values.slice(hi + 1).forEach(function (r) {
    const name = String(r[C.job] || '').replace(/\s+/g, ' ').trim();
    const num = (/#?\s*(\d{3,5})/.exec(name) || [])[1];
    if (!num) return;
    const win = String(C.win >= 0 ? r[C.win] : '').trim().toUpperCase();
    if (win === 'N') return;                                            // marked lost
    const inq = looseDate_(r[C.inq]), prop = looseDate_(r[C.prop]), acc = looseDate_(r[C.acc]);
    const latest = [inq, prop, acc].filter(Boolean).reduce(function (a, b) { return a > b ? a : b; }, null);
    if (!latest || latest.getTime() < since) return;
    const title = name.replace(/^#?\s*\d{3,5}\s*[_\-\s]*/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || name;
    // Job names carry a code: N_INS / INST / RN / MOD = installation or modernization; repair / decommission / service call = repair.
    const type = /\b(N[_\s-]?INS|INST|INS|RN|MOD)\b/i.test(name) ? 'INS' : /repair|decommission|service call/i.test(name) ? 'REP' : 'INS';
    const won = win === 'Y' || !!acc;
    out.push({
      ref: 'PT#' + num + (out.some(function (x) { return x.ref === 'PT#' + num; }) ? '-' + (out.length + 1) : ''), source: 'Project Tracker',
      title: '#' + num + ' ' + title, type_id: type, segment_id: /^r/i.test(String(r[C.type] || '').trim()) ? 'RES' : 'COM',
      site_name: String(r[C.loc] || '').replace(/\s+/g, ' ').trim(), contact: String(r[C.contact] || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      value: money_(r[C.quote]), inquiry_date: inq ? day_(inq) : '', proposal_date: prop ? day_(prop) : '', accepted_date: acc ? day_(acc) : '',
      next_steps: String(r[C.next] || r[C.note] || '').replace(/\s+/g, ' ').trim().slice(0, 300), link: url || '',
      stage: won ? (type === 'REP' ? 'Parts ordered' : 'Customer confirmed · deposit') : prop ? 'Waiting for reply' : (type === 'REP' ? 'Request received' : 'Lead screening'),
    });
  });
  return out;
}

/** Mail conversations about quotes / installs / repairs that are not filed under a project yet. */
function mailSuggestions_() {
  const linked = {};
  readTable_('Mail').forEach(function (m) { if (m.linked_type === 'project' || m.status === 'ignored') linked[m.thread_id] = true; });
  const boxes = {};
  readTable_('Mailboxes').forEach(function (b) { boxes[norm_(b.mailbox)] = b; });
  const since = Date.now() - 60 * 86400000;
  return readTable_('Mail Threads').filter(function (t) {
    return !linked[t.thread_id] && /quote|installation|inspection/i.test(String(t.categories)) && new Date(t.updated_at).getTime() > since;
  }).map(function (t) {
    const rep = /repair|replace|fix|broken|not working/i.test(String(t.subject));
    const sales = /sales/i.test(String((boxes[norm_(t.mailbox)] || {}).purpose));
    return { ref: 'MAIL#' + t.thread_id, source: 'Mail (' + t.mailbox + ')', title: String(t.subject || '(no subject)').replace(/^(re|fwd?):\s*/i, ''),
             type_id: rep ? 'REP' : 'INS', segment_id: 'COM', site_name: t.site_name || '', contact: t.counterpart || '', value: '',
             inquiry_date: t.first_at ? day_(new Date(t.first_at)) : '', proposal_date: '', accepted_date: '', link: t.link,
             next_steps: t.waiting_on === 'them' ? 'We wrote last — waiting for the customer' : 'Customer wrote last — needs an answer',
             stage: t.waiting_on === 'them' && sales ? 'Waiting for reply' : (rep ? 'Request received' : 'Lead screening') };
  });
}

/** Rewrites the suggestion list, keeping added / dismissed status. Call while holding the lock. */
function rebuildSuggestions_(trackerTabs) {
  const sh = SpreadsheetApp.getActive().getSheetByName('Project Suggestions');
  if (!sh) return 0;
  const old = {};
  readTable_('Project Suggestions').forEach(function (r) { old[r.ref] = r; });
  const projects = readTable_('Projects');
  const taken = {};
  projects.forEach(function (p) { if (p.source_ref) taken[p.source_ref] = p.project_id; });
  let fresh = [];
  (trackerTabs || []).forEach(function (t) { fresh = fresh.concat(trackerSuggestions_(t.values, t.url)); });
  if (!(trackerTabs || []).length) fresh = Object.keys(old).map(function (k) { return old[k]; }).filter(function (r) { return /^PT#/.test(r.ref); });
  fresh = fresh.concat(mailSuggestions_());
  const head = headersOf_('Project Suggestions');
  let added = 0;
  const rows = fresh.map(function (x) {
    const o = old[x.ref];
    const rec = Object.assign({}, x, { status: taken[x.ref] ? 'added' : (o ? o.status : 'new'), project_id: taken[x.ref] || (o ? o.project_id : ''), updated_at: new Date() });
    if (!o && rec.status === 'new') added++;
    return head.map(function (h) { return rec[h] === undefined ? '' : rec[h]; });
  });
  // keep dismissed / added rows that no longer show up, so they are never suggested again
  Object.keys(old).forEach(function (k) {
    if (fresh.some(function (x) { return x.ref === k; }) || old[k].status === 'new') return;
    rows.push(head.map(function (h) { return old[k][h] === undefined ? '' : old[k][h]; }));
  });
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, head.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
  return added;
}

/** p.items = [{ref, stage, type_id, segment_id}] — adds each as a project at the step chosen (no Drive folder yet). */
function acceptSuggestions_(user, p) {
  return withLock_(function () {
    const all = readTable_('Project Suggestions');
    const types = readTable_('Project Types');
    const made = [];
    (p.items || []).slice(0, 100).forEach(function (it) {
      const sg = all.filter(function (x) { return x.ref === it.ref && x.status === 'new'; })[0];
      if (!sg) return;
      const typeId = it.type_id || sg.type_id, seg = it.segment_id || sg.segment_id || 'COM';
      const type = types.filter(function (t) { return t.type_id === typeId; })[0];
      if (!type) return;
      const names = projectStages_(typeId, seg).map(function (x) { return x.stage; });
      const stage = names.indexOf(it.stage) >= 0 ? it.stage : (names.indexOf(sg.stage) >= 0 ? sg.stage : names[0]);
      const site = siteForText_(sg.site_name);
      const past = names.indexOf(stage) > names.findIndex(function (n, i) { return String(projectStages_(typeId, seg)[i].form) === 'scope'; });
      const rec = {
        project_id: nextId_('Projects', 'project_id', String(type.id_prefix || type.type_id), 3), type_id: typeId, segment_id: seg,
        site_id: site ? site.site_id : '', title: clean_(sg.title, 200), status: 'open', owner_email: user.email, folder_id: '', folder_url: '',
        created_at: new Date(), created_by: user.email, notes: [sg.source, sg.next_steps, sg.link].filter(String).join(' · '),
        stage: stage, stage_at: new Date(), site_name: sg.site_name, addr_key: addrKey_(sg.site_name), customer: '', contact: sg.contact,
        value: sg.value, updated_at: new Date(), source_ref: sg.ref,
        scope: past ? 'Quoted before the OA (' + sg.source + ')' : '', scope_by: past ? user.email : '', scope_at: past ? new Date() : '',
      };
      appendRecord_('Projects', rec);
      appendRecord_('Project Events', { project_id: rec.project_id, at: new Date(), stage: stage, by: user.email,
        note: 'Added from ' + sg.source + (sg.proposal_date ? ' · quote sent ' + sg.proposal_date : sg.inquiry_date ? ' · enquiry ' + sg.inquiry_date : '') });
      if (/^MAIL#/.test(sg.ref)) {
        const thread = sg.ref.slice(5);
        readTable_('Mail').forEach(function (m) { if (m.thread_id === thread) linkMailRow_(m.mail_id, 'project', rec.project_id); });
      }
      ensureStepTask_(rec);
      updateRecord_('Project Suggestions', 'ref', sg.ref, { status: 'added', project_id: rec.project_id, updated_at: new Date() });
      made.push(rec.project_id);
    });
    audit_(user.email, 'project.import', made.join(','), made.length + ' projects from suggestions');
    return { added: made };
  });
}


// ═════════════════════════════ CRM: contacts, companies, notes, links (HubSpot-style; no call / email tracking) ═════════════════════════════

const CRM_FIELDS = {
  contact: ['first_name', 'last_name', 'email', 'phone', 'mobile', 'job_title', 'company_id', 'lifecycle', 'owner', 'address', 'notes'],
  company: ['name', 'type', 'lifecycle', 'phone', 'email', 'domain', 'address', 'city', 'owner', 'notes'],
};
const CRM_TAB = { contact: 'CRM Contacts', company: 'CRM Companies' };
const CRM_ID = { contact: 'contact_id', company: 'company_id' };
const CRM_DEFAULT_LIFECYCLE = 'Lead|Opportunity|Customer|Past customer|Other';
const CRM_DEFAULT_TYPES = 'Property manager|Building owner|General contractor|Architect / consultant|Condo corporation|Homeowner|Supplier|Other';

function crmSplit_(v, fallback) { return String(v || fallback).split('|').map(function (x) { return x.trim(); }).filter(String); }
function crmType_(t) { if (t !== 'contact' && t !== 'company') throw new Error('Unknown CRM record type: ' + t); return t; }
/** "Button LTD." and "Button Ltd" are the same company. */
function crmCompanyKey_(name) {
  return String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(ltd|limited|inc|incorporated|corp|corporation|co|company|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
/** Ten digits of a North American phone number (no country code, no extension), or ''. */
function crmDigits_(s) {
  const m = /(?:\+?1[\s.\-]?)?\(?(\d{3})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})/.exec(String(s || ''));
  return m ? m[1] + m[2] + m[3] : '';
}
function crmPhone_(s) {
  const m = /(?:\+?1[\s.\-]?)?\(?(\d{3})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})(\s*(?:x|ext\.?)\s*\d+)?/i.exec(String(s || ''));
  return m ? m[1] + '-' + m[2] + '-' + m[3] + (m[4] ? ' ' + m[4].trim() : '') : '';
}
function crmNum_(rows, col) {
  return rows.reduce(function (mx, r) { const n = Number(String(r[col] || '').replace(/\D/g, '')) || 0; return Math.max(mx, n); }, 0);
}
function crmPad_(prefix, n) { return prefix + ('00000' + n).slice(-5); }
/** "Josh Demore (Site super)" → { first_name: 'Josh', last_name: 'Demore', job_title: 'Site super' } */
function crmName_(name) {
  let t = String(name || '').replace(/\s+/g, ' ').trim(), title = '';
  const m = /\(([^)]+)\)/.exec(t);
  if (m) { title = m[1].trim(); t = t.replace(m[0], ' ').replace(/\s+/g, ' ').trim(); }
  t = t.replace(/^(mr|mrs|ms|miss|dr)\.?\s+/i, '');
  const parts = t ? t.split(' ') : [];
  return { first_name: parts[0] || '', last_name: parts.slice(1).join(' '), job_title: title };
}

/** Free-text contact cell ("Customer: X / Josh Demore / Office: 705… / Cell: … / Email: …") → fields. */
function parseContactBlock_(text) {
  const out = { company: '', name: '', email: '', phone: '', mobile: '' };
  const raw = String(text || '');
  const emails = raw.match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/ig) || [];
  out.email = (emails[0] || '').toLowerCase();
  raw.split(/\n|;/).forEach(function (line) {
    line = line.replace(/\s+/g, ' ').trim();
    if (!line) return;
    let m;
    if ((m = /^(customer|company|client|gc|contractor|management|property manager)\s*[:：]\s*(.*)$/i.exec(line))) { if (!out.company && m[2].trim()) out.company = m[2].trim(); return; }
    if ((m = /^(name of contact|contact name|contact person|contact|name|attn)\s*[:：]\s*(.*)$/i.exec(line))) { if (!out.name && m[2].trim() && !crmDigits_(m[2])) out.name = m[2].trim(); return; }
    if ((m = /^(cell|mobile|cell phone|c|m)\s*[:：.]\s*(.*)$/i.exec(line))) { const p = crmPhone_(m[2]); if (p && !out.mobile) out.mobile = p; return; }
    if ((m = /^(office|tel|phone|o|t|p|work|main)\s*[:：.]\s*(.*)$/i.exec(line))) { const p = crmPhone_(m[2]); if (p && !out.phone) out.phone = p; return; }
    if (/^e-?mail\s*[:：]/i.test(line) || /@/.test(line)) return;
    if (/[:：]/.test(line)) return;
    const ph = crmPhone_(line);
    if (ph) { if (!out.phone) out.phone = ph; else if (!out.mobile && ph !== out.phone) out.mobile = ph; return; }
    if (!out.name && /^[A-Za-z][A-Za-z .'\-()]{1,60}$/.test(line)) out.name = line;
  });
  return out;
}

function crmData_(user) {
  const live = function (r) { return !isTrue_(r.archived); };
  const s = getSettings_();
  return {
    companies: readTable_('CRM Companies').filter(live).map(isoRow_),
    contacts: readTable_('CRM Contacts').filter(live).map(isoRow_),
    notes: readTable_('CRM Notes').map(isoRow_),
    links: readTable_('CRM Links').map(isoRow_),
    lifecycle: crmSplit_(s.CRM_LIFECYCLE, CRM_DEFAULT_LIFECYCLE),
    companyTypes: crmSplit_(s.CRM_COMPANY_TYPES, CRM_DEFAULT_TYPES),
    owners: readTable_('Users').filter(function (u) { return isTrue_(u.active) && u.email; })
      .map(function (u) { return { email: norm_(u.email), name: String(u.display_name || u.email) }; }),
    canEdit: can_(user, 'crm.edit'),
    syncedAt: new Date().toISOString(),
  };
}

function crmClean_(type, record) {
  const rec = {};
  Object.keys(record || {}).forEach(function (k) {
    if (CRM_FIELDS[type].indexOf(k) >= 0) rec[k] = clean_(record[k], k === 'notes' ? 5000 : 300);
  });
  if (rec.email !== undefined) {
    rec.email = rec.email.toLowerCase();
    if (rec.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rec.email)) throw new Error('"' + rec.email + '" is not an email address.');
  }
  if (rec.owner !== undefined) rec.owner = rec.owner.toLowerCase();
  if (rec.lifecycle) {
    const ok = crmSplit_(getSettings_().CRM_LIFECYCLE, CRM_DEFAULT_LIFECYCLE);
    if (ok.indexOf(rec.lifecycle) < 0) throw new Error('Lifecycle stage must be one of: ' + ok.join(', '));
  }
  if (rec.company_id && !readTable_('CRM Companies').some(function (c) { return c.company_id === rec.company_id; })) throw new Error('Company ' + rec.company_id + ' does not exist.');
  return rec;
}

/** Create (no id) or update (id) a contact / company. Creating one that was removed earlier brings it back. */
function crmSave_(user, p) {
  const type = crmType_(p.object);
  const rec = crmClean_(type, p.record);
  const tab = CRM_TAB[type], idc = CRM_ID[type];
  return withLock_(function () {
    const all = readTable_(tab);
    const id = String(p.id || '').trim();
    const same = function (r) {
      if (type === 'company') return rec.name !== undefined && crmCompanyKey_(r.name) && crmCompanyKey_(r.name) === crmCompanyKey_(rec.name);
      return rec.email && norm_(r.email) === rec.email;
    };
    if (id) {
      const cur = all.filter(function (r) { return String(r[idc]) === id; })[0];
      if (!cur) throw new Error(id + ' does not exist.');
      const clash = all.filter(function (r) { return String(r[idc]) !== id && !isTrue_(r.archived) && same(r); })[0];
      if (clash) throw new Error('Another ' + type + ' already has this ' + (type === 'company' ? 'name' : 'email') + ' (' + clash[idc] + ').');
      if (type === 'company' && rec.name === '') throw new Error('A company needs a name.');
      rec.updated_at = new Date();
      const out = updateRecord_(tab, idc, id, rec);
      audit_(user.email, 'crm.' + type + '.edit', id, Object.keys(rec).filter(function (k) { return k !== 'updated_at'; }).join(', '));
      return { record: isoRow_(out) };
    }
    if (type === 'company' && !rec.name) throw new Error('A company needs a name.');
    if (type === 'contact' && !(rec.first_name || rec.last_name || rec.email || rec.phone || rec.mobile)) throw new Error('Give the contact a name, an email or a phone number.');
    const dup = all.filter(same)[0];
    if (dup && !isTrue_(dup.archived)) throw new Error('This ' + type + ' is already in the CRM (' + dup[idc] + ').');
    let out, restored = false;
    if (dup) {
      const f = {}; Object.keys(rec).forEach(function (k) { if (rec[k] !== '') f[k] = rec[k]; });
      out = updateRecord_(tab, idc, dup[idc], Object.assign(f, { archived: false, archived_at: '', archived_by: '', updated_at: new Date() }));
      restored = true;
    } else {
      out = Object.assign({}, rec, { lifecycle: rec.lifecycle || 'Lead', source: 'OA', created_at: new Date(), created_by: user.email, updated_at: new Date(), archived: false });
      out[idc] = crmPad_(type === 'contact' ? 'CT' : 'CO', crmNum_(all, idc) + 1);
      appendRecord_(tab, out);
    }
    if (p.link && p.link.type && p.link.id) crmLinkCore_(user, { a_type: type, a_id: out[idc], b_type: p.link.type, b_id: p.link.id });
    audit_(user.email, 'crm.' + type + (restored ? '.restore' : '.create'), out[idc], type === 'company' ? out.name : [out.first_name, out.last_name, out.email].join(' '));
    return { record: isoRow_(out), restored: restored };
  });
}

function crmExists_(type, id) {
  if (type === 'contact' || type === 'company') return readTable_(CRM_TAB[type]).some(function (r) { return String(r[CRM_ID[type]]) === String(id); });
  if (type === 'site') return readTable_('Sites').some(function (r) { return String(r.site_id) === String(id); });
  if (type === 'project') return readTable_('Projects').some(function (r) { return String(r.project_id) === String(id); });
  return false;
}

function crmNote_(user, p) {
  const type = crmType_(p.object_type);
  const text = clean_(p.text, 5000);
  if (!text) throw new Error('Write something in the note.');
  if (!crmExists_(type, p.object_id)) throw new Error(p.object_id + ' does not exist.');
  return withLock_(function () {
    const note = { note_id: 'N' + Utilities.getUuid().replace(/-/g, '').slice(0, 10), object_type: type, object_id: String(p.object_id), text: text, by: user.email, at: new Date() };
    appendRecord_('CRM Notes', note);
    return { note: isoRow_(note) };
  });
}

/** Link (or with remove: true, unlink) a contact / company and a site / project. */
function crmLink_(user, p) { return withLock_(function () { return crmLinkCore_(user, p); }); }
function crmLinkCore_(user, p) {
  const aT = crmType_(p.a_type), bT = String(p.b_type || '');
  if (bT !== 'site' && bT !== 'project') throw new Error('Link to a site or a project.');
  const aId = String(p.a_id || ''), bId = String(p.b_id || '');
  const sh = SpreadsheetApp.getActive().getSheetByName('CRM Links');
  const rows = readTable_('CRM Links');
  const match = function (l) { return l.a_type === aT && String(l.a_id) === aId && l.b_type === bT && String(l.b_id) === bId; };
  if (p.remove) {
    for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i])) sh.deleteRow(i + 2);
    audit_(user.email, 'crm.unlink', aId, bT + ' ' + bId);
    return { removed: true };
  }
  if (!crmExists_(aT, aId)) throw new Error(aId + ' does not exist.');
  if (!crmExists_(bT, bId)) throw new Error(bT + ' ' + bId + ' does not exist.');
  if (rows.some(match)) return { link: null, already: true };
  const link = { a_type: aT, a_id: aId, b_type: bT, b_id: bId, by: user.email, at: new Date(), source: 'OA' };
  appendRecord_('CRM Links', link);
  return { link: isoRow_(link) };
}

function crmArchive_(user, p) {
  const type = crmType_(p.object);
  return withLock_(function () {
    const f = p.restore ? { archived: false, archived_at: '', archived_by: '' } : { archived: true, archived_at: new Date(), archived_by: user.email };
    const out = updateRecord_(CRM_TAB[type], CRM_ID[type], String(p.id), f);
    audit_(user.email, 'crm.' + type + (p.restore ? '.restore' : '.archive'), String(p.id), clean_(p.reason, 300));
    return { record: isoRow_(out) };
  });
}

/** The "Quote & Lead follow up" tabs of the company Project Tracker (for the CRM import button). */
function crmTrackerTabs_() {
  const src = readTable_('Data Sources').filter(function (x) { return String(x.source_id) === 'TRACKER' && isTrue_(x.active); })[0];
  if (!src) return [];
  const book = openSource_(String(src.file_id).trim());
  const out = [];
  book.ss.getSheets().forEach(function (sh) { if (/quote.*lead/i.test(sh.getName())) out.push({ values: sh.getDataRange().getValues(), url: book.url }); });
  return out;
}

/**
 * Adds contacts and companies found in the Project Tracker, Sites and residential maintenance, and links them to
 * sites and projects. Only adds and fills blank fields: never overwrites what someone typed, never brings back
 * a removed record. Call while holding the write lock.
 */
function crmImport_(trackerTabs) {
  const now = new Date();
  const RANK = ['Lead', 'Opportunity', 'Customer'];
  const companies = readTable_('CRM Companies'), contacts = readTable_('CRM Contacts');
  const compByKey = {}, byEmail = {}, byPhone = {}, byName = {};
  companies.forEach(function (c) { const k = crmCompanyKey_(c.name); if (k && !compByKey[k]) compByKey[k] = c; });
  // A name alone only matches when it has a first and a last name (two different "Jennifer"s stay apart).
  const nameKey = function (c) { if (!String(c.first_name || '').trim() || !String(c.last_name || '').trim()) return ''; return norm_(c.first_name + ' ' + c.last_name).replace(/\s+/g, ' ') + '|' + (c.company_id || ''); };
  // Same tracker job + same name = same person (for contacts with only a first name and nothing else).
  const bySrc = {};
  const srcKey = function (c) { const n = norm_([c.first_name, c.last_name].join(' ')).replace(/\s+/g, ' '); return n && c.source_ref ? c.source_ref + '|' + n : ''; };
  const index = function (c) {
    if (c.email && !byEmail[norm_(c.email)]) byEmail[norm_(c.email)] = c;
    [c.phone, c.mobile].forEach(function (ph) { const d = crmDigits_(ph); if (d && !byPhone[d]) byPhone[d] = c; });
    const n = nameKey(c); if (n && !byName[n]) byName[n] = c;
    const sk = srcKey(c); if (sk && !bySrc[sk]) bySrc[sk] = c;
  };
  contacts.forEach(index);
  const linkSet = {};
  readTable_('CRM Links').forEach(function (l) { linkSet[[l.a_type, l.a_id, l.b_type, l.b_id].join('|')] = true; });
  const newCo = [], newCt = [], newLinks = [], fills = { company: {}, contact: {} };
  let coNum = crmNum_(companies, 'company_id'), ctNum = crmNum_(contacts, 'contact_id');

  const fill = function (type, rec, f) {
    const ch = {};
    Object.keys(f).forEach(function (k) {
      if (CRM_FIELDS[type].indexOf(k) < 0 || !f[k]) return;
      if (k === 'lifecycle') {
        const was = String(rec.lifecycle || '');
        if (!was || (RANK.indexOf(was) >= 0 && RANK.indexOf(f[k]) > RANK.indexOf(was))) ch[k] = f[k];
      } else if (String(rec[k] === undefined ? '' : rec[k]).trim() === '') ch[k] = f[k];
    });
    if (!Object.keys(ch).length) return;
    Object.assign(rec, ch);
    if (!rec.__new) fills[type][rec[CRM_ID[type]]] = Object.assign(fills[type][rec[CRM_ID[type]]] || {}, ch);
  };
  const company = function (name, f) {
    name = String(name || '').replace(/\s+/g, ' ').trim();
    const k = crmCompanyKey_(name);
    if (!k || name.length > 120) return null;
    let c = compByKey[k];
    if (c) { fill('company', c, f); return c; }
    c = Object.assign({ name: name, created_at: now, created_by: 'import', updated_at: now, archived: false, __new: true }, f);
    c.company_id = crmPad_('CO', ++coNum);
    newCo.push(c); compByKey[k] = c;
    return c;
  };
  const contact = function (info, f) {
    const email = norm_(info.email), ph = crmDigits_(info.phone), mob = crmDigits_(info.mobile);
    const nk = nameKey(info), sk = srcKey({ first_name: info.first_name, last_name: info.last_name, source_ref: f.source_ref });
    let c = (email && byEmail[email]) || (ph && byPhone[ph]) || (mob && byPhone[mob]) || (nk && byName[nk]) || (sk && bySrc[sk]);
    const all = Object.assign({}, info, f);
    if (c) { fill('contact', c, all); return c; }
    if (!(info.first_name || info.last_name || email || ph || mob)) return null;
    c = Object.assign({ created_at: now, created_by: 'import', updated_at: now, archived: false, __new: true }, all);
    c.contact_id = crmPad_('CT', ++ctNum);
    newCt.push(c); index(c);
    return c;
  };
  const link = function (aT, a, bT, bId) {
    if (!a || !bId) return;
    const key = [aT, a[CRM_ID[aT]], bT, bId].join('|');
    if (linkSet[key]) return;
    linkSet[key] = true;
    newLinks.push({ a_type: aT, a_id: a[CRM_ID[aT]], b_type: bT, b_id: bId, by: 'import', at: now, source: 'import' });
  };

  const projects = readTable_('Projects');
  const projByRef = {};
  projects.forEach(function (p) { if (p.source_ref) projByRef[String(p.source_ref).replace(/-\d+$/, '')] = p; });
  const sites = readTable_('Sites').filter(function (x) { return !isTrue_(x.archived); });

  // 1. Project Tracker: every job ever quoted (the customer, the contact person, phones, email).
  (trackerTabs || []).forEach(function (t) {
    const values = t.values || [];
    const hi = values.findIndex(function (r) { return r.some(function (c) { return /proposal\s*sent/i.test(String(c)); }); });
    if (hi < 0) return;
    const head = values[hi].map(function (h) { return String(h).replace(/\s+/g, ' ').trim(); });
    const col = function (re) { return head.findIndex(function (h) { return re.test(h); }); };
    const C = { job: col(/^job/i), contact: col(/contact/i), type: col(/client type/i), loc: col(/location/i), prop: col(/proposal sent/i), acc: col(/accepted/i), win: col(/win/i) };
    values.slice(hi + 1).forEach(function (r) {
      const job = String(r[C.job] || '').replace(/\s+/g, ' ').trim();
      const num = (/#?\s*(\d{3,5})/.exec(job) || [])[1];
      if (!num || C.contact < 0) return;
      const b = parseContactBlock_(r[C.contact]);
      const res = /^r/i.test(String(C.type >= 0 ? r[C.type] : '').trim());
      const win = String(C.win >= 0 ? r[C.win] : '').trim().toUpperCase();
      const life = win === 'Y' || (C.acc >= 0 && looseDate_(r[C.acc])) ? 'Customer' : (C.prop >= 0 && looseDate_(r[C.prop])) ? 'Opportunity' : 'Lead';
      const ref = 'PT#' + num;
      const loc = String(C.loc >= 0 ? r[C.loc] : '').replace(/\s+/g, ' ').trim();
      let personName = b.name;
      if (res && !personName && b.company) personName = b.company;
      const co = res ? null : company(b.company, { lifecycle: life, source: 'Project Tracker', source_ref: ref });
      const nm = crmName_(personName);
      const ct = contact({ first_name: nm.first_name, last_name: nm.last_name, job_title: nm.job_title, email: b.email, phone: b.phone, mobile: b.mobile,
                           company_id: co ? co.company_id : '' }, { lifecycle: life, source: 'Project Tracker', source_ref: ref, address: res ? loc : '' });
      const pr = projByRef[ref];
      if (pr) { link('company', co, 'project', pr.project_id); link('contact', ct, 'project', pr.project_id); }
      const site = loc ? siteForText_(loc, sites) : null;
      if (site) { link('company', co, 'site', site.site_id); link('contact', ct, 'site', site.site_id); }
    });
  });

  // 2. Maintenance sites: the site contact is a customer.
  sites.forEach(function (s) {
    const b = parseContactBlock_(s.site_contact);
    const nm = crmName_(s.contact_name || b.name);
    const co = b.company ? company(b.company, { lifecycle: 'Customer', source: 'Maintenance Record', source_ref: s.site_id }) : null;
    const ct = contact({ first_name: nm.first_name, last_name: nm.last_name, job_title: nm.job_title, email: s.contact_email || b.email,
                         phone: crmPhone_(s.contact_phone) || b.phone, mobile: b.mobile, company_id: co ? co.company_id : '' },
                       { lifecycle: 'Customer', source: 'Maintenance Record', source_ref: s.site_id });
    link('company', co, 'site', s.site_id); link('contact', ct, 'site', s.site_id);
  });

  // 3. Residential maintenance customers.
  readTable_('Maintenance Plan').filter(function (m) { return String(m.segment).toUpperCase() === 'RES'; }).forEach(function (m) {
    const nm = crmName_(m.contact_name);
    const ct = contact({ first_name: nm.first_name, last_name: nm.last_name, job_title: nm.job_title, email: m.contact_email, phone: crmPhone_(m.contact_phone), company_id: '' },
                       { lifecycle: 'Customer', source: 'Residential maintenance', source_ref: m.address, address: m.address });
    if (m.site_id) link('contact', ct, 'site', m.site_id);
  });

  // 4. Projects whose customer / contact text names a CRM company or an email we know.
  projects.forEach(function (p) {
    const co = compByKey[crmCompanyKey_(p.customer)];
    if (p.customer && co && !isTrue_(co.archived)) link('company', co, 'project', p.project_id);
    (String(p.contact || '').match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/ig) || []).forEach(function (e) {
      const ct = byEmail[e.toLowerCase()];
      if (ct && !isTrue_(ct.archived)) link('contact', ct, 'project', p.project_id);
    });
  });

  // Write: new rows in one go; blank fields filled one record at a time (few after the first run).
  const append = function (tab, recs) {
    if (!recs.length) return;
    const sh = SpreadsheetApp.getActive().getSheetByName(tab);
    const head = headersOf_(tab);
    sh.getRange(sh.getLastRow() + 1, 1, recs.length, head.length)
      .setValues(recs.map(function (r) { return head.map(function (h) { return r[h] === undefined ? '' : r[h]; }); }));
  };
  append('CRM Companies', newCo); append('CRM Contacts', newCt); append('CRM Links', newLinks);
  ['company', 'contact'].forEach(function (type) {
    const ids = Object.keys(fills[type]);
    if (!ids.length) return;
    const tab = CRM_TAB[type], sh = SpreadsheetApp.getActive().getSheetByName(tab), head = headersOf_(tab);
    const rowOf = {};
    readTable_(tab).forEach(function (r, i) { rowOf[r[CRM_ID[type]]] = i + 2; });
    ids.forEach(function (id) { if (rowOf[id]) writeRowFields_(sh, head, rowOf[id], Object.assign(fills[type][id], { updated_at: now })); });
  });
  return { companies: newCo.length, contacts: newCt.length, links: newLinks.length,
           filled: Object.keys(fills.company).length + Object.keys(fills.contact).length };
}
