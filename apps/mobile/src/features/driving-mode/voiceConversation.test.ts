import { describe, expect, it, vi } from "vite-plus/test";
import { VoiceConversation, spokenReply, type VoiceReply } from "./voiceConversation";

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  let recording = deferred<string>();
  let playback = deferred<void>();
  let reply: VoiceReply = { status: "pending", text: "" };
  let blocked: string | null = null;
  let sequence = 0;
  const listen = vi.fn(() => recording.promise);
  const speak = vi.fn(() => playback.promise);
  const playChime = vi.fn();
  const send = vi.fn(async (_text: string, _id: string) => {});
  const stopAudio = vi.fn();
  const prepare = vi.fn(async () => {});
  const conversation = new VoiceConversation({
    prepare,
    listen,
    speak,
    playChime,
    chimeDelayMs: 0,
    send,
    stopAudio,
    validate: () => blocked,
    reply: () => reply,
    messageId: () => `message-${++sequence}`,
  });
  const phase = (expected: string) =>
    new Promise<void>((resolve) => {
      if (conversation.getSnapshot().phase === expected) {
        resolve();
        return;
      }
      const release = conversation.subscribe(() => {
        if (conversation.getSnapshot().phase === expected) {
          release();
          resolve();
        }
      });
    });
  return {
    conversation,
    listen,
    speak,
    playChime,
    send,
    stopAudio,
    prepare,
    phase,
    transcript: (text: string) => recording.resolve(text),
    nextRecording: () => {
      recording = deferred<string>();
    },
    finishPlayback: () => playback.resolve(),
    nextPlayback: () => {
      playback = deferred<void>();
    },
    reply: (value: VoiceReply) => {
      reply = value;
      conversation.refresh();
    },
    block: (reason: string | null) => {
      blocked = reason;
    },
  };
}

describe("phone car mode voice conversation", () => {
  it("streams and reads response blocks with chimes and updates text as blocks arrive", async () => {
    const s = setup();
    const started = s.conversation.start();
    await s.phase("listening");
    s.transcript("Explain what you are doing");
    await started;
    expect(s.conversation.getSnapshot().phase).toBe("waiting");

    // First block arrives while turn is still running (pending)
    s.reply({
      status: "pending",
      text: "Checking files now.",
      blocks: [{ id: "b1", text: "Checking files now." }],
    });

    // Chime is played and text updates immediately to first block
    expect(s.playChime).toHaveBeenCalledTimes(1);
    expect(s.conversation.getSnapshot().agentReply).toBe("Checking files now.");
    expect(s.conversation.getSnapshot().phase).toBe("speaking");
    expect(s.speak).toHaveBeenCalledWith("Checking files now.");

    // Second block arrives while first block is still speaking
    s.reply({
      status: "pending",
      text: "Checking files now.\n\nEverything looks good.",
      blocks: [
        { id: "b1", text: "Checking files now." },
        { id: "b2", text: "Everything looks good." },
      ],
    });
    // First block still in playback; speak is not called for b2 yet
    expect(s.speak).toHaveBeenCalledTimes(1);

    // First block finishes playback
    s.finishPlayback();
    s.nextPlayback();

    // Now second block starts: second chime, text updates to second block
    await Promise.resolve();
    expect(s.playChime).toHaveBeenCalledTimes(2);
    expect(s.conversation.getSnapshot().agentReply).toBe("Everything looks good.");
    expect(s.speak).toHaveBeenCalledTimes(2);
    expect(s.speak).toHaveBeenLastCalledWith("Everything looks good.");

    // Complete the turn and finish playback
    s.reply({
      status: "completed",
      text: "Checking files now.\n\nEverything looks good.",
      blocks: [
        { id: "b1", text: "Checking files now." },
        { id: "b2", text: "Everything looks good." },
      ],
    });
    s.nextRecording();
    s.finishPlayback();

    // Automatically transitions back to listening
    await s.phase("listening");
    expect(s.listen).toHaveBeenCalledTimes(2);
    s.conversation.pause();
  });

  it("automatically sends speech and listens again only after the matching reply has finished playing", async () => {
    const s = setup();
    const started = s.conversation.start();
    await s.phase("listening");
    s.transcript("  Fix the failing build  ");
    await started;
    expect(s.send).toHaveBeenCalledExactlyOnceWith("Fix the failing build", "message-1");
    expect(s.conversation.getSnapshot().phase).toBe("waiting");
    s.nextRecording();
    s.reply({ status: "completed", text: "The build is fixed." });
    expect(s.speak).toHaveBeenCalledExactlyOnceWith("The build is fixed.");
    expect(s.listen).toHaveBeenCalledTimes(1);
    s.conversation.refresh();
    expect(s.speak).toHaveBeenCalledTimes(1);
    s.finishPlayback();
    await s.phase("listening");
    expect(s.listen).toHaveBeenCalledTimes(2);
    s.conversation.pause();
  });

  it("discards a recognition result that finishes after Pause", async () => {
    const s = setup();
    const started = s.conversation.start();
    await s.phase("listening");
    s.conversation.pause();
    s.transcript("Delete the project");
    await started;
    expect(s.send).not.toHaveBeenCalled();
    expect(s.conversation.getSnapshot().phase).toBe("paused");
  });

  it("cancels preparation and does not open the microphone after leaving the screen", async () => {
    const s = setup();
    const permission = deferred<void>();
    s.prepare.mockImplementation(() => permission.promise);
    const started = s.conversation.start();
    s.conversation.pause();
    permission.resolve();
    await started;
    expect(s.listen).not.toHaveBeenCalled();
  });

  it("never starts two microphones when Start is pressed twice", async () => {
    const s = setup();
    const started = s.conversation.start();
    await s.conversation.start();
    await s.phase("listening");
    expect(s.listen).toHaveBeenCalledTimes(1);
    s.transcript("");
    await started;
    expect(s.send).not.toHaveBeenCalled();
    expect(s.conversation.getSnapshot().phase).toBe("paused");
  });

  it("does not send when access or connectivity changes during speech", async () => {
    const s = setup();
    const started = s.conversation.start();
    await s.phase("listening");
    s.block("Connection lost.");
    s.transcript("Commit the fix");
    await started;
    expect(s.send).not.toHaveBeenCalled();
    expect(s.conversation.getSnapshot()).toMatchObject({
      phase: "error",
      error: "Connection lost.",
    });
  });

  it("closes the microphone as soon as permissions are revoked", async () => {
    const s = setup();
    const started = s.conversation.start();
    await s.phase("listening");
    s.block("Permission revoked.");
    s.conversation.refresh();
    expect(s.stopAudio).toHaveBeenCalled();
    s.transcript("Change the code");
    await started;
    expect(s.send).not.toHaveBeenCalled();
  });

  it("does not retry a send after an uncertain acknowledgement", async () => {
    const s = setup();
    s.send.mockRejectedValue(new Error("Delivery could not be confirmed."));
    const started = s.conversation.start();
    await s.phase("listening");
    s.transcript("Fix the bug");
    await started;
    s.conversation.refresh();
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.conversation.getSnapshot().phase).toBe("error");
    expect(s.speak).not.toHaveBeenCalled();
  });

  it("retains the turn through Pause and resumes waiting without resending", async () => {
    const s = setup();
    const delivery = deferred<void>();
    s.send.mockImplementation(() => delivery.promise);
    const started = s.conversation.start();
    await s.phase("listening");
    s.transcript("Implement the change");
    await s.phase("sending");
    s.conversation.pause();
    delivery.resolve();
    await started;
    await s.conversation.start();
    expect(s.conversation.getSnapshot().phase).toBe("waiting");
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.listen).toHaveBeenCalledTimes(1);
    s.reply({ status: "completed", text: "Done" });
    expect(s.speak).toHaveBeenCalledExactlyOnceWith("Done");
    s.conversation.pause();
    s.finishPlayback();
  });

  it.each(["blocked", "failed"] as const)(
    "announces a %s turn and pauses instead of bypassing approvals",
    async (status) => {
      const s = setup();
      const started = s.conversation.start();
      await s.phase("listening");
      s.transcript("Run the tests");
      await started;
      s.reply({ status, text: "" });
      expect(s.speak).toHaveBeenCalledTimes(1);
      s.finishPlayback();
      await s.phase("error");
      expect(s.listen).toHaveBeenCalledTimes(1);
      expect(s.send).toHaveBeenCalledTimes(1);
    },
  );

  it("does not reopen the microphone when Pause interrupts a spoken reply", async () => {
    const s = setup();
    const started = s.conversation.start();
    await s.phase("listening");
    s.transcript("Explain this code");
    await started;
    s.reply({ status: "completed", text: "Here is the explanation." });
    s.conversation.pause();
    s.finishPlayback();
    await Promise.resolve();
    expect(s.listen).toHaveBeenCalledTimes(1);
    expect(s.conversation.getSnapshot().phase).toBe("paused");
  });

  it("reports denied permissions without starting recognition", async () => {
    const s = setup();
    s.prepare.mockRejectedValue(new Error("Microphone permission denied."));
    await s.conversation.start();
    expect(s.conversation.getSnapshot()).toMatchObject({
      phase: "error",
      error: "Microphone permission denied.",
    });
    expect(s.listen).not.toHaveBeenCalled();
  });
});

describe("spoken replies", () => {
  it("reads prose while keeping code blocks, image URLs, and link targets off the audio route", () => {
    expect(
      spokenReply(
        "# Done\n```sh\nrm -rf example\n```\nSee [the change](https://example.test/long). ![image](https://example.test/image.png)",
      ),
    ).toBe("Done Code is available in the conversation. See the change.");
  });

  it("bounds long replies and directs the user to the durable conversation", () => {
    const reply = spokenReply("a".repeat(3000));
    expect(reply.length).toBeLessThan(2500);
    expect(reply).toContain("The rest is available in the conversation.");
  });
});
