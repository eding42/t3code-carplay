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
    expect(reply).toEqual({
      status: "completed",
      text: "Fixed the bug.\n\nTests pass.",
      blocks: [
        { id: "item-0-0", text: "Fixed the bug." },
        { id: "item-1-0", text: "Tests pass." },
      ],
    });
  });

  it("extracts completed paragraph blocks even while subsequent blocks are streaming", () => {
    const reply = voiceReply(
      {
        runs: [run("running")],
        runtimeRequests: [],
        turnItems: [
          {
            type: "assistant_message",
            runId: "run-voice",
            text: "First block finished.\n\nSecond block is still being typ",
            streaming: true,
          },
        ],
      },
      "message-voice",
    );
    expect(reply.status).toBe("pending");
    expect(reply.blocks).toEqual([
      { id: "item-0-0", text: "First block finished." },
    ]);
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

describe("resolveActiveAgentActivity", () => {
  it("resolves dynamic tool reading file", async () => {
    const { resolveActiveAgentActivity } = await import("./voiceProjection");
    const activity = resolveActiveAgentActivity([
      {
        type: "dynamic_tool",
        toolName: "view_file",
        input: { absolute_path: "/path/to/voiceProjection.ts" },
      },
    ]);
    expect(activity).toEqual({
      label: "Reading voiceProjection.ts",
      icon: "doc.text",
      isReasoning: false,
    });
  });

  it("resolves dynamic tool editing file", async () => {
    const { resolveActiveAgentActivity } = await import("./voiceProjection");
    const activity = resolveActiveAgentActivity([
      {
        type: "dynamic_tool",
        toolName: "replace_file_content",
        input: { TargetFile: "/path/to/DrivingModeScreen.tsx" },
      },
    ]);
    expect(activity).toEqual({
      label: "Editing DrivingModeScreen.tsx",
      icon: "pencil",
      isReasoning: false,
    });
  });

  it("resolves command execution", async () => {
    const { resolveActiveAgentActivity } = await import("./voiceProjection");
    const activity = resolveActiveAgentActivity([
      {
        type: "command_execution",
        input: "git status",
      },
    ]);
    expect(activity).toEqual({
      label: "Running: git status",
      icon: "terminal",
      isReasoning: false,
    });
  });

  it("resolves reasoning / chain of thought", async () => {
    const { resolveActiveAgentActivity } = await import("./voiceProjection");
    const activity = resolveActiveAgentActivity([
      {
        type: "reasoning",
        text: "Analyzing recent changes in the Car Mode implementation...",
      },
    ]);
    expect(activity).toEqual({
      label: "Analyzing recent changes in the Car Mode implementation...",
      icon: "brain",
      isReasoning: true,
    });
  });
});
