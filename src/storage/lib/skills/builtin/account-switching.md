---
name: account-switching
description: Checking which account is signed in, and switching to the workspace's account, on Google, X, LinkedIn, YouTube, Instagram, Slack and GitHub
match:
  urls: ["*.google.com/*", "x.com/*", "twitter.com/*", "*.linkedin.com/*", "*.youtube.com/*", "*.instagram.com/*", "*.slack.com/*", "github.com/*"]
  keywords: [switch account, which account, sign in as, post as]
---

Check first, then switch. Never sign out of an account to switch: other tabs may be using it.

- Google (Gmail, Meet, Calendar, Drive, YouTube Studio): the signed-in account shows in the avatar at the top right (its tooltip or menu shows the email). Every Google address takes the account in the URL: add `authuser=<email>` as a query parameter, e.g. `https://mail.google.com/mail/?authuser=avi@nexprove.com`, `https://meet.google.com/new?authuser=…`, `https://calendar.google.com/calendar/r?authuser=…`. If the page then asks to sign in or shows another account, that account is not signed in on this browser: stop and ask the user to sign in.
- X: the avatar at the bottom left of the side menu opens the account menu; signed-in accounts are listed there with "Add an existing account". Pick the handle; the page reloads as it.
- LinkedIn: one person per browser. To post as a company page, go to the page (Me → Pages, or `linkedin.com/company/<page>/admin/`) and use "Create" / "Start a post" there; the post box shows the page name when posting as the page.
- YouTube: avatar at the top right → "Switch account" lists accounts and their channels.
- Instagram: profile → the username at the top (or the menu) → "Switch accounts".
- Slack: each workspace has its own address, `<workspace>.slack.com`; the workspace switcher is on the far left in the app. Being in the right workspace is what matters.
- GitHub: one account per browser session, shown in the avatar menu at the top right. Use the `gh` command line for another account instead of the browser.

Once switched, say which account is now active in your next memory note, and check it again before any send, post or publish. Switching accounts never replaces the user's confirmation of a send or post.
