import type { ChannelDraft } from "./workspace";

export type SendResult = { status: "sent" | "transmitted" | "completed"; messageId?: string | null };
export type SendAttempt = { channel: string; draft: ChannelDraft; state: "queued" | "sent" | "transmitted" | "completed" | "error" | "unknown"; error?: unknown };

/** One pending send per channel. Completion keeps its original channel/draft. */
export class SendStatus {
  private attempts = new Map<string, SendAttempt>();
  private send: (channel: string, draft: ChannelDraft) => Promise<SendResult>;
  private changed: () => void;
  constructor(send: (channel: string, draft: ChannelDraft) => Promise<SendResult>, changed: () => void) { this.send = send; this.changed = changed; }

  get(channel: string): SendAttempt | undefined { return this.attempts.get(channel); }
  pending(channel: string): boolean { return this.get(channel)?.state === "queued"; }

  async submit(channel: string, draft: ChannelDraft): Promise<SendResult | undefined> {
    if (!channel || !draft.text.trim() || this.pending(channel)) return undefined;
    const attempt: SendAttempt = { channel, draft: { ...draft, reply: draft.reply ? { ...draft.reply } : null }, state: "queued" };
    this.attempts.set(channel, attempt);
    this.changed();
    try {
      const result = await this.send(channel, attempt.draft);
      if (!result || !["sent", "transmitted", "completed"].includes(result.status)) throw { code: "error.message.send_unknown" };
      attempt.state = result.status;
      return result;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      attempt.state = code === "error.message.send_unknown" ? "unknown" : "error";
      attempt.error = error;
      return undefined;
    } finally { this.changed(); }
  }

  forget(channel: string): void {
    if (!this.pending(channel)) this.attempts.delete(channel);
  }
}
