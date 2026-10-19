# Krysnor OA

Internal operations app (OA): service reports (with offline support), projects and files.

- `index.html`, `app.js`, `styles.css`, `sw.js` — the web page, served by GitHub Pages. Installable on phones; works offline.
- `config.js` — the two values that connect the page to the backend (Apps Script URL and Google sign-in Client ID).
- `apps-script/Code.gs` — reference copy of the backend that runs inside the private "Krysnor OA Master" Google Sheet.

No business data is stored in this repository. All records live in a private Google Sheet and Google Drive,
and every request is checked against the signed-in Google account and the Users / Permissions tabs.

Copyright © 2026 KKKKKelsey (Kaixin). All rights reserved. This code is not licensed for use, copying or distribution.
