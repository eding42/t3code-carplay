import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type { VoiceReply } from "./voiceConversation";

type Projection = {
  readonly runs: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["runs"][number], "id" | "userMessageId" | "status">
  >;
  readonly runtimeRequests: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["runtimeRequests"][number], "status">
  >;
  readonly turnItems: ReadonlyArray<{
    readonly runId: string | null;
    readonly type: string;
    readonly text?: string;
    readonly streaming?: boolean;
  }>;
};

export function voiceReply(projection: Projection | null, messageId: string): VoiceReply {
  if (!projection) return { status: "pending", text: "" };
  const run = projection.runs.find((candidate) => candidate.userMessageId === messageId);
  if (!run) return { status: "pending", text: "" };
  if (projection.runtimeRequests.some((request) => request.status === "pending")) {
    return { status: "blocked", text: "" };
  }
  switch (run.status) {
    case "completed": {
      const items = projection.turnItems.filter(
        (item) => item.runId === run.id && item.type === "assistant_message",
      );
      if (items.some((item) => item.streaming)) return { status: "pending", text: "" };
      return { status: "completed", text: items.map((item) => item.text ?? "").join("\n\n") };
    }
    case "failed":
    case "cancelled":
    case "interrupted":
    case "rolled_back":
      return { status: "failed", text: "" };
    default:
      return { status: "pending", text: "" };
  }
}
