import { describe, expect, it } from "vite-plus/test";
import { MessageId, RunId } from "@t3tools/contracts";
import { voiceReply } from "./voiceProjection";

const run = (status: "running" | "completed" | "failed" = "completed") => ({
  id: RunId.make("run-voice"),
  userMessageId: MessageId.make("message-voice"),
  status,
});

describe("voice turn projection", () => {
  it("reads only assistant messages belonging to the submitted voice message", () => {
    const reply = voiceReply(
      {
        runs: [run()],
        runtimeRequests: [],
        turnItems: [
          { type: "assistant_message", runId: "old-run", text: "Unrelated private reply" },
          { type: "reasoning", runId: "run-voice", text: "Internal reasoning" },
          {
            type: "assistant_message",
            runId: "run-voice",
            text: "Fixed the bug.",
            streaming: false,
          },
          { type: "assistant_message", runId: "run-voice", text: "Tests pass.", streaming: false },
        ],
      },
      "message-voice",
    );
    expect(reply).toEqual({ status: "completed", text: "Fixed the bug.\n\nTests pass." });
  });

  it("does not read streamed partial replies or commentary while code is still running", () => {
    expect(
      voiceReply(
        {
          runs: [run("running")],
          runtimeRequests: [],
          turnItems: [
            { type: "assistant_message", runId: "run-voice", text: "Working", streaming: false },
          ],
        },
        "message-voice",
      ).status,
    ).toBe("pending");
    expect(
      voiceReply(
        {
          runs: [run()],
          runtimeRequests: [],
          turnItems: [
            { type: "assistant_message", runId: "run-voice", text: "Partial", streaming: true },
          ],
        },
        "message-voice",
      ).status,
    ).toBe("pending");
  });

  it("waits for a matching run even when another device completes a different turn", () => {
    expect(
      voiceReply({ runs: [run()], runtimeRequests: [], turnItems: [] }, "other-message").status,
    ).toBe("pending");
    expect(voiceReply(null, "message-voice").status).toBe("pending");
  });

  it("stops for approval or user input instead of treating a waiting turn as a reply", () => {
    expect(
      voiceReply(
        { runs: [run("running")], runtimeRequests: [{ status: "pending" }], turnItems: [] },
        "message-voice",
      ).status,
    ).toBe("blocked");
  });

  it("does not speak a failed turn as though it succeeded", () => {
    expect(
      voiceReply({ runs: [run("failed")], runtimeRequests: [], turnItems: [] }, "message-voice")
        .status,
    ).toBe("failed");
  });
});
