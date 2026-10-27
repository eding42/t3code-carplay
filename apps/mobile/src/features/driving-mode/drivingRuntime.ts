import {
  AuthOrchestrationOperateScope,
  CommandId,
  MessageId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AppState } from "react-native";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { environmentPresentations } from "../../state/presentation";
import { environmentSession, readEnvironmentScope } from "../../state/session";
import { uuidv4 } from "../../lib/uuid";
import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";
import { nativeVoice } from "./nativeVoice";
import { VoiceConversation } from "./voiceConversation";
import { voiceReply } from "./voiceProjection";

export function createDrivingConversation(ref: ScopedThreadRef) {
  const registry = appAtomRegistry;
  const threadAtom = environmentThreadDetails.threadAtom(ref);
  const presentationAtom = environmentPresentations.presentationAtom(ref.environmentId);
  const readProjection = () => registry.get(threadAtom)?.projection ?? null;
  let audioToken: ReturnType<typeof acquireAudioSession> | null = null;
  const stopAudio = () => {
    void nativeVoice?.stop().catch(() => {});
    const previous = audioToken;
    audioToken = null;
    if (previous) void releaseAudioSession(previous).catch(() => {});
  };
  const withAudio = async <A>(operation: () => Promise<A>) => {
    const token = acquireAudioSession("recording", () => conversation.pause());
    audioToken = token;
    try {
      if (!(await activateAudioSession(token, true)))
        throw new Error("Another audio feature is using the microphone.");
      return await operation();
    } finally {
      if (audioToken === token) audioToken = null;
      await releaseAudioSession(token);
    }
  };
  const validate = () => {
    if (AppState.currentState !== "active") return "Keep car mode open to use voice chat.";
    if (registry.get(presentationAtom)?.connection.phase !== "connected")
      return "Connect to your T3 server before starting voice chat.";
    if (!readEnvironmentScope(ref.environmentId, AuthOrchestrationOperateScope))
      return "This connection does not have permission to send messages.";
    const state = registry.get(environmentThreadDetails.stateAtom(ref));
    const projection = readProjection();
    if (state.status !== "live" || !projection)
      return "Wait for this conversation to finish synchronizing.";
    if (projection.thread.archivedAt || projection.thread.deletedAt)
      return "Reopen this conversation before starting voice chat.";
    if (projection.runtimeRequests.some((request) => request.status === "pending"))
      return "The agent needs your approval or an answer. Review the conversation when parked.";
    if (
      projection.runs.some((run) =>
        ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
      )
    )
      return "Wait for the current agent turn to finish before resuming voice chat.";
    return null;
  };
  const conversation = new VoiceConversation({
    prepare: async () => {
      if (!nativeVoice)
        throw new Error("Install this checkout’s iOS app to enable car mode voice chat.");
      await nativeVoice.prepare();
    },
    listen: () => withAudio(() => nativeVoice!.listen()),
    speak: (text) => withAudio(() => nativeVoice!.speak(text)),
    stopAudio,
    validate,
    messageId: uuidv4,
    send: async (text, messageId) => {
      const reason = validate();
      if (reason) throw new Error(reason);
      const thread = readProjection()!.thread;
      const result = await runAtomCommand(
        registry,
        threadEnvironment.startTurn,
        {
          environmentId: ref.environmentId,
          input: {
            commandId: CommandId.make(uuidv4()),
            threadId: ref.threadId,
            creationSource: "mobile",
            message: { messageId: MessageId.make(messageId), role: "user", text, attachments: [] },
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            dispatchMode: "start",
          },
        },
        { reportFailure: false },
      );
      if (result._tag !== "Success")
        throw new Error(
          "Could not confirm delivery. Check the conversation before sending again; your message may have arrived.",
        );
    },
    reply: (messageId) => {
      if (!readEnvironmentScope(ref.environmentId, AuthOrchestrationOperateScope)) {
        return { status: "blocked", text: "" };
      }
      return voiceReply(readProjection(), messageId);
    },
  });

  return {
    conversation,
    mount: () => {
      const releases = [
        registry.subscribe(threadAtom, () => conversation.refresh()),
        registry.subscribe(presentationAtom, () => conversation.refresh()),
        registry.subscribe(environmentSession.sessionStateAtom(ref.environmentId), () =>
          conversation.refresh(),
        ),
      ];
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "background") conversation.pause();
      });
      return () => {
        conversation.pause();
        subscription.remove();
        for (const release of releases) release();
      };
    },
    interrupt: async () => {
      conversation.pause();
      if (!readEnvironmentScope(ref.environmentId, AuthOrchestrationOperateScope)) return;
      const result = await runAtomCommand(
        registry,
        threadEnvironment.interruptTurn,
        {
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId },
        },
        { reportFailure: false },
      );
      if (result._tag !== "Success")
        throw new Error("Could not stop the agent. Check the conversation.");
    },
  };
}
