// app/organize/events/[id]/qr.tsx
// React Native only: do not reference DOM or use window APIs.
/**
 * Shared QR screen for BOTH roles (Organizer & Attendee).
 *
 * Routing policy (minimal-change, explicit by comments):
 *   - Attendee and Organizer both navigate to `/organize/events/[id]/qr`.
 *   - This is intentional to avoid route duplication and prevent Expo Go
 *     "unmatched route" drift after file adds/moves.
 *   - If, in the future, you want role-specific URLs without duplicating
 *     implementation, add a THIN WRAPPER at `app/events/[id]/qr.tsx`
 *     that simply renders this same screen component.
 *
 * Behavior:
 *   - Shows a rotating token QR that refreshes every PERIOD_SEC.
 *   - Token is derived from (secret, eventId, userId, slot).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity, Share } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import QRCode from "react-native-qrcode-svg";
import { getGuestId } from "../../../../../stores/session";
import { currentSlot, makeToken, PERIOD_SEC } from "../../../../../lib/qr";
import { STR } from "../../../../../lib/strings";

// IMPORTANT: Shared secret for token generation.
// Keep in sync with scanner verification side.
const SECRET = (process.env.EXPO_PUBLIC_QR_SECRET as string) || "DEV";

function resolveEventId(idParam?: string | string[] | null): string | null {
  const raw = Array.isArray(idParam) ? idParam[0] : idParam;
  const v = (raw ?? "").trim();
  if (!v || v === "undefined") return null;
  return v;
}

export default function Screen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const eventId = resolveEventId(params?.id ?? null);

  const [userId, setUserId] = useState<string | null>(null);
  const [token, setToken] = useState<string>("");
  const [slot, setSlot] = useState<number>(0);
  const [err, setErr] = useState<string | null>(null);

  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Load user id (guest or authed). This is used to bind the token.
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        setErr(null);
        const uid = await getGuestId();
        if (!mounted) return;
        if (!uid) {
          setErr("No userId");
          return;
        }
        setUserId(uid);
      } catch (e: any) {
        if (!mounted) return;
        setErr(e?.message ?? "Failed to load userId");
      }
    })();
    return () => {
      mounted = false;
      // Clear the periodic refresher on unmount to avoid leaks.
      if (timerRef.current) {
        clearInterval(timerRef.current as any);
        timerRef.current = null;
      }
    };
  }, []);

  // Compute slot & token — refresh every second.
  // NOTE: We intentionally run this in RN-only context; no window/DOM usage.
  useEffect(() => {
    if (!userId || !eventId) return;

    const tick = async () => {
      try {
        const s = currentSlot();
        setSlot(s);
        // makeToken(secret, eventId, userId, slot) → Promise<string>
        const t = await makeToken(SECRET, eventId, userId, s);
        setToken(t || ""); // ensure string
      } catch (e: any) {
        setErr(e?.message ?? "Failed to generate token");
        setToken("");
      }
    };

    // first run
    tick();
    // periodic refresh
    timerRef.current = setInterval(() => {
      // ignore unhandled rejections when unmounting
      tick().catch(() => {});
    }, 1000) as any;

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current as any);
        timerRef.current = null;
      }
    };
  }, [userId, eventId]);

  // Remaining seconds in current slot (for progress bar / UX hint)
  const remaining = useMemo(() => {
    const nowSlot = currentSlot();
    const rem = PERIOD_SEC - (Math.floor(Date.now() / 1000) % PERIOD_SEC);
    return Math.max(0, Math.min(PERIOD_SEC, rem + (slot - nowSlot) * PERIOD_SEC));
  }, [slot]);

  // Progress [0..1] within current slot
  const progress = useMemo(() => {
    const nowSlot = currentSlot();
    const secInSlot = PERIOD_SEC - (remaining + (slot - nowSlot) * PERIOD_SEC);
    return Math.max(0, Math.min(1, secInSlot / PERIOD_SEC));
  }, [remaining, slot]);

  // Share deep link for invite (does not leak token)
  const shareInvite = async () => {
    if (!eventId) return;
    const link = `rta://join?event=${eventId}`;
    try {
      await Share.share({ title: "Invite link", message: link });
    } catch {
      // ignore
    }
  };

  const goToScan = () => {
    if (!eventId) return;
    router.push({
      pathname: "/organize/events/[id]/scan",
      params: { id: eventId },
    } as any);
  };

  if (!eventId) {
    return (
      <View style={styles.center}>
        <Text style={{ fontWeight: "800" }}>No event id</Text>
      </View>
    );
  }

  if (!userId) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
        <Text style={styles.dim}>Loading…</Text>
        {err ? <Text style={{ color: "#B00020" }}>{err}</Text> : null}
      </View>
    );
  }

  const tokenReady = !!token; // guard for QRCode

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{STR.showMyQR}</Text>

      <View style={styles.qrBox}>
        {tokenReady ? (
          <QRCode value={token} size={240} />
        ) : (
          <View style={styles.qrLoading}>
            <ActivityIndicator />
            <Text style={styles.dim}>Generating token…</Text>
          </View>
        )}
      </View>

      <TouchableOpacity onPress={goToScan} style={styles.outlineSmall}>
        <Text style={styles.outlineSmallText}>SCAN QR</Text>
      </TouchableOpacity>

      <View style={{ width: "86%", height: 8, borderRadius: 999, backgroundColor: "#E5E7EB", overflow: "hidden" }}>
        <View style={{ width: `${Math.max(0, Math.min(100, progress * 100))}%`, height: "100%", backgroundColor: "#2563eb" }} />
      </View>

      <Text style={styles.dim}>A rotating token that refreshes every {PERIOD_SEC}s.</Text>
      <Text style={styles.help}>If scanning fails, wait until the bar reaches the end and try again.</Text>

      <View style={{ flexDirection: "row", gap: 12, width: "86%", marginTop: 16 }}>
        <TouchableOpacity onPress={shareInvite} style={styles.primary}>
          <Text style={styles.primaryText}>Share rta://join link</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => Share.share({ message: token })}
          style={[styles.outline, !tokenReady && { opacity: 0.5 }]}
          disabled={!tokenReady}
        >
          <Text style={styles.outlineText}>Share token</Text>
        </TouchableOpacity>
      </View>

      <View style={{ marginTop: 16, alignItems: "center" }}>
        <Text style={styles.dim}>slot: {slot}</Text>
        <Text style={styles.dim}>remaining: {remaining}s</Text>
        {err ? <Text style={{ color: "#B00020", marginTop: 4 }}>{err}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", paddingTop: 24, gap: 12, backgroundColor: "#fff" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  title: { fontSize: 18, fontWeight: "800" },
  qrBox: {
    padding: 16,
    backgroundColor: "#F3F4F6",
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 280,
    minWidth: 280,
  },
  qrLoading: { alignItems: "center", justifyContent: "center", gap: 8, minHeight: 240 },
  dim: { color: "#6B7280" },
  help: { color: "#374151", marginTop: 6, textAlign: "center" },
  primary: { flex: 1, backgroundColor: "#2563eb", borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  primaryText: { color: "#fff", fontWeight: "700" },
  outline: { flex: 1, borderWidth: 2, borderColor: "#2563eb", borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  outlineText: { color: "#2563eb", fontWeight: "700" },
  outlineSmall: {
    borderWidth: 1,
    borderColor: "#2563eb",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  outlineSmallText: {
    color: "#2563eb",
    fontWeight: "800",
    letterSpacing: 0.2,
    fontSize: 12,
  },
});
