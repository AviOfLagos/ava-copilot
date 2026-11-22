/**
 * Do-once keys (docs/growth-team.md, Part 2). Every step that sends, posts, submits, grants or creates writes one
 * of these BEFORE it acts, so a retry or a restarted background can tell what already happened and never does it
 * twice by itself.
 *
 * - 'started': written before the act. If the background dies before the result is recorded, the record stays
 *   here: the step may or may not have gone through, so it is never repeated without the user's click.
 * - 'done': the act returned and its result was recorded. A retry skips it.
 * - 'failed': the act certainly did not happen (the tool refused it, the page was never touched). It may run again.
 */
export type OnceStatus = 'started' | 'done' | 'failed';

export interface OnceRecord {
  // `${taskId}|${what}|${target}`: the primary key, so two writers can never both start the same step
  key: string;
  // The task the step belongs to: the same across resumes and retries, new for every new request
  taskId: string;
  threadId: string;
  // The kind of step: 'commit' for something committed on a page, 'tool' for a connector's tool, or a name of
  // its own ('whatsapp.send', 'drive.share')
  what: string;
  // What the step acts on, as a hash: the site and what is committed, or the tool and its arguments. Never the
  // content itself: a message's words are not kept here.
  target: string;
  // Where it acts, in the open, to find a cut-off step on the same site or tool: a host, or "connector:tool"
  scope: string;
  // A few words for the user and the model: "send on mail.example.com", "Nex Mail › send_email". No content.
  label: string;
  status: OnceStatus;
  // How many times it was started, counting runs the user asked for again
  attempts: number;
  // How many times the user ran it again after it was done: a tool that takes an idempotency key gets a new one
  // for each, and the same one for a step that was only cut off
  redone: number;
  startedAt: number;
  finishedAt: number | null;
  // A short outcome: what the page showed, or that the tool answered. No content.
  result: string | null;
  // When the model was last told this step already exists, so a second try in the same run goes to the user
  toldAt: number | null;
  // When the user, shown that this step was cut off, approved a different step on the same site or tool. From
  // then on it holds back only itself (its own key), not everything else there.
  ackAt: number | null;
}

export interface OnceStep {
  taskId: string;
  threadId: string;
  what: string;
  target: string;
  scope: string;
  label: string;
}
