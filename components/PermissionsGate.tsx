// app/PermissionsGate.tsx
import React, { useEffect, useRef, useState } from "react";
import { View, Text, ActivityIndicator, StyleSheet, Platform, Linking } from "react-native";
import * as Location from "expo-location";

type Props = { children: React.ReactNode };

type Phase =
  | "init"
  | "fg-perm-check"
  | "fg-perm-request"
  | "services-check"
  | "bg-perm-skip"   // renamed to indicate we skip background API
  | "get-location"
  | "ready"
  | "failed";

const STEP_TIMEOUT_MS = 8000;     // Per-step timeout
const GLOBAL_BAILOUT_MS = 30000;  // Global ceiling (force ready after this)

const log = (...args: any[]) => console.log("[PermGate]", ...args);
const warn = (...args: any[]) => console.warn("[PermGate]", ...args);
const err  = (...args: any[]) => console.error("[PermGate]", ...args);

export default function PermissionsGate({ children }: Props) {
  const [phase, setPhase] = useState<Phase>("init");
  const [message, setMessage] = useState<string>("Starting…");
  const [errors, setErrors] = useState<string[]>([]);
  const doneRef = useRef(false);

  // step helper with timeout
  const runStep = async <T,>(name: Phase, fn: () => Promise<T>): Promise<T | undefined> => {
    setPhase(name);
    setMessage(name);
    log("STEP begin:", name);

    const timer = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`step-timeout:${name}`)), STEP_TIMEOUT_MS)
    );

    try {
      const result = await Promise.race([fn(), timer]);
      log("STEP OK:", name, result ?? "");
      return result as T;
    } catch (e: any) {
      const m = String(e?.message ?? e);
      if (m.startsWith("step-timeout:")) {
        warn("STEP TIMEOUT:", name);
        setErrors((s) => [...s, `${name}: timeout`]);
      } else {
        err("STEP FAIL:", name, m);
        setErrors((s) => [...s, `${name}: ${m}`]);
      }
      return undefined;
    }
  };

  useEffect(() => {
    if (doneRef.current) return;
    doneRef.current = true;

    const globalBail = setTimeout(() => {
      warn("GLOBAL TIMEOUT -> forcing ready");
      setPhase("ready");
      setMessage("Forced ready by global timeout");
    }, GLOBAL_BAILOUT_MS);

    (async () => {
      try {
        // 1) Foreground permission check → request if needed
        const fgStat = await runStep("fg-perm-check", () => Location.getForegroundPermissionsAsync());
        if (!fgStat?.granted) {
          await runStep("fg-perm-request", async () => {
            const r = await Location.requestForegroundPermissionsAsync();
            if (!r.granted) throw new Error(`foreground denied (status=${r.status})`);
            return r;
          });
        }

        // 2) Check if location services (GPS, etc.) are enabled
        const services = await runStep("services-check", () => Location.hasServicesEnabledAsync());
        if (services === false) {
          warn("Location services are OFF");
          setErrors((s) => [...s, "Location services are OFF"]);
          // We proceed anyway. If needed, guide users via Linking.openSettings().
        }

        // 3) Background permission — TEMPORARILY SKIPPED to avoid manifest warning
        await runStep("bg-perm-skip", async () => {
          log("Background permission check is intentionally skipped (no manifest entry).");
        });

        // 4) One-shot current position (low → high accuracy fallback)
        const got = await runStep("get-location", async () => {
          try {
            const low = await Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.Balanced,
              mayShowUserSettingsDialog: true,
            });
            return { phase: "low", coords: low.coords };
          } catch (e) {
            warn("low-accuracy getCurrentPosition failed; retry high accuracy", String((e as any)?.message ?? e));
            const hi = await Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.Highest,
              mayShowUserSettingsDialog: true,
            });
            return { phase: "high", coords: hi.coords };
          }
        });
        if (!got) warn("get-location produced no fix (timeout or error) — continuing");

        setPhase("ready");
        setMessage("Ready");
        clearTimeout(globalBail);
      } catch (e) {
        err("FATAL: PermissionsGate initialization failed:", e);
        setErrors((s) => [...s, `Fatal error: ${String(e)}`]);
        // Force ready to prevent app from being stuck
        setPhase("ready");
        setMessage("Ready (with errors)");
        clearTimeout(globalBail);
      }
    })();

    return () => clearTimeout(globalBail);
  }, []);

  // Gate screen (we allow progress even if some steps fail)
  if (phase !== "ready") {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
        <Text style={styles.h1}>Preparing…</Text>
        <Text style={styles.sub}>phase: {phase}</Text>
        {errors.length ? (
          <View style={styles.box}>
            {errors.map((e, i) => (
              <Text key={i} style={styles.err}>• {e}</Text>
            ))}
            {Platform.OS === "android" ? (
              <Text style={styles.link} onPress={() => Linking.openSettings()}>
                Open app settings
              </Text>
            ) : null}
          </View>
        ) : null}
        <Text style={styles.hint}>Check logcat tag: <Text style={styles.code}>[PermGate]</Text></Text>
      </View>
    );
  }

  // Ready → render children
  return <>{children}</>;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  h1: { marginTop: 12, fontSize: 18, fontWeight: "800" },
  sub: { marginTop: 4, color: "#6b7280" },
  box: { marginTop: 12, padding: 10, borderWidth: 1, borderColor: "#fca5a5", backgroundColor: "#fff1f2", borderRadius: 8, width: "92%" },
  err: { color: "#b91c1c" },
  hint: { marginTop: 10, color: "#6b7280" },
  link: { marginTop: 6, color: "#2563eb", textDecorationLine: "underline" },
  code: { fontFamily: Platform.select({ android: "monospace", ios: "Menlo", default: "monospace" }) },
});




