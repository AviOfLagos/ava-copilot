// In a conversation "Hey Ava" started while sound was playing, or with sound since, the order may have
// come from that sound: every tool needs a click, the ones that only read too, since an answer spoken
// aloud can reach a call. Only these need none; a tool added later is guarded until listed here.
export const UNGUARDED_TOOLS = new Set(['stop_tasks', 'end_conversation']);
// How the click-to-allow notice names each tool; one not named here is "act for you"
export const TOOL_ACTIONS: Record<string, string> = {
  run_browser_task: 'run a task in the browser',
  open_tab: 'open a site',
  switch_tab: 'switch tabs',
  join_next_meeting: 'join your next meeting',
  leave_call: 'leave the call',
  end_call_for_everyone: 'end the call for everyone',
  remember_this: 'save to your knowledge base',
  read_page: 'read a page aloud',
  list_tabs: 'list your open tabs',
  list_frequent_sites: 'list the sites you visit',
  get_schedule: 'read your calendar',
  ask_meeting: 'answer from your meeting notes',
  ask_knowledge: 'answer from your knowledge base',
  think: 'answer a question',
  get_status: 'read out your tasks',
  get_brief: 'read your morning brief',
};
