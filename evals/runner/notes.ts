import { expect } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { nameKey, ProviderTypeEnum } from '@extension/storage';
import type { Person, PersonUpdate, ResolveResult, Task } from '@extension/storage';
import { generateStructured } from '@src/background/llm/generate';
import { systemMessage, userMessage } from '@src/background/llm/messages';
import { createChatModel } from '@src/background/llm/providers';
import type { ChatModel } from '@src/background/llm/types';
import { NOTE_INSTRUCTIONS, noteSchema } from '@src/background/meetings/notes';
import { transcriptText } from '@src/background/meetings/segments';
import { recordMeetingUpdates } from '@src/background/followups/updates';
import { ownerNamesOf } from '@src/background/followups/owner';
import { LIVE_MODEL } from './planner';
import type { NoteUpdatesCase } from './cases';

/** A model that returns the recorded note. */
function replayModel(text: string): ChatModel {
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 0, text: 0, reasoning: undefined },
      },
      warnings: [],
    }),
  });
  return { provider: 'openai', modelName: 'replay', model, settings: {}, structuredMode: 'native' };
}

const liveModel = (): ChatModel =>
  createChatModel(
    { type: ProviderTypeEnum.Ollama, apiKey: 'ollama', baseUrl: process.env.AVA_EVAL_OLLAMA_URL },
    { provider: ProviderTypeEnum.Ollama, modelName: LIVE_MODEL! },
  );

/**
 * Replays a note-updates case: the note comes through the real note schema (from the recorded reply, or from the
 * live model when one is set), then through the code that keeps the updates, with the case's people and tasks.
 */
export async function runNoteUpdatesCase(evalCase: NoteUpdatesCase): Promise<void> {
  for (const pattern of evalCase.expect.prompt_matches ?? [])
    expect(NOTE_INSTRUCTIONS).toMatch(new RegExp(pattern, 'i'));
  if (!LIVE_MODEL && !evalCase.replay) throw new Error('The case has no recorded note and no live model is set');

  const started = new Date(evalCase.started).getTime();
  const segments = evalCase.transcript.map((line, index) => ({
    tStart: index * 10,
    tEnd: index * 10 + 9,
    speaker: line.speaker,
    text: line.text,
  }));
  const { output: note } = await generateStructured({
    chatModel: LIVE_MODEL ? liveModel() : replayModel(evalCase.replay!.note),
    schema: noteSchema,
    name: 'meeting_note',
    messages: [
      systemMessage(NOTE_INSTRUCTIONS),
      userMessage(`Meeting: Weekly sync on Google Meet.\nTranscript:\n${transcriptText(segments)}`),
    ],
  });

  // The case's people, each in the call's workspace, with their open tasks
  const people: Person[] = evalCase.people.map(
    (item, index) => ({ id: `per_eval${index}`, name: item.name }) as Person,
  );
  const tasks: Task[] = evalCase.people.flatMap((item, index) =>
    item.tasks.map(
      (title, n) =>
        ({
          id: `tsk_eval${index}${n}`,
          title,
          status: 'open',
          ownerId: `per_eval${index}`,
          source: { kind: 'manual' },
        }) as Task,
    ),
  );
  const closed: string[] = [];
  const saved = await recordMeetingUpdates(
    { id: 'mtg_eval', startedAt: started, endedAt: null, workspaceId: 'ws_eval' },
    note,
    segments,
    {
      people: {
        resolve: async (text): Promise<ResolveResult> => {
          const key = nameKey(text);
          const found = people.filter(
            person => nameKey(person.name) === key || nameKey(person.name).split(' ')[0] === key,
          );
          return found.length === 1 ? { person: found[0], via: 'name' } : found.length ? { candidates: found } : null;
        },
        observe: async () => ({ kind: 'skipped' }),
      },
      tasks: {
        list: async query => tasks.filter(task => !query.ownerId || task.ownerId === query.ownerId),
      },
      updates: { save: async (update: PersonUpdate) => update },
      owner: async () => ownerNamesOf('Avi Example'),
    },
  );
  // Reading a call never closes anything: only Avi's click does
  for (const task of tasks) if (task.status !== 'open') closed.push(task.id);
  expect(closed, 'tasks closed by reading the call').toEqual([]);

  // A model may write "Ada Obi" where the call says "Ada": the same person, so names compare by their first word
  const first = (name: string) => nameKey(name).split(' ')[0];
  expect(saved.map(update => first(update.name)).sort(), 'who gave an update').toEqual(
    evalCase.expect.updates.map(update => first(update.name)).sort(),
  );
  for (const want of evalCase.expect.updates) {
    const got = saved.find(update => first(update.name) === first(want.name))!;
    const label = `${want.name}'s update`;
    const person = people.find(item =>
      [nameKey(item.name), nameKey(item.name).split(' ')[0]].includes(nameKey(want.name)),
    );
    expect(got.personId, `${label}: resolved`).toBe(person?.id ?? null);
    if (want.did) expect(got.did.length, `${label}: did`).toBe(want.did.length);
    for (const pattern of want.doing_matches ?? [])
      expect(got.doing.join(' | '), `${label}: doing`).toMatch(new RegExp(pattern, 'i'));
    for (const pattern of want.next_matches ?? [])
      expect(got.next.join(' | '), `${label}: next`).toMatch(new RegExp(pattern, 'i'));
    if (want.by) expect(got.by, `${label}: by`).toBe(want.by);
    if (want.offers) {
      const offered = (got.offers ?? []).map(offer => tasks.find(task => task.id === offer.taskId)?.title);
      expect(offered, `${label}: Mark done? offers`).toEqual(want.offers);
    }
  }
}
