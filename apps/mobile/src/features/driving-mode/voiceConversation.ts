export type VoicePhase =
  | "paused"
  | "preparing"
  | "listening"
  | "sending"
  | "waiting"
  | "speaking"
  | "error";

export interface VoiceConversationState {
  readonly phase: VoicePhase;
  readonly transcript: string;
  readonly agentReply: string;
  readonly error: string | null;
}

export interface VoiceReply {
  readonly status: "pending" | "completed" | "blocked" | "failed";
  readonly text: string;
}

export interface VoiceConversationDependencies {
  readonly prepare: () => Promise<void>;
  readonly listen: () => Promise<string>;
  readonly speak: (text: string) => Promise<void>;
  readonly stopAudio: () => void;
  readonly validate: () => string | null;
  readonly send: (text: string, messageId: string) => Promise<void>;
  readonly reply: (messageId: string) => VoiceReply;
  readonly messageId: () => string;
  readonly notifyPhaseChange?: (phase: VoicePhase) => void;
}

export function spokenReply(markdown: string): string {
  const text = markdown
    .replace(/```[\s\S]*?(?:```|$)/g, " Code is available in the conversation. ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " link ")
    .replace(/[#*_`~>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 2400
    ? `${text.slice(0, 2400)}. The rest is available in the conversation.`
    : text || "The reply is available in the conversation.";
}

export class VoiceConversation {
  private state: VoiceConversationState = {
    phase: "paused",
    transcript: "",
    agentReply: "",
    error: null,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private pendingMessage: string | null = null;
  private enabled = false;

  constructor(private readonly dependencies: VoiceConversationDependencies) {}

  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async start(): Promise<void> {
    if (this.enabled) return;
    const generation = ++this.generation;
    this.enabled = true;
    this.setState("preparing");
    try {
      await this.dependencies.prepare();
      if (!this.current(generation)) return;
      // A paused conversation may still have a committed turn running on the server.
      if (this.pendingMessage !== null) {
        this.setState("waiting");
        this.refresh();
      } else {
        await this.listen(generation);
      }
    } catch (error) {
      if (this.current(generation)) this.fail(error);
    }
  }

  pause(): void {
    this.enabled = false;
    this.generation += 1;
    this.dependencies.stopAudio();
    this.setState("paused");
  }

  refresh(): void {
    if (!this.enabled) return;
    if (this.state.phase === "listening") {
      const reason = this.dependencies.validate();
      if (reason) this.fail(new Error(reason));
      return;
    }
    if (this.state.phase !== "waiting" || this.pendingMessage === null) return;
    const reply = this.dependencies.reply(this.pendingMessage);
    if (reply.status === "pending") return;
    this.pendingMessage = null;
    const generation = this.generation;
    if (reply.status === "blocked" || reply.status === "failed") {
      void this.announceAndPause(
        reply.status === "blocked"
          ? "The agent needs your approval or an answer. Pause here and review the conversation when parked."
          : "The agent stopped before completing its reply. Review the conversation when parked.",
        generation,
      );
      return;
    }
    void this.sayAndListen(spokenReply(reply.text), generation);
  }

  private current(generation: number): boolean {
    return this.enabled && generation === this.generation;
  }

  private async listen(generation: number): Promise<void> {
    if (!this.current(generation)) return;
    const reason = this.dependencies.validate();
    if (reason) {
      this.fail(new Error(reason));
      return;
    }
    this.setState("listening");
    try {
      const transcript = (await this.dependencies.listen()).trim();
      if (!this.current(generation)) return;
      if (!transcript) {
        this.pause();
        return;
      }
      const blocked = this.dependencies.validate();
      if (blocked) {
        this.fail(new Error(blocked));
        return;
      }
      const messageId = this.dependencies.messageId();
      this.pendingMessage = messageId;
      this.setState("sending", transcript, "");
      await this.dependencies.send(transcript, messageId);
      if (!this.current(generation)) return;
      this.setState("waiting");
      this.refresh();
    } catch (error) {
      // Never retry a send automatically: a lost receipt can still mean it committed.
      if (this.current(generation)) {
        if (this.state.phase === "sending") this.pendingMessage = null;
        this.fail(error);
      }
    }
  }

  private async sayAndListen(text: string, generation: number): Promise<void> {
    this.setState("speaking", undefined, text);
    try {
      await this.dependencies.speak(text);
      if (this.current(generation)) await this.listen(generation);
    } catch (error) {
      if (this.current(generation)) this.fail(error);
    }
  }

  private async announceAndPause(text: string, generation: number): Promise<void> {
    this.setState("speaking", undefined, text);
    try {
      await this.dependencies.speak(text);
    } catch {
      /* The status remains visible if the audio route is interrupted. */
    }
    if (this.current(generation)) {
      this.pause();
      this.setState("error", undefined, undefined, text);
    }
  }

  private fail(error: unknown): void {
    this.pause();
    this.setState(
      "error",
      undefined,
      undefined,
      error instanceof Error ? error.message : "Voice chat stopped.",
    );
  }

  private setState(
    phase: VoicePhase,
    transcript = this.state.transcript,
    agentReply = this.state.agentReply,
    error: string | null = null,
  ): void {
    const previousPhase = this.state.phase;
    this.state = { phase, transcript, agentReply, error };
    if (previousPhase !== phase) {
      this.dependencies.notifyPhaseChange?.(phase);
    }
    for (const listener of this.listeners) listener();
  }
}
