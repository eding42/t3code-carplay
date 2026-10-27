import { requireOptionalNativeModule, type NativeModule } from "expo";
import { Platform } from "react-native";

interface NativeVoice extends NativeModule {
  prepare(): Promise<void>;
  listen(): Promise<string>;
  speak(text: string): Promise<void>;
  stop(): Promise<void>;
}

export const nativeVoice =
  Platform.OS === "ios" ? requireOptionalNativeModule<NativeVoice>("T3Voice") : null;
