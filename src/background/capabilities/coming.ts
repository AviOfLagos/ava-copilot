/**
 * What Ava cannot do yet but is being built, so "can you…?" gets "not yet, it's coming" rather than a flat no or a
 * made-up yes. Take an entry out in the change that ships it.
 */
export interface ComingCapability {
  what: string;
  // The GitHub issue it is built in
  issue: number;
}

export const COMING: ComingCapability[] = [
  {
    what: 'Replying with a voice note on WhatsApp, showing "typing…", reacting to and quoting messages (today: replies are text; voice notes the user sends are written down and read)',
    issue: 19,
  },
  { what: 'Taking part in WhatsApp groups (answering when mentioned)', issue: 20 },
];
