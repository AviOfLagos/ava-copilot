# Privacy

Avi Copilot is a personal, sideloaded fork of [Nanobrowser](https://github.com/nanobrowser/nanobrowser). It has no analytics and no server of its own.

- **Where data lives.** Chats, settings and API keys are stored in the browser's local extension storage. Removing the extension removes them.
- **What leaves the browser.** Page content (text, and screenshots when vision is on) and your task are sent to the LLM provider you configured, which is Gemini by default. Saving a Gemini key also sends that key to Google once, to check that it works.
- **What never leaves.** Cookies and saved logins. The agent does not read or send them.
