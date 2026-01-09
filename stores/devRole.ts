import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { DeviceEventEmitter } from "react-native";
import Constants from "expo-constants";

export type Role = "attendee" | "organizer";

type DevRoleState = {
  serverRole: Role | null;
  roleOverride: Role | null;
  setServerRole: (role: Role | null | undefined) => void;
  setRoleOverride: (role: Role | null) => Promise<void>;
  clearOverride: () => Promise<void>;
};

const STORAGE_KEY = "@dev.roleOverride";
// Legacy key for older screens (Profile, event detail, etc.)
const LEGACY_ROLE_KEY = "rta_dev_role";
const ROLE_EVENT = "rta_role_changed";

type AppEnv = "production" | "internal" | "development" | "staging" | "preview" | string;

function getAppEnv(): AppEnv {
  try {
    const anyConstants: any = Constants as any;

    const fromExpoConfig: any = anyConstants?.expoConfig;
    const fromManifest: any = anyConstants?.manifest;
    const fromManifest2: any = anyConstants?.manifest2;

    const env =
      fromExpoConfig?.extra?.appEnv ??
      fromManifest?.extra?.appEnv ??
      fromManifest2?.extra?.appEnv ??
      undefined;

    if (typeof env === "string" && env.trim().length > 0) return env.trim();
  } catch {
    // ignore
  }

  // Safe default: treat unknown as internal/non-production.
  return "internal";
}

// Single place to toggle dev override behavior.
// Hard safety rule: NEVER enable dev UI in production builds.
export function devSwitchEnabled(): boolean {
  const appEnv = getAppEnv();
  if (appEnv === "production") return false;

  const isDev = typeof __DEV__ !== "undefined" && __DEV__;

  const envEnabled =
    typeof process !== "undefined" &&
    typeof process.env !== "undefined" &&
    process.env.EXPO_PUBLIC_ENABLE_DEV_SWITCH === "1";

  return isDev || envEnabled;
}

export const useDevRoleStore = create<DevRoleState>((set) => ({
  serverRole: null,
  roleOverride: null,

  setServerRole: (role) => set({ serverRole: role ?? null }),

  setRoleOverride: async (role) => {
    if (!devSwitchEnabled()) return;

    const nextRole: Role | null = role ?? null;
    set({ roleOverride: nextRole });

    try {
      if (nextRole) {
        await AsyncStorage.setItem(STORAGE_KEY, nextRole);
        // Keep legacy key in sync so older screens still work until migrated.
        await AsyncStorage.setItem(LEGACY_ROLE_KEY, nextRole);
      } else {
        await AsyncStorage.removeItem(STORAGE_KEY);
        await AsyncStorage.removeItem(LEGACY_ROLE_KEY);
      }
    } catch {
      // ignore storage errors
    }

    // Emit legacy event for older listeners (Profile, event detail, etc.)
    try {
      if (nextRole) {
        DeviceEventEmitter.emit(ROLE_EVENT, nextRole);
      }
    } catch {
      // ignore
    }
  },

  clearOverride: async () => {
    if (!devSwitchEnabled()) return;

    set({ roleOverride: null });
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
      await AsyncStorage.removeItem(LEGACY_ROLE_KEY);
    } catch {
      // ignore
    }
  },
}));

// ---- Derived role (hook) ----
export function useEffectiveRole(): Role {
  const serverRole = useDevRoleStore((s) => s.serverRole);
  const roleOverride = useDevRoleStore((s) => s.roleOverride);

  // When dev switch is disabled, ignore any override and rely solely on serverRole.
  if (!devSwitchEnabled()) {
    return (serverRole as Role) ?? "attendee";
  }

  // When dev switch is enabled, allow override to take precedence.
  return (roleOverride as Role) ?? (serverRole as Role) ?? "attendee";
}

// one-shot restore at app start
export async function restoreDevRoleOverride() {
  if (!devSwitchEnabled()) return;
  try {
    // Prefer new key, fall back to legacy key if needed.
    let val = await AsyncStorage.getItem(STORAGE_KEY);
    if (val !== "attendee" && val !== "organizer") {
      val = await AsyncStorage.getItem(LEGACY_ROLE_KEY);
    }
    if (val === "attendee" || val === "organizer") {
      await useDevRoleStore.getState().setRoleOverride(val);
    }
  } catch {
    // ignore
  }
}

// ---- Convenience custom hooks (use* names) ----
export function useIsOrganizer() {
  return useEffectiveRole() === "organizer";
}

export function useIsAttendee() {
  return useEffectiveRole() === "attendee";
}
