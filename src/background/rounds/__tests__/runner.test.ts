import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductProfile, ThreadRecord } from '@extension/storage';

const local: Record<string, unknown> = {};
const session: Record<string, unknown> = {};
vi.hoisted(() => {
  // Each locale key answers with itself and what it was given, so a test can read which line was written
  vi.stubGlobal('chrome', {
    i18n: { getMessage: (key: string, subs?: string | string[]) => [key, ...[subs ?? []].flat()].join('|') },
    storage: {
      local: {
        get: async (keys: string[]) =>
          Object.fromEntries(keys.filter(k => k in localStore()).map(k => [k, localStore()[k]])),
        set: async (items: Record<string, unknown>) => void Object.assign(localStore(), items),
        onChanged: { addListener: () => undefined },
      },
      session: {
        get: async (key: string) => ({ [key]: sessionStore()[key] }),
        set: async (items: Record<string, unknown>) => void Object.assign(sessionStore(), items),
      },
    },
  });
});
function localStore() {
  return local;
}
function sessionStore() {
  return session;
}

const world = {
  events: [] as { allDay: boolean; start: number; end: number }[],
  runs: [] as { startedAt: number }[],
  requestRun: vi.fn(async () => ({})),
  retry: vi.fn(async () => undefined),
  notices: [] as { title: string; key: string }[],
  collected: [] as string[],
  // Set to make the stuck-work round throw
  breakStuck: false,
};
vi.mock('../../agents/instance', () => ({
  agentService: {
    requestRun: (...args: unknown[]) => world.requestRun(...(args as [])),
    runsOf: async () => world.runs,
  },
}));
vi.mock('../../registry/services', () => ({
  services: () => ({ calendar: { reading: async () => ({ events: world.events }) }, threads: { retry: world.retry } }),
}));
vi.mock('../../integrations/instance', () => ({ connectorService: {} }));
vi.mock('../../notices', () => ({
  emitNotice: (notice: { title: string; key: string }) => world.notices.push(notice),
}));
vi.mock('../../growth/collect', () => ({
  collectProduct: async (profile: ProductProfile) => {
    world.collected.push(profile.workspaceId);
    return { source: 'product', notice: null };
  },
  markNoticed: async () => undefined,
}));
vi.mock('../../brief/manager', async () => {
  const { db } = await import('@extension/storage');
  return {
    inboxDecisions: async () =>
      (await db.inbox.toArray()).filter(item => item.kind === 'approval' && item.status === 'unread'),
    waitingRuns: async () => {
      if (world.breakStuck) throw new Error('The database is busy');
      return [];
    },
  };
});

const { db, emptyProductProfile, emptyRoundsState, growthStore, productStore, roundsStore, shiftDay, utcDay } =
  await import('@extension/storage');
const { answerCheckIn, tick } = await import('../runner');
const { productPulse } = await import('../rounds');

const at = (time: string, day = 19) => {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(2026, 10, day, hours, minutes, 0).getTime();
};
const items = async () =>
  (await db.inbox.toArray()).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
const titles = async () => (await items()).map(item => item.title);

const suture = (over: Partial<ProductProfile> = {}): ProductProfile => ({
  ...emptyProductProfile({ id: 'suture', name: 'Suture' }),
  agentApi: { kind: 'suture-agent-v1', baseUrl: 'https://admin.example.test/api/agent/v1' },
  ...over,
});

async function addMailAgent() {
  await db.agents.put({ id: 'mail', name: 'Mail', template: 'team_mail', enabled: true } as never);
}

const failedChat = (over: Partial<ThreadRecord> = {}) =>
  thread({
    id: 't2',
    title: 'Reply to Ada',
    origin: 'agent',
    status: 'error',
    error: { kind: 'failed', message: 'The page did not load' },
    failure: { cls: 'temporary', retryAt: null, reported: true },
    activeTask: 'Reply to Ada',
    ...over,
  });

function thread(over: Partial<ThreadRecord>): ThreadRecord {
  return {
    id: 't1',
    title: 'Post the launch',
    createdAt: at('08:00'),
    updatedAt: at('08:00'),
    status: 'idle',
    boundTabIds: [],
    ...over,
  } as ThreadRecord;
}

beforeEach(async () => {
  for (const key of Object.keys(local)) delete local[key];
  for (const key of Object.keys(session)) delete session[key];
  Object.assign(world, { events: [], runs: [], notices: [], collected: [], breakStuck: false });
  world.requestRun.mockClear();
  world.retry.mockClear();
  await Promise.all(
    [db.inbox, db.threads, db.agents, db.runs, db.growthMetrics, db.growthReadings, db.growthSources].map(table =>
      table.clear(),
    ),
  );
  // As a public build: no owner seed adds a product behind the test's back
  vi.stubEnv('VITE_SEED_PROFILE', '');
  // Stores keep what they last read in memory: start each test from an empty one
  await productStore.set({ items: {}, seeds: [] } as never);
  await roundsStore.set(emptyRoundsState(''));
  // The browser has been open since early morning
  session['rounds-started'] = at('06:00');
});

const offers = async () => (await items()).filter(item => item.kind === 'approval');
const quietDay = async () => {
  await addMailAgent();
  await roundsStore.update('2026-11-19', state => ({
    ...state,
    ran: { 'pulse|08:30': 1, 'pulse|16:00': 1, 'mail|09:00': 1, 'mail|14:00': 1, 'stuck|12:00': 1 },
  }));
};

/** Marks slots as run, so a test can look at the round it is about. */
const ranAlready = (...slots: string[]) =>
  roundsStore.update('2026-11-19', state => ({
    ...state,
    ran: { ...state.ran, ...Object.fromEntries(slots.map(slot => [slot, 1])) },
  }));

describe('rounds', () => {
  it('a day with no instructions still produces the round digests, one Inbox item each', async () => {
    await productStore.save(suture());
    for (const time of ['08:35', '09:05', '12:05', '14:05', '16:05']) await tick(at(time));
    const made = await titles();
    expect(made).toEqual(
      expect.arrayContaining(['rounds_pulse_title|08:30', 'rounds_stuck_title|12:00', 'rounds_pulse_title|16:00']),
    );
    // Mail could not be read (no Mail agent): said once for the day, not once per slot
    expect(made.filter(title => title.startsWith('rounds_mail_title'))).toHaveLength(1);
    expect((await items()).find(item => item.title.startsWith('rounds_mail_title'))?.body).toBe('rounds_mail_noAgent');
    expect(world.collected).toEqual(['suture', 'suture']);
  });

  it('runs one round a tick, and a slot never twice', async () => {
    await productStore.save(suture());
    await tick(at('08:35'));
    await tick(at('08:40'));
    expect(await titles()).toEqual(['rounds_pulse_title|08:30']);
  });

  it('runs a missed round once when the browser opens later that day, never several to catch up', async () => {
    await productStore.save(suture());
    // Opened at 17:00: five slots were missed
    for (const time of ['17:00', '17:05', '17:10', '17:15', '17:20']) await tick(at(time));
    const made = await titles();
    expect(made.filter(title => title.startsWith('rounds_pulse_title'))).toEqual(['rounds_pulse_title|16:00']);
    expect(made.filter(title => title.startsWith('rounds_stuck_title'))).toEqual(['rounds_stuck_title|12:00']);
    expect(world.collected).toEqual(['suture']);
    const state = await roundsStore.today('2026-11-19');
    expect(state.ran['pulse|08:30']).toBe(0);
  });

  it('does nothing when rounds are switched off', async () => {
    await productStore.save(suture());
    await roundsStore.setEnabled(false);
    await tick(at('12:05'));
    expect(await titles()).toEqual([]);
  });

  it('posts no pulse when there is no product to read', async () => {
    await tick(at('08:35'));
    expect(await titles()).toEqual([]);
  });

  it('asks the Mail agent for a run, unattended and once per slot, and posts nothing of its own', async () => {
    await addMailAgent();
    await ranAlready('pulse|08:30');
    await tick(at('09:05'));
    expect(world.requestRun).toHaveBeenCalledTimes(1);
    expect(world.requestRun.mock.calls[0]).toMatchObject([
      'mail',
      { attended: false, tainted: false, firingKey: 'round:mail:2026-11-19:09:00', queueIfBusy: true },
    ]);
    expect((world.requestRun.mock.calls[0] as unknown as [string, { task: string }])[1].task).toMatch(/Send nothing/);
    expect(await titles()).toEqual([]);
  });

  it('lists what is stuck and on whom', async () => {
    await db.threads.bulkPut([
      thread({
        id: 't1',
        title: 'Post the launch',
        status: 'waiting_confirm',
        pendingRequest: { mode: 'commit' } as never,
      }),
      thread({
        id: 't2',
        title: 'Reply to Ada',
        status: 'error',
        error: { kind: 'failed', message: 'The page did not load' },
        failure: { cls: 'temporary', retryAt: null, reported: true },
        activeTask: 'Reply to Ada',
        updatedAt: at('11:00'),
      }),
    ]);
    await ranAlready('pulse|08:30', 'mail|09:00');
    await tick(at('12:05'));
    const [stuck] = await items();
    expect(stuck?.title).toBe('rounds_stuck_title|12:00');
    expect(stuck?.body).toContain('Post the launch: rounds_stuck_approval');
    expect(stuck?.body).toContain('Reply to Ada: rounds_stuck_failed (The page did not load)');
    expect((await roundsStore.today('2026-11-19')).findings.failed).toEqual([
      { threadId: 't2', title: 'Reply to Ada' },
    ]);
  });
});

describe('never silent', () => {
  it('says so when a round fails, and does not run that slot again', async () => {
    await ranAlready('pulse|08:30', 'mail|09:00');
    world.breakStuck = true;
    await tick(at('12:05'));
    world.breakStuck = false;
    await tick(at('12:10'));
    const made = await items();
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ kind: 'alert', title: 'rounds_failed_title|rounds_name_stuck|12:00' });
    expect(made[0]?.body).toContain('The database is busy');
  });

  it('says so when a round was cut off by the background stopping, once', async () => {
    // As a background that died in the middle of the 12:00 round left it
    await ranAlready('pulse|08:30', 'mail|09:00');
    await roundsStore.update('2026-11-19', state => ({ ...state, ran: { ...state.ran, 'stuck|12:00': -1 } }));
    await tick(at('12:10'));
    await tick(at('12:15'));
    const made = await items();
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ title: 'rounds_failed_title|rounds_name_stuck|12:00', body: 'rounds_failed_cut' });
    expect((await roundsStore.today('2026-11-19')).ran['stuck|12:00']).toBe(0);
  });

  it('a whole day with no instructions: every digest, and at most two offers', async () => {
    await addMailAgent();
    await productStore.save(suture());
    // The background ticks every five minutes from early morning to late evening
    for (let minutes = 6 * 60; minutes < 23 * 60; minutes += 5) {
      await tick(at(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`));
    }
    const made = await items();
    const digests = made.filter(item => item.kind === 'result').map(item => item.title);
    expect(digests).toEqual(
      expect.arrayContaining(['rounds_pulse_title|08:30', 'rounds_stuck_title|12:00', 'rounds_pulse_title|16:00']),
    );
    expect(digests).toHaveLength(3);
    // Mail went to the Mail agent, once per slot
    expect(
      world.requestRun.mock.calls.map(call => (call as unknown as [string, { firingKey: string }])[1].firingKey),
    ).toEqual(['round:mail:2026-11-19:09:00', 'round:mail:2026-11-19:14:00']);
    expect(made.filter(item => item.kind === 'approval')).toHaveLength(2);
    expect(made.filter(item => item.kind === 'alert')).toHaveLength(0);
  });

  it('looking at the state never turns the day over', async () => {
    await quietDay();
    await tick(at('09:05'));
    // The settings screen looks first thing next morning, before any tick
    const peeked = await roundsStore.peek('2026-11-20');
    expect(peeked.checkins.offers).toBe(0);
    expect((await roundsStore.get())?.day).toBe('2026-11-19');
  });
});

describe('the product pulse', () => {
  // Wednesday 2026-11-18 is "yesterday" for a pulse on the 19th (UTC)
  const now = Date.parse('2026-11-19T07:30:00Z');
  const today = utcDay(now);
  const record = (metric: string, day: string, total: number, source: 'product' | 'slack' = 'product') =>
    growthStore.record({ ok: true, productId: 'suture', source, metric, date: day, total, readAt: now });

  it('flags a whole day that moved by half and by five, and never calls a day that is not over "down"', async () => {
    for (let back = 2; back <= 8; back++) await record('signups', shiftDay(today, -back), 4);
    await record('signups', shiftDay(today, -1), 12);
    await record('signups', today, 0);
    const pulse = await productPulse('08:30', { now: () => now, products: async () => [suture()] });
    expect(pulse.flagged).toEqual([
      { productId: 'suture', text: 'Suture: rounds_pulse_flagUp|rounds_metric_signups|12|4|rounds_pulse_yesterday' },
    ]);
    // Today so far is 0 against a usual 5: not flagged, the day has hardly begun
    expect(pulse.lines.join('\n')).toContain('rounds_pulse_metric|rounds_metric_signups|0|12|5.1');
    expect(pulse.lines.join('\n')).not.toContain('flagDown');
  });

  it('says "no reading" with the reason for a number it could not read, never 0', async () => {
    await growthStore.record({
      ok: false,
      productId: 'suture',
      source: 'product',
      metric: 'signups',
      date: today,
      reason: 'agent_api_off',
      detail: 'The API is switched off.',
      readAt: now,
    });
    const pulse = await productPulse('08:30', { now: () => now, products: async () => [suture()] });
    expect(pulse.lines).toContain('  rounds_pulse_noReading|rounds_metric_signups|growth_reason_agent_api_off');
    // When nothing at all could be read, for one reason, it is said once
    for (const metric of ['waitlist', 'access_requests', 'feedback']) {
      await growthStore.record({
        ok: false,
        productId: 'suture',
        source: 'product',
        metric,
        date: today,
        reason: 'agent_api_off',
        detail: 'The API is switched off.',
        readAt: now,
      });
    }
    const all = await productPulse('08:30', { now: () => now, products: async () => [suture()] });
    expect(all.lines).toEqual(['Suture (UTC)', '  rounds_pulse_noReading|growth_title|growth_reason_agent_api_off']);
    expect(pulse.flagged).toEqual([]);
  });

  it('counts Slack notifications by kind, keeps them, and says why when Slack was not read', async () => {
    const withSlack = suture({ agentApi: null, slackChannels: [{ name: '#suture-notifications', id: 'C0CKJC0CT4M' }] });
    const read = await productPulse('16:00', {
      now: () => now,
      products: async () => [withSlack],
      slack: async () => ({ ok: true, counts: { signup: 3, payment: 1 }, channels: 1 }),
    });
    expect(read.lines).toContain('  rounds_pulse_slack|signup 3, payment 1');
    expect((await growthStore.metrics('suture', 'slack_signup', today, today))[0]).toMatchObject({
      value: 3,
      source: 'slack',
    });

    const off = await productPulse('16:00', {
      now: () => now,
      products: async () => [withSlack],
      slack: async () => ({
        ok: false,
        reason: 'not_connected',
        detail: 'No Slack connector is on for this workspace.',
      }),
    });
    expect(off.lines).toContain('  rounds_pulse_slackOff|rounds_slack_not_connected');
  });

  it('tells the product notify channel only when something was flagged, and only over WhatsApp', async () => {
    await productStore.save(suture({ notify: 'whatsapp' }));
    for (let back = 2; back <= 8; back++) await record('signups', shiftDay(utcDay(at('08:35')), -back), 4);
    await record('signups', shiftDay(utcDay(at('08:35')), -1), 12);
    await tick(at('08:35'));
    expect(world.notices).toHaveLength(1);
    expect(world.notices[0]?.title).toContain('rounds_pulse_flagUp');
    expect((await items())[0]).toMatchObject({ priority: 'high' });

    // Nothing flagged at 16:00 (yesterday was already told): the Inbox item is quiet and no line goes out
    world.notices = [];
    await db.growthMetrics.clear();
    await db.growthReadings.clear();
    await tick(at('16:05'));
    expect(world.notices).toEqual([]);
  });
});

describe('check-ins', () => {
  it('offers help once after three quiet hours, built from what the rounds found', async () => {
    await addMailAgent();
    world.runs = [{ startedAt: at('09:02') }];
    await db.inbox.put({
      id: 'agent:mail|r1',
      source: 'agent:mail',
      externalId: 'r1',
      kind: 'result',
      title: 'Mail',
      body: '14 unread: 3 need you, 2 drafts ready.',
      agentId: 'mail',
      status: 'unread',
      createdAt: at('09:10'),
      updatedAt: at('09:10'),
    } as never);
    await roundsStore.update('2026-11-19', state => ({
      ...state,
      ran: { 'pulse|08:30': 1, 'mail|09:00': 1, 'stuck|12:00': 1 },
    }));
    await tick(at('13:00'));
    const offers = (await items()).filter(item => item.kind === 'approval');
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ title: 'checkin_mail|14', approval: { action: 'checkin' } });

    // Not again five minutes later, nor until three more quiet hours have passed
    await tick(at('13:05'));
    await tick(at('15:55'));
    expect((await items()).filter(item => item.kind === 'approval')).toHaveLength(1);
  });

  it('makes at most two offers a day', async () => {
    await quietDay();
    for (const time of ['09:05', '12:10', '15:15', '17:55']) await tick(at(time));
    expect(await offers()).toHaveLength(2);
    expect((await roundsStore.today('2026-11-19')).checkins.offers).toBe(2);
  });

  it('"not today" silences them until tomorrow', async () => {
    await quietDay();
    await tick(at('09:05'));
    const [offer] = await offers();
    await answerCheckIn(offer!.approval!.requestId, false, at('09:06'));
    await tick(at('12:30'));
    await tick(at('16:30'));
    expect(await offers()).toHaveLength(1);
    expect(world.requestRun).not.toHaveBeenCalled();

    // Tomorrow they are back, and yesterday's unanswered offers no longer wait in the Inbox
    await tick(at('09:05', 20));
    expect((await roundsStore.today('2026-11-20')).checkins.silenced).toBe(false);
  });

  it('a yes starts the offered work with the user there, and nothing before the yes', async () => {
    await quietDay();
    await tick(at('09:05'));
    expect(world.requestRun).not.toHaveBeenCalled();
    const [offer] = await offers();
    await answerCheckIn(offer!.approval!.requestId, true, at('09:06'));
    expect(world.requestRun).toHaveBeenCalledWith('mail', expect.objectContaining({ attended: true }));
  });

  it('never offers during a meeting, outside 09:00 to 18:00, or right after the user gave a task', async () => {
    await quietDay();
    world.events = [{ allDay: false, start: at('12:00'), end: at('13:00') }];
    await tick(at('12:30'));
    world.events = [];
    await tick(at('18:30'));
    await db.threads.put(thread({ id: 'mine', origin: 'user', runStartedAt: at('11:00'), createdAt: at('11:00') }));
    await tick(at('13:30'));
    expect(await offers()).toHaveLength(0);
    // An agent's own run does not count as the user being busy
    await db.threads.put(thread({ id: 'agents', origin: 'agent', runStartedAt: at('15:00'), createdAt: at('15:00') }));
    await tick(at('15:30'));
    expect(await offers()).toHaveLength(1);
  });

  it('offers to try failed tasks again when there is no mail to sort, and offers nothing when there is nothing to do', async () => {
    await roundsStore.update('2026-11-19', state => ({
      ...state,
      ran: { 'pulse|08:30': 1, 'pulse|16:00': 1, 'mail|09:00': 1, 'mail|14:00': 1, 'stuck|12:00': 1 },
    }));
    await tick(at('09:05'));
    expect(await offers()).toHaveLength(0);

    await db.threads.put(failedChat());
    await roundsStore.update('2026-11-19', state => ({
      ...state,
      findings: { ...state.findings, failed: [{ threadId: 't2', title: 'Reply to Ada' }] },
    }));
    await tick(at('09:10'));
    const [offer] = await offers();
    expect(offer?.title).toBe('checkin_retry|1|Reply to Ada');
    await answerCheckIn(offer!.approval!.requestId, true, at('09:11'));
    expect(world.retry).toHaveBeenCalledWith('t2');
  });

  it('takes an offer once: two clicks at once start the work once', async () => {
    await quietDay();
    await tick(at('09:05'));
    const [offer] = await offers();
    const id = offer!.approval!.requestId;
    await Promise.all([answerCheckIn(id, true, at('09:06')), answerCheckIn(id, true, at('09:06'))]);
    await answerCheckIn(id, true, at('09:07'));
    expect(world.requestRun).toHaveBeenCalledTimes(1);
    expect(world.requestRun.mock.calls[0]).toMatchObject(['mail', { attended: true, firingKey: id }]);
    // Answered: it no longer sits in the Inbox as something to decide
    expect((await offers())[0]).toMatchObject({ status: 'done' });
  });

  it('a "not today" on an offer that is no longer open silences nothing, and a forged id starts nothing', async () => {
    await quietDay();
    await answerCheckIn('checkin:2026-11-19:9', false, at('09:06'));
    await answerCheckIn('checkin:2026-11-19:9', true, at('09:06'));
    expect((await roundsStore.today('2026-11-19')).checkins.silenced).toBe(false);
    expect(world.requestRun).not.toHaveBeenCalled();
  });

  it('does not try again a chat the user already tried again meanwhile', async () => {
    await roundsStore.update('2026-11-19', state => ({
      ...state,
      ran: { 'pulse|08:30': 1, 'pulse|16:00': 1, 'mail|09:00': 1, 'mail|14:00': 1, 'stuck|12:00': 1 },
      findings: { failed: [{ threadId: 't2', title: 'Reply to Ada' }] },
    }));
    await db.threads.put(failedChat());
    await tick(at('09:10'));
    const [offer] = await offers();
    // The user pressed Retry themselves: the chat is running again
    await db.threads.put(failedChat({ status: 'running', error: null, failure: null }));
    await answerCheckIn(offer!.approval!.requestId, true, at('09:12'));
    expect(world.retry).not.toHaveBeenCalled();
  });

  it('tells the user when what they said yes to could not start', async () => {
    await quietDay();
    await tick(at('09:05'));
    const [offer] = await offers();
    world.requestRun.mockRejectedValueOnce(new Error('"Mail" has used its runs for today.'));
    await answerCheckIn(offer!.approval!.requestId, true, at('09:06'));
    const alert = (await items()).find(item => item.kind === 'alert');
    expect(alert).toMatchObject({ title: 'checkin_failed', body: '"Mail" has used its runs for today.' });
  });

  it('counts a follow-up in an old chat as the user being at work', async () => {
    await quietDay();
    // A chat from last week, written in again at 11:00
    await db.threads.put(thread({ id: 'old', origin: 'user', createdAt: at('08:00', 12), updatedAt: at('11:00') }));
    await tick(at('13:30'));
    expect(await offers()).toHaveLength(0);
    await tick(at('14:05'));
    expect(await offers()).toHaveLength(1);
  });

  it('closes offers nobody answered when the day turns, so they do not count as waiting on the user', async () => {
    await quietDay();
    await tick(at('09:05'));
    await tick(at('08:00', 20));
    expect((await offers())[0]).toMatchObject({ status: 'done' });
  });
});
