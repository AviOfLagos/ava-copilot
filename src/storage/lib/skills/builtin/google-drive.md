---
name: google-drive
description: Finding, opening, reading, creating and sharing files in Google Drive, Docs, Sheets and Slides, in the user's signed-in browser
match:
  urls: ["drive.google.com/*", "docs.google.com/*"]
  keywords: [google drive, drive, google doc, google docs, google sheet, google slides]
---

Prefer the drive_* actions (drive_search, drive_list, drive_read, drive_save_to_knowledge, drive_create_doc, drive_share) over clicking: they work in the chat's own Drive tab and read files as text.

- Account: every Drive and Docs address takes the account, `?authuser=<email>` (or `/u/<n>/` in the path, e.g. `https://drive.google.com/drive/u/1/my-drive`). If the tab lands on `accounts.google.com`, that account is not signed in: say "I'm on Google's sign-in page, please sign in" and wait. Never type a password.
- Search: `https://drive.google.com/drive/search?q=<words>`. The search box also takes `type:document`, `type:spreadsheet`, `type:presentation`, `type:pdf`, `owner:me`, `title:<words>`.
- Open a file by its id: `https://drive.google.com/open?id=<id>` goes to the right editor or viewer. Docs are `docs.google.com/document/d/<id>/edit`, Sheets `/spreadsheets/d/<id>/edit`, Slides `/presentation/d/<id>/edit`, other files `drive.google.com/file/d/<id>/view`, folders `drive.google.com/drive/folders/<id>`.
- Read as text: Docs `docs.google.com/document/d/<id>/export?format=txt` (or the light page `/mobilebasic`), Sheets `/spreadsheets/d/<id>/export?format=csv&gid=<tab>`, Slides `/presentation/d/<id>/export/txt`. These download a file when opened as a page: fetch them from a Docs tab instead. The Docs editor draws its text on a canvas, so the page itself has little text to read.
- New Doc: `https://docs.google.com/document/create?title=<title>` (add `&folder=<folder id>` for a folder). The title box at the top left renames it. Typing goes to the hidden text box (`docs-texteventtarget-iframe`); a paste there inserts the text.
- Share: the "Share" button at the top right of a Doc, or right-click a file in Drive → Share. Type the address, press Enter so it turns into a chip, pick Viewer / Commenter / Editor, then "Send". Sharing is a commit: it waits for the user's confirmation, with who and which role on the card. "General access" (anyone with the link) is also a permission change.
- Move to trash: select the file in Drive and press the trash icon ("Move to trash"), or File → Move to trash in an editor. That is a delete and waits for the user's confirmation. Never empty the trash.
- Uploading a file from the computer needs the user to pick it: leave that to them.

```selectors
row: [role="row"][data-id] || tr[data-id] || [role="gridcell"][data-id] || div[data-id][data-target="doc"]
rowName: [data-drive-name] || .KL4NAf || [data-column-field="6"] strong || strong
rowType: [data-drive-type] || [data-tooltip] || svg[aria-label] || img[alt]
emptyResults: [data-drive-empty] || .Ccie2c || [role="main"] [aria-live="polite"]
wordsDocument: Google Docs || Document
wordsSpreadsheet: Google Sheets || Spreadsheet
wordsPresentation: Google Slides || Presentation
wordsFolder: Folder || Shared folder
wordsPdf: PDF
noAccess: [data-drive-no-access] || #af-error-container || .jfk-bubble.request-access
docsTextTarget: iframe.docs-texteventtarget-iframe
docsTitle: input.docs-title-input || [aria-label="Rename"] input
shareButton: #docs-titlebar-share-client-button [role="button"] || [aria-label^="Share. "] || [data-tooltip^="Share"] || [aria-label="Share"]
shareEmail: [role="dialog"] input[type="email"] || [role="dialog"] input[aria-label*="people" i] || [role="dialog"] input[type="text"]
shareRoleButton: [role="dialog"] [aria-label*="role" i] || [role="dialog"] [aria-haspopup="listbox"]
shareRoleOption: [role="option"] || [role="menuitemradio"] || [role="menuitem"]
shareSend: [role="dialog"] button[aria-label="Send"] || [role="dialog"] [role="button"][aria-label="Send"] || [role="dialog"] button[aria-label="Share"]
roleViewer: Viewer
roleCommenter: Commenter
roleEditor: Editor
```
