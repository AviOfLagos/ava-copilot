# Privacy

Ava Copilot is a fork of [Nanobrowser](https://github.com/nanobrowser/nanobrowser). It has no server, no account and
no analytics. The full, current page is the site's `/privacy` (source: `site/src/content/site.ts`).

- **Stays in your browser.** Chats, meeting notes and transcripts, tasks, people and the words you taught her to spell (each kept
  for one workspace), memory, routines, agents, the Inbox and settings (IndexedDB and the extension's storage).
  Screen recordings are kept in a database of their own and are never part of a backup. API keys and connector sign-ins are encrypted in a local vault (AES-GCM, a
  key the browser will not export); pages and settings only ever see the last four characters. Removing the
  extension deletes all of it.
- **Leaves, to the services you chose.** Your task, the text of the page it works on (a screenshot only when vision
  is on) and the context the task needs go to your model provider. Meeting audio, dictation and Gemini Live voice go
  to your speech provider; in economy voice mode speech is written down on your computer and only text leaves. A screen recording goes to your Google
  Drive only if you connect Drive, private until you press Share. WhatsApp messages travel through WhatsApp if you
  link it. Names Ava has learned reach your model only inside a chat or meeting note, and a backup to Ava Brain on your Mac
  includes your tasks and people. Tool calls go to the MCP connectors you added. With a local model (Ollama, LM Studio), page text stays on your computer.
- **Never leaves.** Cookies and saved passwords are never read. The "Hey Ava" wake word runs on your computer. Nothing
  is sent to us: there is no server of ours.
