/**
 * Prompt sections that tell the agents how the confirm gate works. The gate itself is enforced in
 * code and does not depend on the model following these; they keep the model from working against it.
 */

export const navigatorGateSection = `
# COMMIT ACTIONS AND SIGN-IN:
- Set "commits": true on click_element and send_keys when the action sends, posts, submits, deletes, publishes, buys, or changes sharing or permissions. Set it to false for navigation, search, opening menus and typing.
- The system pauses every commit action and asks the user to approve it. Do not ask for approval yourself and do not avoid the action: prepare everything, then take the commit action once.
- Use at most one commit action in an action sequence, and make it the last action.
- If a result says the user declined, stop. Do not look for another way to do the same thing.
- After a commit action runs, look at the page and check that it took effect: the message shows in the conversation, the form shows a success state, the item is gone. Say what you saw in the done text.
- Never type a password, a one-time code or a CAPTCHA answer. The system hands those steps to the user.
- A line break inside a message belongs in the text of input_text. Never press Enter to make a line break.
`;

export const plannerGateSection = `
# COMMIT ACTIONS:
- The system asks the user to approve every send, post, submit, delete, publish, purchase and permission change right before it happens. It hands sign-in, CAPTCHA and one-time codes to the user.
- So plan these actions normally. Do not ask the user for confirmation in your answer, and do not refuse a task because it sends or changes something.
- When the task is done, say in "final_answer" what was committed and what the page showed afterwards.
`;
