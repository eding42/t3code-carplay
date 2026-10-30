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

export interface ActiveAgentActivity {
  readonly label: string;
  readonly icon:
    | "doc.text"
    | "pencil"
    | "terminal"
    | "globe"
    | "magnifyingglass"
    | "hammer"
    | "person.2"
    | "brain";
  readonly isReasoning: boolean;
}

export function resolveActiveAgentActivity(
  turnItems?: ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
    readonly toolName?: string | null;
    readonly input?: unknown;
    readonly fileName?: string;
    readonly pattern?: string;
    readonly prompt?: string;
    readonly progress?: string;
    readonly message?: string;
  }>,
): ActiveAgentActivity | null {
  if (!turnItems || turnItems.length === 0) return null;

  for (let i = turnItems.length - 1; i >= 0; i--) {
    const item = turnItems[i];
    if (!item) continue;

    if (item.type === "dynamic_tool") {
      const tool = (item.toolName ?? "").toLowerCase();
      const input = (item.input ?? {}) as Record<string, unknown>;

      if (tool.includes("view_file") || tool.includes("read") || tool.includes("client_view_file")) {
        const rawPath = String(input.absolute_path ?? input.AbsolutePath ?? input.path ?? "");
        const fileName = rawPath.split("/").filter(Boolean).pop() || "file";
        return {
          label: `Reading ${fileName}`,
          icon: "doc.text",
          isReasoning: false,
        };
      }

      if (tool.includes("replace_file") || tool.includes("write_to_file") || tool.includes("edit")) {
        const rawPath = String(input.TargetFile ?? input.target_file ?? input.path ?? "");
        const fileName = rawPath.split("/").filter(Boolean).pop() || "file";
        return {
          label: `Editing ${fileName}`,
          icon: "pencil",
          isReasoning: false,
        };
      }

      if (
        tool.includes("run_command") ||
        tool.includes("bash") ||
        tool.includes("shell") ||
        tool.includes("terminal")
      ) {
        const cmd = String(input.CommandLine ?? input.command ?? "").trim();
        const shortCmd = cmd.length > 34 ? `${cmd.slice(0, 34)}…` : cmd;
        return {
          label: shortCmd ? `Running: ${shortCmd}` : "Running command",
          icon: "terminal",
          isReasoning: false,
        };
      }

      if (tool.includes("search_web") || tool.includes("web_search")) {
        const query = String(input.query ?? "").trim();
        const shortQuery = query.length > 28 ? `"${query.slice(0, 28)}…"` : query ? `"${query}"` : "";
        return {
          label: shortQuery ? `Searching web for ${shortQuery}` : "Searching the web",
          icon: "globe",
          isReasoning: false,
        };
      }

      const cleanTool = tool ? tool.replace(/_/g, " ") : "tool";
      return {
        label: `Running ${cleanTool}`,
        icon: "hammer",
        isReasoning: false,
      };
    }

    if (item.type === "command_execution") {
      const input = String((item as any).input ?? "").trim();
      const shortCmd = input.length > 34 ? `${input.slice(0, 34)}…` : input;
      return {
        label: shortCmd ? `Running: ${shortCmd}` : "Running command",
        icon: "terminal",
        isReasoning: false,
      };
    }

    if (item.type === "file_change") {
      const fileName = String(item.fileName ?? "").split("/").filter(Boolean).pop() || "file";
      return {
        label: `Editing ${fileName}`,
        icon: "pencil",
        isReasoning: false,
      };
    }

    if (item.type === "file_search") {
      const pattern = item.pattern?.trim();
      return {
        label: pattern ? `Searching for "${pattern}"` : "Searching files",
        icon: "magnifyingglass",
        isReasoning: false,
      };
    }

    if (item.type === "web_search") {
      return {
        label: "Searching the web",
        icon: "globe",
        isReasoning: false,
      };
    }

    if (item.type === "subagent") {
      const prompt = item.progress?.trim() || item.prompt?.trim() || "";
      const shortPrompt = prompt.length > 34 ? `${prompt.slice(0, 34)}…` : prompt;
      return {
        label: shortPrompt ? `Subagent: ${shortPrompt}` : "Running subagent",
        icon: "person.2",
        isReasoning: false,
      };
    }

    if (item.type === "reasoning" && item.text) {
      const clean = item.text.replace(/[\n\r]+/g, " ").trim();
      if (clean) {
        const thought = clean.length > 68 ? `…${clean.slice(-68)}` : clean;
        return {
          label: thought,
          icon: "brain",
          isReasoning: true,
        };
      }
    }
  }

  return null;
}
