import { describe, expect, it } from 'vitest';
import { taskCommandOf } from '../task-commands';

// Every row of the table in docs/pm-desk.md Part 8, as he would type it. Made-up names.
describe('task commands on WhatsApp, read in code', () => {
  it.each([
    ['done 2', { kind: 'set', status: 'done', numbers: [2] }],
    ['Done 2.', { kind: 'set', status: 'done', numbers: [2] }],
    ['2 done', { kind: 'set', status: 'done', numbers: [2] }],
    ['2 is done', { kind: 'set', status: 'done', numbers: [2] }],
    ['done 2 4 5', { kind: 'set', status: 'done', numbers: [2, 4, 5] }],
    ['done 2, 4 and 5', { kind: 'set', status: 'done', numbers: [2, 4, 5] }],
    ['done #3', { kind: 'set', status: 'done', numbers: [3] }],
    ['2 4 done', { kind: 'set', status: 'done', numbers: [2, 4] }],
    ['done 2 2', { kind: 'set', status: 'done', numbers: [2] }],
    ['ava, done 1', { kind: 'set', status: 'done', numbers: [1] }],
    ['finished 3', { kind: 'set', status: 'done', numbers: [3] }],
    // As a voice note writes them
    ['Done, 2.', { kind: 'set', status: 'done', numbers: [2] }],
    ['Done two.', { kind: 'set', status: 'done', numbers: [2] }],
    ['done two and five', { kind: 'set', status: 'done', numbers: [2, 5] }],
    ['Two, done.', { kind: 'set', status: 'done', numbers: [2] }],
    ['undo 2', { kind: 'set', status: 'open', numbers: [2] }],
    ['reopen 2', { kind: 'set', status: 'open', numbers: [2] }],
    ['re-open 2', { kind: 'set', status: 'open', numbers: [2] }],
    ['drop 2', { kind: 'set', status: 'dropped', numbers: [2] }],
    ['tasks', { kind: 'list', word: null, as: null }],
    ['Tasks', { kind: 'list', word: null, as: null }],
    ['my tasks', { kind: 'list', word: null, as: null }],
    ['tasks?', { kind: 'list', word: null, as: null }],
    ['tasks ada.', { kind: 'list', word: 'ada', as: null }],
    ['tasks ada', { kind: 'list', word: 'ada', as: null }],
    ['tasks ember', { kind: 'list', word: 'ember', as: null }],
    ['tasks tech ember', { kind: 'list', word: 'tech ember', as: null }],
    ['tasks for ada', { kind: 'list', word: 'ada', as: 'person' }],
    ['tasks in ember?', { kind: 'list', word: 'ember', as: 'workspace' }],
    ['task for ada: send the deck by friday', { kind: 'add', owner: 'ada', words: 'send the deck by friday' }],
    ['Task for Ada Obi - book the room', { kind: 'add', owner: 'Ada Obi', words: 'book the room' }],
    ['task for Mary-Jane: call the venue', { kind: 'add', owner: 'Mary-Jane', words: 'call the venue' }],
    ['Task for Ada, send the invoice', { kind: 'add', owner: 'Ada', words: 'send the invoice' }],
    ["who's next", { kind: 'next' }],
    ['who’s next?', { kind: 'next' }],
    ['who is next', { kind: 'next' }],
  ])('"%s"', (text, command) => {
    expect(taskCommandOf(text)).toEqual(command);
  });

  it.each([
    // Not the whole message, or not a command: goes to the chat
    'done',
    'I am done 2 days early',
    'done with 2 of them, the rest tomorrow',
    'what are my tasks for this week and what is late',
    'task for ada',
    'can you list tasks',
    'tasks: please sort them',
    // Chat that starts with "tasks": more than a name
    'Tasks for the launch are all on Notion, can you check?',
    'tasks are piling up on the board today',
    '2',
    'done 0',
    'done 1000',
    'done 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16',
    'delete that',
    '',
  ])('"%s" is not a task command', text => {
    expect(taskCommandOf(text)).toBeNull();
  });
});
