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
  { what: 'Taking part in WhatsApp groups (answering when mentioned)', issue: 20 },
];
