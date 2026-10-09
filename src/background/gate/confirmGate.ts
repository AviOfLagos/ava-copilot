import type { ConfirmRequest } from '@extension/storage';

// How a request ended: the user approved it, the user refused it, or the task was stopped while it waited
export type GateAnswer = 'approved' | 'declined' | 'cancelled';

/**
 * Holds the requests that wait for the user's decision. One per task.
 * A request only ever resolves through the user's click or through the task being stopped,
 * so nothing that waits here can run by itself.
 */
export class ConfirmGate {
  private readonly waiting = new Map<string, (answer: GateAnswer) => void>();
  // What the user typed in answer to a request's questions, kept until the asker takes it
  private readonly replies = new Map<string, string[]>();

  /**
   * Shows a request to the user and waits for the answer.
   *
   * @param request - What the user is asked to decide
   * @param show - Delivers the request to the user
   * @param signal - Aborts when the task is stopped
   */
  async ask(
    request: ConfirmRequest,
    show: (request: ConfirmRequest) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<GateAnswer> {
    if (signal?.aborted) {
      return 'cancelled';
    }

    const answer = new Promise<GateAnswer>(resolve => {
      this.waiting.set(request.id, resolve);
      signal?.addEventListener('abort', () => this.settle(request.id, 'cancelled'), { once: true });
    });

    try {
      await show(request);
    } catch (error) {
      // A request the user never saw must not stay open
      this.settle(request.id, 'cancelled');
      throw error;
    }
    return answer;
  }

  /**
   * Records the user's answer to a waiting request.
   *
   * @returns false when no such request is waiting, e.g. it was already answered
   */
  answer(requestId: string, approved: boolean, replies?: string[]): boolean {
    if (approved && replies && this.waiting.has(requestId)) this.replies.set(requestId, replies);
    return this.settle(requestId, approved ? 'approved' : 'declined');
  }

  /** The user's answers to a request's questions, once; empty when there were none. */
  takeReplies(requestId: string): string[] {
    const replies = this.replies.get(requestId) ?? [];
    this.replies.delete(requestId);
    return replies;
  }

  /**
   * Ends every waiting request without approval. Called when the task stops.
   */
  cancelAll(): void {
    for (const id of [...this.waiting.keys()]) {
      this.settle(id, 'cancelled');
    }
  }

  get pendingCount(): number {
    return this.waiting.size;
  }

  private settle(requestId: string, answer: GateAnswer): boolean {
    const resolve = this.waiting.get(requestId);
    if (!resolve) {
      return false;
    }
    this.waiting.delete(requestId);
    resolve(answer);
    return true;
  }
}
