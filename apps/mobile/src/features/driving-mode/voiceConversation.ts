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

export interface VoiceBlock {
  readonly id: string;
  readonly text: string;
}

export interface VoiceReply {
  readonly status: "pending" | "completed" | "blocked" | "failed";
  readonly text: string;
  readonly blocks?: ReadonlyArray<VoiceBlock>;
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
  readonly playChime?: () => void;
  readonly chimeDelayMs?: number;
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
  private spokenBlockIds = new Set<string>();
  private isSpeakingBlock = false;

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
    this.isSpeakingBlock = false;
    this.spokenBlockIds.clear();
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
    if (
      (this.state.phase !== "waiting" && this.state.phase !== "speaking") ||
      this.pendingMessage === null
    ) {
      return;
    }
    const reply = this.dependencies.reply(this.pendingMessage);
    if (reply.status === "blocked" || reply.status === "failed") {
      this.pendingMessage = null;
      this.spokenBlockIds.clear();
      this.isSpeakingBlock = false;
      const generation = this.generation;
      void this.announceAndPause(
        reply.status === "blocked"
          ? "The agent needs your approval or an answer. Pause here and review the conversation when parked."
          : "The agent stopped before completing its reply. Review the conversation when parked.",
        generation,
      );
      return;
    }

    if (this.isSpeakingBlock) return;

    const unspokenBlocks = (reply.blocks ?? []).filter(
      (block) => !this.spokenBlockIds.has(block.id),
    );

    if (unspokenBlocks.length > 0) {
      const block = unspokenBlocks[0]!;
      this.spokenBlockIds.add(block.id);
      const generation = this.generation;
      void this.speakBlock(block, generation);
      return;
    }

    if (reply.status === "completed") {
      if (this.spokenBlockIds.size === 0 && reply.text.trim()) {
        const generation = this.generation;
        this.pendingMessage = null;
        void this.sayAndListen(spokenReply(reply.text), generation);
        return;
      }
      this.pendingMessage = null;
      this.spokenBlockIds.clear();
      const generation = this.generation;
      void this.listen(generation);
      return;
    }

    if (this.state.phase === "speaking") {
      this.setState("waiting");
    }
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
      this.spokenBlockIds.clear();
      this.isSpeakingBlock = false;
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

  private async speakBlock(block: VoiceBlock, generation: number): Promise<void> {
    this.isSpeakingBlock = true;
    try {
      this.dependencies.playChime?.();
      const delay = this.dependencies.playChime ? (this.dependencies.chimeDelayMs ?? 300) : 0;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      if (!this.current(generation)) return;

      const speech = spokenReply(block.text);
      this.setState("speaking", undefined, speech);
      await this.dependencies.speak(speech);
    } catch (error) {
      if (this.current(generation)) {
        this.fail(error);
        return;
      }
    } finally {
      if (this.current(generation)) {
        this.isSpeakingBlock = false;
        this.refresh();
      }
    }
  }

  private async sayAndListen(text: string, generation: number): Promise<void> {
    this.isSpeakingBlock = true;
    try {
      this.dependencies.playChime?.();
      const delay = this.dependencies.playChime ? (this.dependencies.chimeDelayMs ?? 300) : 0;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      if (!this.current(generation)) return;

      this.setState("speaking", undefined, text);
      await this.dependencies.speak(text);
      if (this.current(generation)) {
        this.isSpeakingBlock = false;
        await this.listen(generation);
      }
    } catch (error) {
      if (this.current(generation)) this.fail(error);
    } finally {
      if (this.current(generation)) {
        this.isSpeakingBlock = false;
      }
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
