import { useAtomValue } from "@effect/atom-react";
import {
  CommonActions,
  useFocusEffect,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useDerivedValue,
  withRepeat,
  withSequence,
  withTiming,
  type DerivedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { environmentThreadDetails, environmentThreadShells } from "../../state/threads";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { createDrivingConversation } from "./drivingRuntime";
import { nativeVoice } from "./nativeVoice";
import { spokenReply, type VoicePhase } from "./voiceConversation";

const THEME_BY_PHASE: Record<
  VoicePhase,
  {
    badge: string;
    title: string;
    subtitle: string;
    glowStart: string;
    glowMid: string;
    accent: string;
    accentGradient: string;
    icon: AppSymbolName;
  }
> = {
  paused: {
    badge: "READY",
    title: "Tap to Speak",
    subtitle: "Hands-free voice mode is on standby",
    glowStart: "rgba(148, 163, 184, 0.22)",
    glowMid: "rgba(51, 65, 85, 0.08)",
    accent: "#94A3B8",
    accentGradient: "#64748B",
    icon: "mic",
  },
  preparing: {
    badge: "INITIALIZING",
    title: "Starting Up…",
    subtitle: "Configuring on-device audio engine",
    glowStart: "rgba(56, 189, 248, 0.32)",
    glowMid: "rgba(2, 132, 199, 0.12)",
    accent: "#38BDF8",
    accentGradient: "#0284C7",
    icon: "headphones",
  },
  listening: {
    badge: "LISTENING",
    title: "Listening…",
    subtitle: "Speak naturally · 2s pause auto-sends",
    glowStart: "rgba(14, 165, 233, 0.42)",
    glowMid: "rgba(3, 105, 161, 0.16)",
    accent: "#00F2FE",
    accentGradient: "#0284C7",
    icon: "mic",
  },
  sending: {
    badge: "SENDING",
    title: "Delivering…",
    subtitle: "Transmitting prompt to agent",
    glowStart: "rgba(192, 132, 252, 0.38)",
    glowMid: "rgba(126, 34, 206, 0.15)",
    accent: "#C084FC",
    accentGradient: "#7E22CE",
    icon: "arrow.up",
  },
  waiting: {
    badge: "THINKING",
    title: "Thinking…",
    subtitle: "Inspecting codebase & running tools",
    glowStart: "rgba(129, 140, 248, 0.36)",
    glowMid: "rgba(67, 56, 202, 0.14)",
    accent: "#818CF8",
    accentGradient: "#4338CA",
    icon: "brain",
  },
  speaking: {
    badge: "SPEAKING",
    title: "Speaking…",
    subtitle: "Streaming response through vehicle audio",
    glowStart: "rgba(52, 211, 153, 0.4)",
    glowMid: "rgba(4, 120, 87, 0.16)",
    accent: "#34D399",
    accentGradient: "#047857",
    icon: "headphones",
  },
  error: {
    badge: "PAUSED",
    title: "Attention Needed",
    subtitle: "Safely review details when parked",
    glowStart: "rgba(248, 113, 113, 0.32)",
    glowMid: "rgba(185, 28, 28, 0.12)",
    accent: "#F87171",
    accentGradient: "#B91C1C",
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
      <View className="flex-1 items-center justify-center bg-black p-8">
        <SymbolView name="iphone" size={48} tintColor="#71717A" />
        <Text className="mt-4 text-center text-lg font-t3-bold text-white">iPhone Only</Text>
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
    <View className="flex-1 bg-black">
      {/* Top Ambient Glow */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <Svg height="100%" width="100%">
          <Defs>
            <RadialGradient id="picker-aura" cx="50%" cy="15%" r="65%">
              <Stop offset="0%" stopColor="rgba(14, 165, 233, 0.22)" stopOpacity="1" />
              <Stop offset="50%" stopColor="rgba(2, 132, 199, 0.06)" stopOpacity="1" />
              <Stop offset="100%" stopColor="transparent" stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height="100%" fill="url(#picker-aura)" />
        </Svg>
      </View>

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="px-5 py-6 gap-6"
        style={{ paddingBottom: Math.max(insets.bottom, 24) }}
      >
        {/* Luxury Cockpit Hero */}
        <View className="items-center pt-6 pb-2">
          <View className="h-20 w-20 items-center justify-center rounded-3xl bg-blue-500/10 border border-blue-400/25 mb-4 shadow-xl shadow-blue-500/25">
            <SymbolView name="car" size={38} tintColor="#38BDF8" />
          </View>
          <Text className="text-3xl font-t3-bold text-white tracking-tight">Car Mode</Text>
          <Text className="mt-2 text-center text-sm font-t3-medium text-zinc-400 max-w-xs leading-5">
            Hands-free voice assistant built for driving. Continuous conversational coding with
            automatic pause detection.
          </Text>

          {/* Feature Badges */}
          <View className="mt-5 flex-row items-center gap-2">
            <View className="flex-row items-center gap-1.5 rounded-full bg-white/[0.06] border border-white/10 px-3 py-1">
              <SymbolView name="sparkles" size={12} tintColor="#38BDF8" />
              <Text className="text-[11px] font-t3-bold text-sky-400">Zero Touch</Text>
            </View>
            <View className="flex-row items-center gap-1.5 rounded-full bg-white/[0.06] border border-white/10 px-3 py-1">
              <SymbolView name="headphones" size={12} tintColor="#34D399" />
              <Text className="text-[11px] font-t3-bold text-emerald-400">Car Audio</Text>
            </View>
            <View className="flex-row items-center gap-1.5 rounded-full bg-white/[0.06] border border-white/10 px-3 py-1">
              <SymbolView name="info.circle" size={12} tintColor="#A1A1AA" />
              <Text className="text-[11px] font-t3-bold text-zinc-300">On-Device</Text>
            </View>
          </View>
        </View>

        {/* Threads List */}
        <View className="gap-3">
          <View className="flex-row items-center justify-between px-1">
            <Text className="text-xs font-t3-bold uppercase tracking-widest text-zinc-500">
              Select Conversation
            </Text>
            <Text className="text-xs font-t3-medium text-zinc-600">
              {conversations.length} {conversations.length === 1 ? "thread" : "threads"}
            </Text>
          </View>

          {conversations.length === 0 ? (
            <View className="items-center justify-center rounded-3xl border border-dashed border-zinc-800 py-16 px-6">
              <SymbolView name="bubble.left.and.bubble.right" size={36} tintColor="#52525B" />
              <Text className="mt-3 text-center text-base font-t3-bold text-zinc-300">
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
              className="flex-row items-center justify-between rounded-3xl border border-white/[0.08] bg-zinc-900/70 p-4 active:bg-zinc-800/80 active:scale-[0.99]"
            >
              <View className="flex-1 pr-3">
                <Text className="text-base font-t3-bold text-white" numberOfLines={1}>
                  {thread.title}
                </Text>
                <View className="mt-2 flex-row items-center gap-2">
                  <View className="flex-row items-center gap-1 rounded-full bg-blue-500/15 border border-blue-400/25 px-2.5 py-0.5">
                    <SymbolView name="sparkles" size={10} tintColor="#38BDF8" />
                    <Text className="text-[11px] font-t3-bold text-sky-400" numberOfLines={1}>
                      {thread.modelSelection.model}
                    </Text>
                  </View>
                  <Text className="text-xs text-zinc-500" numberOfLines={1}>
                    {thread.environmentId}
                  </Text>
                </View>
              </View>
              <View className="h-9 w-9 items-center justify-center rounded-full bg-white/[0.06] border border-white/10">
                <SymbolView name="chevron.right" size={14} tintColor="#94A3B8" />
              </View>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function AmbientAuraBackdrop({ theme }: { readonly theme: (typeof THEME_BY_PHASE)[VoicePhase] }) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Svg height="100%" width="100%" style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="cockpit-glow" cx="50%" cy="38%" r="62%">
            <Stop offset="0%" stopColor={theme.glowStart} stopOpacity="1" />
            <Stop offset="45%" stopColor={theme.glowMid} stopOpacity="1" />
            <Stop offset="100%" stopColor="transparent" stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#cockpit-glow)" />
      </Svg>
    </View>
  );
}

function LivingCelestialOrb({
  phase,
  active,
}: {
  readonly phase: VoicePhase;
  readonly active: boolean;
}) {
  const theme = THEME_BY_PHASE[phase];

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
      : withTiming(0, { duration: 350 }),
  );

  const haloAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + haloAnim.value * 0.16 }],
    opacity: active ? 0.35 + haloAnim.value * 0.45 : 0.15,
  }));

  const rippleAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + haloAnim.value * 0.08 }],
    opacity: active ? 0.25 + haloAnim.value * 0.35 : 0.1,
  }));

  const coreAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: active ? 1 + haloAnim.value * 0.03 : 1 }],
  }));

  return (
    <View className="my-3 items-center justify-center" style={{ height: 210, width: 210 }}>
      {/* Outer Ethereal Bloom Halo */}
      <Animated.View
        style={[
          haloAnimatedStyle,
          {
            width: 200,
            height: 200,
            borderRadius: 100,
            backgroundColor: theme.glowStart,
            position: "absolute",
          },
        ]}
      />

      {/* Secondary Acoustic Ripple Ring */}
      <Animated.View
        style={[
          rippleAnimatedStyle,
          {
            width: 160,
            height: 160,
            borderRadius: 80,
            borderWidth: 1,
            borderColor: active ? "rgba(255, 255, 255, 0.18)" : "rgba(255, 255, 255, 0.06)",
            backgroundColor: "rgba(255, 255, 255, 0.02)",
            position: "absolute",
          },
        ]}
      />

      {/* Centerpiece Frosted Sound Chamber Disc */}
      <Animated.View
        style={[
          coreAnimatedStyle,
          {
            width: 124,
            height: 124,
            borderRadius: 62,
            backgroundColor: "#070B14",
            borderWidth: 1.5,
            borderTopColor: "rgba(255, 255, 255, 0.35)",
            borderBottomColor: "rgba(255, 255, 255, 0.08)",
            borderLeftColor: "rgba(255, 255, 255, 0.15)",
            borderRightColor: "rgba(255, 255, 255, 0.15)",
            shadowColor: theme.accent,
            shadowOffset: { width: 0, height: 0 },
            shadowOpacity: active ? 0.85 : 0.2,
            shadowRadius: active ? 32 : 12,
          },
        ]}
        className="items-center justify-center"
      >
        {/* Dynamic 11-Bar Fluid Equalizer Waveform */}
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
      </Animated.View>
    </View>
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
    const height = 6 + normalized * bar.envelope * 20;
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
  const selectDetail = useSelectWorkspaceDetail();
  const insets = useSafeAreaInsets();
  const runtime = useMemo(() => createDrivingConversation(threadRef), [threadRef]);
  const { conversation } = runtime;
  const state = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot);
  const thread = useAtomValue(environmentThreadDetails.quietThreadAtom(threadRef));
  const [actionError, setActionError] = useState<string | null>(null);
  const active = state.phase !== "paused" && state.phase !== "error";
  const theme = THEME_BY_PHASE[state.phase];

  useFocusEffect(useCallback(() => runtime.mount(), [runtime]));

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

  const openConversation = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    conversation.pause();
    selectDetail({
      name: "Thread",
      params: {
        environmentId: threadRef.environmentId,
        threadId: threadRef.threadId,
      },
    });
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
      className="flex-1 bg-black justify-between"
      style={{
        paddingTop: Math.max(insets.top, 16),
        paddingBottom: Math.max(insets.bottom, 24),
      }}
    >
      {/* Background Ambient Aura */}
      <AmbientAuraBackdrop theme={theme} />

      {/* Top Floating Cockpit Capsule */}
      <View className="px-5 pt-1 flex-row items-center justify-between">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            conversation.pause();
            navigation.goBack();
          }}
          className="h-10 w-10 items-center justify-center rounded-full bg-white/[0.08] border border-white/10 active:bg-white/[0.15]"
        >
          <SymbolView name="chevron.left" size={16} tintColor="#D4D4D8" />
        </Pressable>

        {/* Center Title Capsule */}
        <View className="items-center flex-1 px-3">
          <View className="flex-row items-center gap-1.5 mb-0.5">
            <View
              className="h-2 w-2 rounded-full"
              style={{
                backgroundColor: active ? theme.accent : "#71717A",
                shadowColor: active ? theme.accent : "transparent",
                shadowOpacity: 0.8,
                shadowRadius: 4,
              }}
            />
            <Text className="text-[11px] font-t3-bold uppercase tracking-widest text-zinc-400">
              CAR MODE
            </Text>
          </View>
          <Text className="text-base font-t3-bold text-white text-center" numberOfLines={1}>
            {thread?.projection.thread.title ?? "Conversation"}
          </Text>
        </View>

        {/* Model Capsule */}
        <View className="flex-row items-center gap-1 rounded-full bg-white/[0.08] border border-white/10 px-3 py-1">
          <SymbolView name="sparkles" size={11} tintColor={theme.accent} />
          <Text className="text-[11px] font-t3-bold text-zinc-200" numberOfLines={1}>
            {thread?.projection.thread.modelSelection.model ?? "Model"}
          </Text>
        </View>
      </View>

      {/* Center Stage: Celestial Soundwave & Cockpit HUD */}
      <View className="items-center justify-center px-5 flex-1">
        {/* Living Celestial Sound Orb */}
        <LivingCelestialOrb phase={state.phase} active={active} />

        {/* HUD Phase Tag */}
        <View
          className="mb-1.5 flex-row items-center gap-1.5 rounded-full px-3 py-0.5 border"
          style={{
            backgroundColor: active ? "rgba(255, 255, 255, 0.06)" : "transparent",
            borderColor: active ? theme.accent : "rgba(255, 255, 255, 0.1)",
          }}
        >
          <SymbolView name={theme.icon} size={12} tintColor={theme.accent} />
          <Text
            className="text-[10px] font-t3-bold uppercase tracking-widest"
            style={{ color: theme.accent }}
          >
            {theme.badge}
          </Text>
        </View>

        {/* Main Status Headline */}
        <Text
          accessibilityLiveRegion="polite"
          className="text-center text-2xl font-t3-bold text-white tracking-tight"
        >
          {theme.title}
        </Text>
        <Text className="mt-1 text-center text-xs font-t3-medium text-zinc-400">
          {theme.subtitle}
        </Text>

        {/* Heads-Up Conversation Transcript & Agent Reply Cards */}
        <View className="mt-4 w-full max-w-sm gap-2.5">
          {/* User Spoken Prompt Card */}
          {latestUserPrompt ? (
            <GlassSurface
              glassEffectStyle="regular"
              className="rounded-2xl border border-sky-400/20 px-4 py-2.5 shadow-lg"
            >
              <View className="flex-row items-center gap-1.5 mb-1">
                <SymbolView name="mic" size={10} tintColor="#38BDF8" />
                <Text className="text-[10px] font-t3-bold uppercase tracking-wider text-sky-400">
                  You Said
                </Text>
              </View>
              <Text
                className="text-xs font-t3-medium italic text-zinc-100 leading-4"
                numberOfLines={2}
              >
                “{latestUserPrompt}”
              </Text>
            </GlassSurface>
          ) : null}

          {/* Agent Spoken Response Card */}
          {latestAgentReply ? (
            <GlassSurface
              glassEffectStyle="regular"
              className="rounded-2xl border border-emerald-400/20 px-4 py-2.5 shadow-lg"
            >
              <View className="flex-row items-center justify-between mb-1">
                <View className="flex-row items-center gap-1.5">
                  <SymbolView name="sparkles" size={10} tintColor="#34D399" />
                  <Text className="text-[10px] font-t3-bold uppercase tracking-wider text-emerald-400">
                    Agent Reply
                  </Text>
                </View>
                {state.phase === "speaking" ? (
                  <View className="flex-row items-center gap-1">
                    <View className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400" />
                    <Text className="text-[9px] font-t3-medium text-emerald-400">Speaking</Text>
                  </View>
                ) : null}
              </View>
              <Text className="text-xs font-t3-medium text-zinc-200 leading-4" numberOfLines={3}>
                {latestAgentReply}
              </Text>
            </GlassSurface>
          ) : null}
        </View>

        {/* Alert Banner */}
        {state.error || actionError ? (
          <View className="mt-3 flex-row items-center gap-2 rounded-2xl bg-red-500/15 border border-red-500/35 px-4 py-2">
            <SymbolView name="exclamationmark.triangle" size={14} tintColor="#F87171" />
            <Text accessibilityRole="alert" className="text-xs font-t3-medium text-red-300">
              {state.error ?? actionError}
            </Text>
          </View>
        ) : null}

        {!nativeVoice ? (
          <View className="mt-3 rounded-2xl bg-red-500/15 border border-red-500/35 p-3">
            <Text className="text-center text-xs text-red-300">
              Rebuild and install this version’s native iOS app to enable voice chat.
            </Text>
          </View>
        ) : null}
      </View>

      {/* Bottom Cockpit Glass Console */}
      <View className="px-6 pt-2">
        <GlassSurface
          glassEffectStyle="regular"
          className="flex-row items-center justify-around py-3 px-4 rounded-3xl border border-white/10 shadow-2xl shadow-black"
        >
          {/* Emergency Stop / Interrupt */}
          <View className="items-center gap-1.5">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Stop agent"
              onPress={handleInterrupt}
              className="items-center justify-center rounded-full bg-red-500/15 border border-red-500/30 active:bg-red-500/35 active:scale-95"
              style={{ width: 52, height: 52 }}
            >
              <SymbolView name="stop.fill" size={20} tintColor="#EF4444" />
            </Pressable>
            <Text className="text-[11px] font-t3-medium text-zinc-400">Interrupt</Text>
          </View>

          {/* Hero Jewel Voice Button */}
          <View className="items-center gap-1.5">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={active ? "Pause voice chat" : "Start voice chat"}
              disabled={!nativeVoice}
              onPress={handleToggle}
              className="items-center justify-center rounded-full active:scale-95"
              style={{
                width: 76,
                height: 76,
                borderRadius: 38,
                backgroundColor: active ? "#0F172A" : "#1D4ED8",
                borderWidth: 2,
                borderColor: active ? theme.accent : "#60A5FA",
                shadowColor: active ? theme.accent : "#3B82F6",
                shadowOpacity: 0.85,
                shadowRadius: 24,
              }}
            >
              <SymbolView name={active ? "pause" : "mic"} size={32} tintColor="#FFFFFF" />
            </Pressable>
            <Text className="text-xs font-t3-bold text-white">
              {active ? "Pause" : "Start Voice"}
            </Text>
          </View>

          {/* Full Conversation View */}
          <View className="items-center gap-1.5">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open full conversation"
              onPress={openConversation}
              className="items-center justify-center rounded-full bg-white/[0.08] border border-white/10 active:bg-white/[0.15] active:scale-95"
              style={{ width: 52, height: 52 }}
            >
              <SymbolView name="bubble.left.and.bubble.right" size={20} tintColor="#E2E8F0" />
            </Pressable>
            <Text className="text-[11px] font-t3-medium text-zinc-400">Thread</Text>
          </View>
        </GlassSurface>
      </View>
    </View>
  );
}
