import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type { VoiceBlock, VoiceReply } from "./voiceConversation";
import { spokenReply } from "./voiceConversation";

type Projection = {
  readonly runs: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["runs"][number], "id" | "userMessageId" | "status">
  >;
  readonly runtimeRequests: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["runtimeRequests"][number], "status">
  >;
  readonly turnItems: ReadonlyArray<{
    readonly id?: string;
    readonly runId: string | null;
    readonly type: string;
    readonly text?: string;
    readonly streaming?: boolean;
  }>;
};

export function splitIntoBlocks(text: string, streaming: boolean): ReadonlyArray<string> {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const rawParts = text.split(/\n\s*\n/);
  // While streaming, the trailing fragment may still be receiving tokens.
  const completedParts =
    streaming && rawParts.length > 1 ? rawParts.slice(0, -1) : streaming ? [] : rawParts;
  return completedParts
    .map((part) => part.trim())
    .filter((part) => spokenReply(part).trim().length > 0);
}

export function voiceReply(projection: Projection | null, messageId: string): VoiceReply {
  if (!projection) return { status: "pending", text: "", blocks: [] };
  const run = projection.runs.find((candidate) => candidate.userMessageId === messageId);
  if (!run) return { status: "pending", text: "", blocks: [] };
  if (projection.runtimeRequests.some((request) => request.status === "pending")) {
    return { status: "blocked", text: "", blocks: [] };
  }
  switch (run.status) {
    case "failed":
    case "cancelled":
    case "interrupted":
    case "rolled_back":
      return { status: "failed", text: "", blocks: [] };
    default: {
      const items = projection.turnItems.filter(
        (item) => item.runId === run.id && item.type === "assistant_message",
      );
      const blocks: VoiceBlock[] = [];
      items.forEach((item, itemIdx) => {
        if (!item.text) return;
        const itemId = item.id ?? `item-${itemIdx}`;
        const parts = splitIntoBlocks(item.text, item.streaming === true);
        parts.forEach((part, partIdx) => {
          blocks.push({
            id: `${itemId}-${partIdx}`,
            text: part,
          });
        });
      });

      const isCompleted =
        run.status === "completed" && !items.some((item) => item.streaming);

      return {
        status: isCompleted ? "completed" : "pending",
        text: blocks.map((b) => b.text).join("\n\n"),
        blocks,
      };
    }
  }
}
