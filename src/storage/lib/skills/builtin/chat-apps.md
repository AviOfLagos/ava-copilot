---
name: chat-apps
description: Posting and reading in chat apps (Slack, Discord, Teams, WhatsApp Web, Telegram)
match:
  urls:
    - "app.slack.com/*"
    - "*.slack.com/*"
    - "discord.com/channels/*"
    - "teams.microsoft.com/*"
    - "web.whatsapp.com/*"
    - "web.telegram.org/*"
  keywords: [slack, discord, whatsapp, telegram, teams chat]
---

- Find a channel or person with the app's quick switcher rather than scrolling the sidebar: Ctrl+K (Cmd+K on a Mac) in Slack and Discord, the search box at the top in Teams, WhatsApp and Telegram. Type the name, then pick the exact match from the list.
- Check the header shows the channel or person you meant before writing. "#general" in one workspace is not the same as in another.
- The message box is usually a `div` with role "textbox", not an `<input>`. Click it before typing.
- Enter sends. For a line break inside a message, type the text with line breaks: the agent turns them into Shift+Enter.
- Typing `@` or `#` opens a suggestion list. Pick the right entry or press Escape before going on, or the next key may pick the first suggestion.
- Sending is a commit and waits for the user's confirmation. After sending, check the message shows in the conversation.
- Threads: reply in a thread through the message's "Reply in thread" or reply button, which opens a side pane with its own message box.
- Edit and delete are on the message's hover menu ("More actions", three dots). Deleting is a commit.
