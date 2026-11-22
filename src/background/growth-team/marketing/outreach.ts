import { canonicalEmail, teamContactId, teamStore } from '@extension/storage';
import type { ProductProfile, SuppressedAddress } from '@extension/storage';
import { addressRefusal, isEmail } from '../addresses';
import { propose } from '../queue';
import type { Proposal, ProposeResult, QueueDeps } from '../queue';

/**
 * The Product Marketing Manager's outreach (docs/growth-team.md, Parts 8 and 12), drafts only until Nex Mail
 * lands. The model finds a person through a public, relevant source and writes the email; code keeps the rules:
 * no suppressed address, no personal address, at most 20 new people a day for a product, one follow-up after 3
 * working days and then stop, and every email names the sender, the postal address, why this person gets it and
 * how to opt out. A missing sender or postal address is shown as "not set", never filled in.
 */

// New people a product's outreach may reach in a day, to start (Part 12)
export const NEW_PEOPLE_PER_DAY = 20;
// A follow-up waits this many working days after the first email
export const FOLLOW_UP_AFTER_WORKING_DAYS = 3;

export interface OutreachInput {
  email: string;
  // The public page where the person was found
  source: string;
  // Why they are relevant, in one line: it goes in the email too
  why: string;
  subject: string;
  body: string;
}

export type OutreachResult =
  | { state: 'refused'; why: string }
  | { state: 'drafted'; text: string; result: Exclude<ProposeResult, { state: 'refused' }>; missing: string[] };

export type OutreachDeps = QueueDeps;

const startOfLocalDay = (at: number) => {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/** Whole Monday-to-Friday days between two moments, in local time: the day it started and today do not count. */
export function workingDaysBetween(from: number, to: number): number {
  let count = 0;
  const day = new Date(startOfLocalDay(from));
  const end = startOfLocalDay(to);
  for (day.setDate(day.getDate() + 1); day.getTime() < end; day.setDate(day.getDate() + 1)) {
    const weekday = day.getDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

function publicSource(source: string): string | null {
  try {
    const url = new URL(source.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** What the email always ends with, set by code. */
export function outreachFooter(profile: ProductProfile, why: string): { text: string; missing: string[] } {
  const from = profile.email?.from?.trim() ?? '';
  const postal = profile.postalAddress?.trim() ?? '';
  const missing = [!from && 'the sender address', !postal && 'the postal address'].filter((value): value is string =>
    Boolean(value),
  );
  return {
    text: [
      '--',
      `${profile.name}${from ? ` · ${from}` : ' · sender: not set'}`,
      postal || 'Postal address: not set',
      `Why you are getting this: ${why}`,
      'Reply "stop" and you will not hear from us again.',
    ].join('\n'),
    missing,
  };
}

/** Drafts the first email to a person, for the user's approval. */
export async function draftOutreach(
  profile: ProductProfile,
  who: Pick<Proposal, 'workspaceId' | 'agentId' | 'agentName'>,
  input: OutreachInput,
  deps: OutreachDeps = {},
): Promise<OutreachResult> {
  const now = deps.now?.() ?? Date.now();
  const email = canonicalEmail(input.email);
  const refused = await addressRefusal(email);
  if (refused) return { state: 'refused', why: refused };
  const source = publicSource(input.source);
  if (!source) return { state: 'refused', why: 'Give the public page where you found this person, as a link.' };
  const why = input.why.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!why) return { state: 'refused', why: 'Say why this person is relevant, in one line.' };

  // The person takes one of the day's places first, so two drafts at once cannot pass the limit together
  const contact = {
    id: teamContactId(profile.workspaceId, email),
    workspaceId: profile.workspaceId,
    email,
    source,
    why,
    firstAt: now,
    followUps: 0,
    lastAt: now,
    itemId: null,
  };
  const place = await teamStore.reserveContact(contact, startOfLocalDay(now), NEW_PEOPLE_PER_DAY);
  if (place === 'exists') {
    return {
      state: 'refused',
      why: 'This person was written to before. The only next step is one follow-up, with draft_follow_up, 3 working days after the user approved the first email.',
    };
  }
  if (place === 'full') {
    return {
      state: 'refused',
      why: `At most ${NEW_PEOPLE_PER_DAY} new people a day for one product, and that many were drafted today. The rest wait for tomorrow.`,
    };
  }

  const footer = outreachFooter(profile, why);
  const result = await propose(
    {
      ...who,
      action: 'outreach_email',
      title: input.subject.replace(/\s+/g, ' ').trim().slice(0, 140),
      body: input.body.trim(),
      footer: footer.text,
      target: email,
      why: `${why} (found at ${source})`,
      onceKey: `outreach:${email}`,
      allowedLinks: [source],
    },
    deps,
  ).catch(async error => {
    await teamStore.forgetContact(contact.id);
    throw error;
  });
  if (result.state === 'refused') {
    await teamStore.forgetContact(contact.id);
    return { state: 'refused', why: result.why };
  }
  await teamStore.saveContact({ ...contact, itemId: result.item.id });
  return { state: 'drafted', result, missing: footer.missing, text: draftedText(footer.missing) };
}

/** Drafts the one follow-up a person may get, after 3 working days. */
export async function draftFollowUp(
  profile: ProductProfile,
  who: Pick<Proposal, 'workspaceId' | 'agentId' | 'agentName'>,
  input: Pick<OutreachInput, 'email' | 'subject' | 'body'>,
  deps: OutreachDeps = {},
): Promise<OutreachResult> {
  const now = deps.now?.() ?? Date.now();
  const email = canonicalEmail(input.email);
  const refused = await addressRefusal(email);
  if (refused) return { state: 'refused', why: refused };
  const contact = await teamStore.contact(profile.workspaceId, email);
  if (!contact) return { state: 'refused', why: 'Nobody wrote to this person first: a follow-up needs a first email.' };
  if (contact.followUps >= 1) {
    return { state: 'refused', why: 'This person had their one follow-up. Outreach to them stops here.' };
  }
  // The clock runs from the user's yes to the first email, never from a draft nobody approved
  const first = contact.itemId ? await teamStore.get(contact.itemId) : undefined;
  if (!first || !['held', 'done'].includes(first.status) || !first.decidedAt) {
    return {
      state: 'refused',
      why:
        first?.status === 'declined' || first?.status === 'failed' || first?.status === 'refused'
          ? 'The first email to this person did not go ahead, so there is nothing to follow up.'
          : 'The first email to this person still waits for the user; a follow-up comes 3 working days after their yes.',
    };
  }
  const waited = workingDaysBetween(first.decidedAt, now);
  if (waited < FOLLOW_UP_AFTER_WORKING_DAYS) {
    return {
      state: 'refused',
      why: `A follow-up waits ${FOLLOW_UP_AFTER_WORKING_DAYS} working days after the first email; ${waited} have passed.`,
    };
  }
  const footer = outreachFooter(profile, contact.why);
  const result = await propose(
    {
      ...who,
      action: 'follow_up',
      title: input.subject.replace(/\s+/g, ' ').trim().slice(0, 140),
      body: input.body.trim(),
      footer: footer.text,
      target: email,
      why: `Follow-up, ${waited} working days after the first email`,
      onceKey: `follow-up:${email}`,
      allowedLinks: [contact.source],
    },
    deps,
  );
  if (result.state === 'refused') return { state: 'refused', why: result.why };
  await teamStore.saveContact({ ...contact, followUps: contact.followUps + 1, lastAt: now });
  return { state: 'drafted', result, missing: footer.missing, text: draftedText(footer.missing) };
}

function draftedText(missing: string[]): string {
  const base = 'Drafted for the user to approve; nothing was sent.';
  return missing.length
    ? `${base} It cannot go out until ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} set in the product profile: say so in your answer.`
    : base;
}

/** A reply, an unsubscribe or a bounce: no agent writes to the address again, for any product. */
export async function stopContact(email: string, why: SuppressedAddress['why'], now = Date.now()): Promise<string> {
  const address = canonicalEmail(email);
  if (!isEmail(address)) return `"${email}" is not an email address.`;
  await teamStore.suppress(address, why, now);
  return `${address} is on the do-not-write list (${why}). No agent writes to it again.`;
}
