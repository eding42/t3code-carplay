import { useAtomValue } from "@effect/atom-react";
import {
  CommonActions,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Haptics from "expo-haptics";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { memo, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  type DerivedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { environmentThreadDetails, environmentThreadShells } from "../../state/threads";
import { createDrivingConversation } from "./drivingRuntime";
import { nativeVoice } from "./nativeVoice";
import { spokenReply, type VoicePhase } from "./voiceConversation";
import { resolveActiveAgentActivity } from "./voiceProjection";

const THEME_BY_PHASE: Record<
  VoicePhase,
  {
    badge: string;
    title: string;
    subtitle: string;
    glowStart: string;
    glowMid: string;
    accent: string;
    border: string;
    icon: AppSymbolName;
  }
> = {
  paused: {
    badge: "READY",
    title: "Tap to Speak",
    subtitle: "Hands-free voice assistant on standby",
    glowStart: "rgba(212, 163, 115, 0.12)",
    glowMid: "rgba(212, 163, 115, 0.03)",
    accent: "#D4A373",
    border: "rgba(212, 163, 115, 0.25)",
    icon: "mic",
  },
  preparing: {
    badge: "INITIALIZING",
    title: "Starting Up…",
    subtitle: "Configuring on-device audio engine",
    glowStart: "rgba(229, 169, 103, 0.16)",
    glowMid: "rgba(229, 169, 103, 0.04)",
    accent: "#E5A967",
    border: "rgba(229, 169, 103, 0.3)",
    icon: "headphones",
  },
  listening: {
    badge: "LISTENING",
    title: "Listening…",
    subtitle: "Speak naturally · 2s pause auto-sends",
    glowStart: "rgba(229, 169, 103, 0.22)",
    glowMid: "rgba(229, 169, 103, 0.05)",
    accent: "#E5A967",
    border: "rgba(229, 169, 103, 0.4)",
    icon: "mic",
  },
  sending: {
    badge: "DELIVERING",
    title: "Delivering…",
    subtitle: "Transmitting prompt to agent",
    glowStart: "rgba(203, 187, 173, 0.18)",
    glowMid: "rgba(203, 187, 173, 0.04)",
    accent: "#CBBBAD",
    border: "rgba(203, 187, 173, 0.3)",
    icon: "arrow.up",
  },
  waiting: {
    badge: "THINKING",
    title: "Thinking…",
    subtitle: "Reviewing workspace & running tools",
    glowStart: "rgba(212, 163, 115, 0.20)",
    glowMid: "rgba(212, 163, 115, 0.04)",
    accent: "#D4A373",
    border: "rgba(212, 163, 115, 0.35)",
    icon: "brain",
  },
  speaking: {
    badge: "SPEAKING",
    title: "Speaking…",
    subtitle: "Streaming response through car audio",
    glowStart: "rgba(168, 197, 168, 0.20)",
    glowMid: "rgba(168, 197, 168, 0.04)",
    accent: "#A8C5A8",
    border: "rgba(168, 197, 168, 0.35)",
    icon: "headphones",
  },
  error: {
    badge: "PAUSED",
    title: "Attention Needed",
    subtitle: "Review details safely when parked",
    glowStart: "rgba(244, 114, 114, 0.16)",
    glowMid: "rgba(244, 114, 114, 0.03)",
    accent: "#F87171",
    border: "rgba(244, 114, 114, 0.3)",
    icon: "exclamationmark.triangle",
  },
};

const WAVE_BARS = [
  { id: "bar-0", envelope: 0.32, phaseOffset: 0 },
  { id: "bar-1", envelope: 0.52, phaseOffset: 0.57 },
  { id: "bar-2", envelope: 0.78, phaseOffset: 1.14 },
  { id: "bar-3", envelope: 1.12, phaseOffset: 1.71 },
  { id: "bar-4", envelope: 1.5, phaseOffset: 2.28 },
  { id: "bar-5", envelope: 1.85, phaseOffset: 2.85 },
  { id: "bar-6", envelope: 1.5, phaseOffset: 3.42 },
  { id: "bar-7", envelope: 1.12, phaseOffset: 3.99 },
  { id: "bar-8", envelope: 0.78, phaseOffset: 4.56 },
  { id: "bar-9", envelope: 0.52, phaseOffset: 5.13 },
  { id: "bar-10", envelope: 0.32, phaseOffset: 5.7 },
] as const;

export function DrivingModeScreen({
  route,
}: StaticScreenProps<
  | {
      readonly environmentId?: string;
      readonly threadId?: string;
    }
  | undefined
>) {
  const environmentId = route.params?.environmentId;
  const threadId = route.params?.threadId;
  const threadRef = useMemo<ScopedThreadRef | null>(
    () =>
      environmentId && threadId
        ? {
            environmentId: EnvironmentId.make(environmentId),
            threadId: ThreadId.make(threadId),
          }
        : null,
    [environmentId, threadId],
  );

  if (Platform.OS !== "ios") {
    return (
      <View
        className="flex-1 items-center justify-center p-8"
        style={{ backgroundColor: "#0A0A0C" }}
      >
        <SymbolView name="iphone" size={48} tintColor="#71717A" />
        <Text className="mt-4 text-center text-lg font-t3-bold text-[#F4F4F6]">iPhone Only</Text>
        <Text className="mt-2 text-center text-zinc-400">
          Car mode hands-free voice chat is available on iPhone.
        </Text>
      </View>
    );
  }

  if (!threadRef) {
    return <ConversationPicker />;
  }

  return (
    <VoiceControls
      key={JSON.stringify([threadRef.environmentId, threadRef.threadId])}
      threadRef={threadRef}
    />
  );
}

function ConversationPicker() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const threads = useAtomValue(environmentThreadShells.threadShellsAtom);
  const conversations = threads
    .filter(
      (thread) => thread.archivedAt === null && thread.lineage.relationshipToParent !== "subagent",
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <View className="flex-1" style={{ backgroundColor: "#000000" }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="px-5 py-5 gap-6"
        style={{
          paddingTop: Math.max(insets.top, 16),
          paddingBottom: Math.max(insets.bottom, 24),
        }}
      >
        {/* Top Back Navigation Button */}
        <View className="flex-row items-center justify-between">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              navigation.goBack();
            }}
            className="h-10 w-10 items-center justify-center rounded-full active:opacity-75"
            style={{
              backgroundColor: "rgba(255, 255, 255, 0.04)",
              borderWidth: 1,
              borderColor: "rgba(255, 255, 255, 0.08)",
            }}
          >
            <SymbolView name="chevron.left" size={15} tintColor="#D4D4D8" />
          </Pressable>
        </View>

        {/* Clean Editorial Hero */}
        <View className="items-center pt-2 pb-2">
          <View
            className="h-16 w-16 items-center justify-center rounded-2xl mb-4"
            style={{
              backgroundColor: "rgba(212, 163, 115, 0.08)",
              borderWidth: 1,
              borderColor: "rgba(212, 163, 115, 0.2)",
            }}
          >
            <SymbolView name="car" size={32} tintColor="#D4A373" />
          </View>
          <Text className="text-2xl font-t3-bold tracking-tight text-[#F4F4F6]">Car Mode</Text>
          <Text className="mt-2 text-center text-sm font-t3-normal text-zinc-400 max-w-xs leading-6">
            Hands-free voice assistant built for driving. Continuous conversational coding with
            automatic pause detection.
          </Text>

          {/* Version / Release Pill */}
          <View
            className="mt-3 flex-row items-center gap-1.5 rounded-full px-3 py-1"
            style={{
              backgroundColor: "rgba(255, 255, 255, 0.05)",
              borderWidth: 1,
              borderColor: "rgba(255, 255, 255, 0.1)",
            }}
          >
            <SymbolView name="checkmark.circle.fill" size={11} tintColor="#A8C5A8" />
            <Text className="text-[11px] font-t3-medium text-zinc-300">
              v{Constants.expoConfig?.version ?? "2.1.0"} ({Application.nativeBuildVersion ?? "dev"}) · Glance HUD
            </Text>
          </View>

          {/* Feature Badges */}
          <View className="mt-5 flex-row items-center gap-2">
            <View
              className="flex-row items-center gap-1.5 rounded-full px-3 py-1"
              style={{
                backgroundColor: "rgba(255, 255, 255, 0.04)",
                borderWidth: 1,
                borderColor: "rgba(255, 255, 255, 0.08)",
              }}
            >
              <SymbolView name="sparkles" size={11} tintColor="#D4A373" />
              <Text className="text-[11px] font-t3-medium text-zinc-300">Zero Touch</Text>
            </View>
            <View
              className="flex-row items-center gap-1.5 rounded-full px-3 py-1"
              style={{
                backgroundColor: "rgba(255, 255, 255, 0.04)",
                borderWidth: 1,
                borderColor: "rgba(255, 255, 255, 0.08)",
              }}
            >
              <SymbolView name="headphones" size={11} tintColor="#A8C5A8" />
              <Text className="text-[11px] font-t3-medium text-zinc-300">Car Audio</Text>
            </View>
            <View
              className="flex-row items-center gap-1.5 rounded-full px-3 py-1"
              style={{
                backgroundColor: "rgba(255, 255, 255, 0.04)",
                borderWidth: 1,
                borderColor: "rgba(255, 255, 255, 0.08)",
              }}
            >
              <SymbolView name="info.circle" size={11} tintColor="#A1A1AA" />
              <Text className="text-[11px] font-t3-medium text-zinc-400">On-Device</Text>
            </View>
          </View>
        </View>

        {/* Threads List */}
        <View className="gap-2.5">
          <View className="flex-row items-center justify-between px-1">
            <Text className="text-xs font-t3-bold uppercase tracking-widest text-zinc-500">
              Select Conversation
            </Text>
            <Text className="text-xs font-t3-normal text-zinc-500">
              {conversations.length} {conversations.length === 1 ? "thread" : "threads"}
            </Text>
          </View>

          {conversations.length === 0 ? (
            <View
              className="items-center justify-center rounded-2xl py-14 px-6"
              style={{
                borderWidth: 1,
                borderStyle: "dashed",
                borderColor: "rgba(255, 255, 255, 0.08)",
              }}
            >
              <SymbolView name="bubble.left.and.bubble.right" size={32} tintColor="#52525B" />
              <Text className="mt-3 text-center text-sm font-t3-medium text-zinc-300">
                No active conversations
              </Text>
              <Text className="mt-1 text-center text-xs text-zinc-500">
                Start a thread with your T3 server to begin voice mode.
              </Text>
            </View>
          ) : null}

          {conversations.map((thread) => (
            <Pressable
              key={JSON.stringify([thread.environmentId, thread.id])}
              accessibilityRole="button"
              accessibilityLabel={`Open car mode for ${thread.title}`}
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                navigation.dispatch(
                  CommonActions.navigate("SettingsDrivingMode", {
                    environmentId: thread.environmentId,
                    threadId: thread.id,
                  }),
                );
              }}
              className="flex-row items-center justify-between rounded-2xl p-4 active:bg-[#181922] active:scale-[0.99]"
              style={{
                backgroundColor: "#121318",
                borderWidth: 1,
                borderColor: "rgba(255, 255, 255, 0.08)",
              }}
            >
              <View className="flex-1 pr-3">
                <Text
                  className="text-[15px] font-t3-medium tracking-tight text-[#F4F4F6]"
                  numberOfLines={1}
                >
                  {thread.title}
                </Text>
                <View className="mt-2 flex-row items-center gap-2">
                  <View
                    className="flex-row items-center gap-1 rounded-full px-2 py-0.5"
                    style={{
                      backgroundColor: "rgba(212, 163, 115, 0.1)",
                      borderWidth: 1,
                      borderColor: "rgba(212, 163, 115, 0.2)",
                    }}
                  >
                    <SymbolView name="sparkles" size={9} tintColor="#D4A373" />
                    <Text className="text-[10px] font-t3-medium text-[#D4A373]" numberOfLines={1}>
                      {thread.modelSelection.model}
                    </Text>
                  </View>
                  <Text className="text-xs text-zinc-500" numberOfLines={1}>
                    {thread.environmentId}
                  </Text>
                </View>
              </View>
              <View
                className="h-8 w-8 items-center justify-center rounded-full"
                style={{
                  backgroundColor: "rgba(255, 255, 255, 0.04)",
                  borderWidth: 1,
                  borderColor: "rgba(255, 255, 255, 0.08)",
                }}
              >
                <SymbolView name="chevron.right" size={13} tintColor="#A1A1AA" />
              </View>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function InteractiveHeroOrb({
  phase,
  active,
  onPress,
  disabled,
}: {
  readonly phase: VoicePhase;
  readonly active: boolean;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  const theme = THEME_BY_PHASE[phase];
  const flashAnim = useSharedValue(0);

  useEffect(() => {
    flashAnim.value = withSequence(
      withTiming(1, { duration: 150, easing: Easing.out(Easing.ease) }),
      withTiming(0, { duration: 600, easing: Easing.out(Easing.quad) }),
    );
  }, [phase, flashAnim]);

  const flashStyle = useAnimatedStyle(() => ({
    opacity: flashAnim.value * 0.45,
    transform: [{ scale: 1 + flashAnim.value * 0.2 }],
  }));

  const wavePhase = useDerivedValue(() =>
    active
      ? withRepeat(
          withTiming(Math.PI * 2, {
            duration: 1400,
            easing: Easing.linear,
          }),
          -1,
          false,
        )
      : withTiming(0, { duration: 350 }),
  );

  const haloAnim = useDerivedValue(() =>
    active
      ? withRepeat(
          withSequence(
            withTiming(1, { duration: 1600, easing: Easing.inOut(Easing.quad) }),
            withTiming(0, { duration: 1600, easing: Easing.inOut(Easing.quad) }),
          ),
          -1,
          true,
        )
      : withRepeat(
          withSequence(
            withTiming(1, { duration: 2400, easing: Easing.inOut(Easing.quad) }),
            withTiming(0, { duration: 2400, easing: Easing.inOut(Easing.quad) }),
          ),
          -1,
          true,
        ),
  );

  const haloAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + haloAnim.value * (active ? 0.16 : 0.08) }],
    opacity: active ? 0.35 + haloAnim.value * 0.35 : 0.12 + haloAnim.value * 0.12,
  }));

  const rippleAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + haloAnim.value * (active ? 0.08 : 0.04) }],
    opacity: active ? 0.4 + haloAnim.value * 0.3 : 0.2,
  }));

  const coreAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: active ? 1 + haloAnim.value * 0.03 : 1 }],
  }));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={active ? "Pause voice chat" : "Tap to speak"}
      disabled={disabled}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        onPress();
      }}
      className="my-3 items-center justify-center active:scale-95"
      style={{ height: 210, width: 210 }}
    >
      {/* Phase Transition Radiant Flash */}
      <Animated.View
        style={[
          flashStyle,
          {
            width: 210,
            height: 210,
            borderRadius: 105,
            backgroundColor: theme.accent,
            position: "absolute",
          },
        ]}
      />

      {/* Outer Subtle Bloom Halo */}
      <Animated.View
        style={[
          haloAnimatedStyle,
          {
            width: 190,
            height: 190,
            borderRadius: 95,
            backgroundColor: theme.accent,
            opacity: 0.15,
            position: "absolute",
          },
        ]}
      />

      {/* Secondary Acoustic Ripple Ring */}
      <Animated.View
        style={[
          rippleAnimatedStyle,
          {
            width: 156,
            height: 156,
            borderRadius: 78,
            borderWidth: 1.5,
            borderColor: active ? theme.accent : "rgba(212, 163, 115, 0.4)",
            backgroundColor: active ? "rgba(255, 255, 255, 0.03)" : "rgba(212, 163, 115, 0.04)",
            position: "absolute",
          },
        ]}
      />

      {/* Centerpiece Acoustic Disc */}
      <Animated.View
        style={[
          coreAnimatedStyle,
          {
            width: 136,
            height: 136,
            borderRadius: 68,
            backgroundColor: active ? "#111218" : "#161720",
            borderWidth: 2,
            borderColor: active ? theme.accent : "#D4A373",
            shadowColor: theme.accent,
            shadowOffset: { width: 0, height: 0 },
            shadowOpacity: active ? 0.7 : 0.45,
            shadowRadius: active ? 32 : 22,
          },
        ]}
        className="items-center justify-center"
      >
        {active ? (
          /* Dynamic 11-Bar Fluid Equalizer Waveform */
          <View className="flex-row items-center justify-center" style={{ height: 50 }}>
            {WAVE_BARS.map((bar) => (
              <AnimatedHarmonicBar
                key={bar.id}
                bar={bar}
                wavePhase={wavePhase}
                accent={theme.accent}
                active={active}
              />
            ))}
          </View>
        ) : (
          /* Standby Warm Illuminated Microphone Emblem */
          <View className="items-center justify-center">
            <SymbolView name="mic" size={42} tintColor="#D4A373" />
          </View>
        )}
      </Animated.View>
    </Pressable>
  );
}

const AnimatedHarmonicBar = memo(function AnimatedHarmonicBar({
  bar,
  wavePhase,
  accent,
  active,
}: {
  readonly bar: (typeof WAVE_BARS)[number];
  readonly wavePhase: DerivedValue<number>;
  readonly accent: string;
  readonly active: boolean;
}) {
  const barStyle = useAnimatedStyle(() => {
    if (!active) {
      return {
        height: 4,
        opacity: 0.35,
      };
    }
    const oscillation = Math.sin(wavePhase.value + bar.phaseOffset);
    const normalized = 0.25 + 0.75 * Math.abs(oscillation);
    const height = 6 + normalized * bar.envelope * 18;
    return {
      height,
      opacity: 0.45 + normalized * 0.55,
    };
  });

  return (
    <Animated.View
      style={[
        barStyle,
        {
          width: 3.2,
          borderRadius: 2,
          backgroundColor: accent,
          marginHorizontal: 2,
        },
      ]}
    />
  );
});

function resolveLatestPrompt(
  transcript: string,
  turnItems?: ReadonlyArray<{ readonly type: string; readonly text?: string }>,
): string {
  if (transcript) return transcript;
  if (!turnItems) return "";
  for (let i = turnItems.length - 1; i >= 0; i--) {
    const item = turnItems[i];
    if (item && item.type === "user_message" && item.text) {
      return item.text.trim();
    }
  }
  return "";
}

function resolveLatestReply(
  agentReply: string,
  turnItems?: ReadonlyArray<{ readonly type: string; readonly text?: string }>,
): string {
  if (agentReply) return agentReply;
  if (!turnItems) return "";
  for (let i = turnItems.length - 1; i >= 0; i--) {
    const item = turnItems[i];
    if (item && item.type === "assistant_message" && item.text) {
      return spokenReply(item.text);
    }
  }
  return "";
}

function VoiceControls({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const runtime = useMemo(() => createDrivingConversation(threadRef), [threadRef]);
  const { conversation } = runtime;
  const state = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot);
  const thread = useAtomValue(environmentThreadDetails.quietThreadAtom(threadRef));
  const [actionError, setActionError] = useState<string | null>(null);
  const active = state.phase !== "paused" && state.phase !== "error";
  const theme = THEME_BY_PHASE[state.phase];

  useEffect(() => runtime.mount(), [runtime]);

  // oxlint-disable-next-line t3code/react-effect-budget -- Keep the mounted phone awake only during an explicitly started voice session.
  useEffect(() => {
    if (!active) return;
    const activation = activateKeepAwakeAsync("driving-mode");
    void activation.catch(() => conversation.pause());
    return () => {
      void activation.then(() => deactivateKeepAwake("driving-mode")).catch(() => {});
    };
  }, [active, conversation]);

  const latestUserPrompt = resolveLatestPrompt(state.transcript, thread?.projection?.turnItems);
  const latestAgentReply = resolveLatestReply(state.agentReply, thread?.projection?.turnItems);
  const activeActivity = resolveActiveAgentActivity(thread?.projection?.turnItems);
  const isTurnActive = state.phase === "waiting" || state.phase === "speaking";

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(theme.title);
  }, [theme.title]);

  const openConversation = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    navigation.dispatch(
      CommonActions.navigate("Thread", {
        environmentId: threadRef.environmentId,
        threadId: threadRef.threadId,
      }),
    );
  };

  const handleToggle = () => {
    setActionError(null);
    if (active) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      conversation.pause();
    } else {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void conversation.start();
    }
  };

  const handleInterrupt = () => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    void runtime
      .interrupt()
      .catch((error: unknown) =>
        setActionError(error instanceof Error ? error.message : "Could not stop the agent."),
      );
  };

  return (
    <View
      className="flex-1 justify-between"
      style={{
        backgroundColor: "#000000",
        paddingTop: Math.max(insets.top, 16),
        paddingBottom: Math.max(insets.bottom, 24),
      }}
    >
      {/* Top Floating Navigation Capsule */}
      <View className="px-5 pt-1 flex-row items-center justify-between">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            conversation.pause();
            navigation.goBack();
          }}
          className="h-11 w-11 items-center justify-center rounded-full active:opacity-75"
          style={{
            backgroundColor: "rgba(255, 255, 255, 0.06)",
            borderWidth: 1,
            borderColor: "rgba(255, 255, 255, 0.12)",
          }}
        >
          <SymbolView name="chevron.left" size={17} tintColor="#E4E4E7" />
        </Pressable>

        {/* Center Title Capsule */}
        <View className="items-center flex-1 px-3">
          <View className="flex-row items-center gap-1.5 mb-0.5">
            <View
              className="h-2 w-2 rounded-full"
              style={{
                backgroundColor: active ? theme.accent : "#71717A",
              }}
            />
            <Text className="text-[10px] font-t3-bold uppercase tracking-widest text-zinc-400">
              CAR MODE · v{Constants.expoConfig?.version ?? "2.1.0"}
            </Text>
          </View>
          <Text
            className="text-base font-t3-bold tracking-tight text-white text-center"
            numberOfLines={1}
          >
            {thread?.projection.thread.title ?? "Conversation"}
          </Text>
        </View>

        {/* Thread Navigation Button (Safely out of driving thumb zone) */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open thread conversation"
          onPress={openConversation}
          className="h-10 px-3.5 flex-row items-center gap-1.5 rounded-full active:opacity-75"
          style={{
            backgroundColor: "rgba(255, 255, 255, 0.06)",
            borderWidth: 1,
            borderColor: "rgba(255, 255, 255, 0.12)",
          }}
        >
          <Text className="text-xs font-t3-medium text-zinc-200">Thread</Text>
          <SymbolView name="arrow.up.right" size={11} tintColor="#D4A373" />
        </Pressable>
      </View>

      {/* Center Stage: Hero Glowing Orb & Glance Status */}
      <View className="items-center justify-center px-5 flex-1">
        {/* The Hero Orb IS the interactive button */}
        <InteractiveHeroOrb
          phase={state.phase}
          active={active}
          onPress={handleToggle}
          disabled={!nativeVoice}
        />

        {/* Status Headline */}
        <Text
          accessibilityLiveRegion="polite"
          className="mt-4 text-center text-[30px] font-t3-bold tracking-tight text-white"
        >
          {theme.title}
        </Text>
        <Text className="mt-1 text-center text-sm font-t3-normal text-zinc-400 leading-5">
          {state.phase === "waiting" ? "Running workspace tools…" : theme.subtitle}
        </Text>

        {/* Single-Focus Phase Cards (Eliminates Vertical Layout Overflow) */}
        <View className="mt-4 w-full max-w-sm">
          {/* Waiting: Live Chain of Thought & Tool Execution Card */}
          {state.phase === "waiting" ? (
            <View
              className="w-full rounded-2xl p-4 shadow-md"
              style={{
                backgroundColor: "#111218",
                borderWidth: 1.5,
                borderColor: "rgba(212, 163, 115, 0.35)",
              }}
            >
              <View className="flex-row items-center justify-between mb-2">
                <View className="flex-row items-center gap-2">
                  <View
                    className="h-6 w-6 items-center justify-center rounded-full"
                    style={{ backgroundColor: "rgba(212, 163, 115, 0.2)" }}
                  >
                    <SymbolView
                      name={activeActivity ? activeActivity.icon : "gearshape"}
                      size={12}
                      tintColor="#D4A373"
                    />
                  </View>
                  <Text className="text-[11px] font-t3-bold uppercase tracking-wider text-[#D4A373]">
                    {activeActivity?.isReasoning ? "Reasoning" : "Active Tool Action"}
                  </Text>
                </View>
                <View className="flex-row items-center gap-1.5 rounded-full bg-amber-500/10 px-2 py-0.5 border border-amber-500/20">
                  <View className="h-1.5 w-1.5 rounded-full bg-[#D4A373]" />
                  <Text className="text-[10px] font-t3-medium text-[#D4A373]">Running</Text>
                </View>
              </View>
              <Text
                className="text-[19px] font-t3-bold text-white leading-7"
                numberOfLines={2}
              >
                {activeActivity ? activeActivity.label : "Thinking through workspace…"}
              </Text>
            </View>
          ) : null}

          {/* Speaking: Agent Response Card */}
          {state.phase === "speaking" && latestAgentReply ? (
            <View
              className="w-full rounded-2xl p-4 shadow-md"
              style={{
                backgroundColor: "#111218",
                borderWidth: 1.5,
                borderColor: "rgba(168, 197, 168, 0.38)",
              }}
            >
              <View className="flex-row items-center justify-between mb-2">
                <View className="flex-row items-center gap-2">
                  <View
                    className="h-6 w-6 items-center justify-center rounded-full"
                    style={{ backgroundColor: "rgba(168, 197, 168, 0.2)" }}
                  >
                    <SymbolView name="headphones" size={12} tintColor="#A8C5A8" />
                  </View>
                  <Text className="text-[11px] font-t3-bold uppercase tracking-wider text-[#A8C5A8]">
                    Agent Speaking
                  </Text>
                </View>
                <View className="flex-row items-center gap-1.5 rounded-full bg-emerald-500/15 px-2 py-0.5 border border-emerald-500/30">
                  <View className="h-1.5 w-1.5 rounded-full bg-[#A8C5A8]" />
                  <Text className="text-[10px] font-t3-medium text-[#A8C5A8]">Speaking</Text>
                </View>
              </View>
              <Text
                className="text-[19px] font-t3-medium text-white leading-7"
                numberOfLines={4}
                ellipsizeMode="tail"
              >
                {latestAgentReply}
              </Text>
            </View>
          ) : null}

          {/* Listening / Delivering: User Speech Transcription Card */}
          {(state.phase === "listening" || state.phase === "sending") && latestUserPrompt ? (
            <View
              className="w-full rounded-2xl p-4 shadow-md"
              style={{
                backgroundColor: "#111218",
                borderWidth: 1.5,
                borderColor: "rgba(229, 169, 103, 0.35)",
              }}
            >
              <View className="flex-row items-center justify-between mb-2">
                <View className="flex-row items-center gap-2">
                  <View
                    className="h-6 w-6 items-center justify-center rounded-full"
                    style={{ backgroundColor: "rgba(229, 169, 103, 0.2)" }}
                  >
                    <SymbolView name="mic" size={12} tintColor="#E5A967" />
                  </View>
                  <Text className="text-[11px] font-t3-bold uppercase tracking-wider text-[#E5A967]">
                    {state.phase === "listening" ? "Listening to You" : "Delivering Prompt"}
                  </Text>
                </View>
              </View>
              <Text
                className="text-[20px] font-t3-medium text-white leading-7"
                numberOfLines={3}
              >
                “{latestUserPrompt}”
              </Text>
            </View>
          ) : null}

          {/* Standby / Paused / Error: Previous Exchange Summary */}
          {(state.phase === "paused" || state.phase === "preparing" || state.phase === "error") &&
          (latestAgentReply || latestUserPrompt) ? (
            <View
              className="w-full rounded-2xl p-4 shadow-sm"
              style={{
                backgroundColor: "#111218",
                borderWidth: 1,
                borderColor: "rgba(255, 255, 255, 0.1)",
              }}
            >
              <View className="flex-row items-center justify-between mb-1.5">
                <Text className="text-[11px] font-t3-bold uppercase tracking-wider text-zinc-400">
                  Last Response
                </Text>
                <SymbolView name="clock" size={11} tintColor="#71717A" />
              </View>
              <Text
                className="text-[16px] font-t3-normal text-zinc-300 leading-6"
                numberOfLines={3}
                ellipsizeMode="tail"
              >
                {latestAgentReply || latestUserPrompt}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Alert Banner */}
        {state.error || actionError ? (
          <View
            className="mt-3.5 flex-row items-center gap-2 rounded-2xl px-4 py-2.5"
            style={{
              backgroundColor: "rgba(244, 114, 114, 0.12)",
              borderWidth: 1,
              borderColor: "rgba(244, 114, 114, 0.3)",
            }}
          >
            <SymbolView name="exclamationmark.triangle" size={14} tintColor="#F87171" />
            <Text accessibilityRole="alert" className="text-xs font-t3-normal text-rose-300">
              {state.error ?? actionError}
            </Text>
          </View>
        ) : null}

        {!nativeVoice ? (
          <View
            className="mt-3.5 rounded-2xl p-3"
            style={{
              backgroundColor: "rgba(244, 114, 114, 0.12)",
              borderWidth: 1,
              borderColor: "rgba(244, 114, 114, 0.3)",
            }}
          >
            <Text className="text-center text-xs font-t3-normal text-rose-300">
              Rebuild and install this version’s native iOS app to enable voice chat.
            </Text>
          </View>
        ) : null}
      </View>

      {/* Bottom Bar: Action-Aware (No duplicate mic) */}
      <View className="px-6 pb-2 items-center w-full">
        {isTurnActive ? (
          /* Prominent Stop Button when agent turn is active */
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop agent"
            onPress={handleInterrupt}
            className="w-full max-w-sm flex-row items-center justify-center gap-2.5 py-4 px-6 rounded-2xl active:opacity-75 active:scale-[0.98]"
            style={{
              backgroundColor: "rgba(244, 114, 114, 0.14)",
              borderWidth: 1.5,
              borderColor: "rgba(244, 114, 114, 0.35)",
            }}
          >
            <SymbolView name="stop.fill" size={18} tintColor="#F87171" />
            <Text className="text-base font-t3-bold text-rose-300">Stop Agent</Text>
          </Pressable>
        ) : (
          /* Minimalist status badge when idle */
          <View
            className="flex-row items-center gap-2 rounded-full px-4 py-2"
            style={{
              backgroundColor: "rgba(255, 255, 255, 0.04)",
              borderWidth: 1,
              borderColor: "rgba(255, 255, 255, 0.08)",
            }}
          >
            <SymbolView name="sparkles" size={12} tintColor="#D4A373" />
            <Text className="text-xs font-t3-medium text-zinc-400">
              Tap orb to speak · Auto-sends on pause
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}
