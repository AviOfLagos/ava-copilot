/**
 * Messages the panel sent and the background has not yet taken. The composer empties the moment Send is pressed,
 * so a send the background refuses, or never hears because it restarted, would otherwise lose the words; here they
 * wait until the background confirms, and come back to the composer if it does not.
 */
export class PendingSends {
  private readonly texts = new Map<string, string>();

  /** A message just sent, keyed by the client id its answer carries. */
  add(clientId: string, text: string): void {
    if (text.trim()) this.texts.set(clientId, text);
  }

  /** The background took it: nothing to keep. */
  confirm(clientId: string | undefined): void {
    if (clientId) this.texts.delete(clientId);
  }

  /** The background refused it: its words, to put back in the composer, or null when there is nothing to put back. */
  fail(clientId: string | undefined): string | null {
    if (!clientId) return null;
    const text = this.texts.get(clientId) ?? null;
    this.texts.delete(clientId);
    return text;
  }

  /** The connection to the background broke: every message still waiting, joined in the order sent. */
  failAll(): string | null {
    const texts = [...this.texts.values()];
    this.texts.clear();
    return texts.length ? texts.join('\n\n') : null;
  }
}
