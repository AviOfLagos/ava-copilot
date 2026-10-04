---
name: google-forms
description: Filling in a Google Form
match:
  urls: ["docs.google.com/forms/*", "forms.gle/*"]
  keywords: [google form]
---

- Questions with a red asterisk are required. The form does not go to the next section until they are answered.
- Short answer and paragraph fields are plain text boxes. Some have rules (an email, a number); a red message under the field says what is wrong.
- Multiple choice is a radio group: click the option's label. Checkboxes allow several.
- Dropdowns are not real `<select>` elements: click the box to open the list (role "listbox"), then click the option. Use get_dropdown_options only if it works; otherwise click.
- Dates and times are separate boxes for day, month, year, hour and minute, in the order the user's locale shows.
- Long forms have sections: "Next" goes on, "Back" returns, "Submit" is only on the last one.
- "Submit" is a commit and waits for the user's confirmation. Before it, read back every answer from the page, not from memory.
- "Clear form" erases everything; never use it unless asked.
- A form that needs a Google sign-in, or a file upload, is a step for the user.
