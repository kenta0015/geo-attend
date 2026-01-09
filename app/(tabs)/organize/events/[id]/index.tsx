// app/(tabs)/organize/events/[id]/index.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  DeviceEventEmitter,
  Linking,
  Alert,
  Platform,
  ScrollView,
} from "react-native";
import { useLocalSearchParams, router, usePathname } from "expo-router";
import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "../../../../../lib/supabase";
import { haversineMeters, accuracyThreshold } from "../../../../../lib/geo";
import { getGuestId } from "../../../../../stores/session";
import { useEffectiveRole } from "../../../../../stores/devRole";
import { armGeofenceAt, disarmGeofence, geofenceStatus } from "../../../../../lib/geofenceActions";

type EventRow = {
  id: string;
  title: string | null;
  start_utc: string | null;
  end_utc: string | null;
  venue_lat: number | null;
  venue_lng: number | null;
  venue_radius_m: number | null;
  location_name?: string | null;
};

type RSVPStatus = "going" | "not_going" | null;

const BLUE = "#2563EB";
const CARD_BORDER = "#E5E7EB";
const DISCLOSURE_KEY = "@geoattendance.locationDisclosure.v1";
const PROOF_LOG_KEY = "@geoattendance.proofLog.v1";

type ProofLogDecision = "blocked" | "allowed" | "started" | "stopped" | "error";
type ProofLogAction = "start" | "stop" | "status";

type ProofLogEntry = {
  at: string; // ISO
  action: ProofLogAction;
  decision: ProofLogDecision;
  reason?: string;
  event_id?: string | null;
  role?: string | null;
  platform?: string;
  meta?: Record<string, any>;
};

// --- helpers -----------------------------------------------------------------
function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function safeIsoNow() {
  try {
    return new Date().toISOString();
  } catch {
    return String(Date.now());
  }
}

function formatProofLine(e: ProofLogEntry): string {
  const when = (() => {
    try {
      return new Date(e.at).toLocaleString();
    } catch {
      return e.at;
    }
  })();
  const action = e.action.toUpperCase();
  const decision = e.decision.toUpperCase();
  const reason = e.reason ? ` — ${e.reason}` : "";
  const eventPart = e.event_id ? ` (event=${String(e.event_id).slice(0, 8)}…)` : "";
  return `[${when}] ${action} ${decision}${eventPart}${reason}`;
}

async function readProofLog(): Promise<ProofLogEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(PROOF_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(Boolean) as ProofLogEntry[];
  } catch {
    return [];
  }
}

async function appendProofLog(entry: ProofLogEntry) {
  try {
    const existing = await readProofLog();
    const next = [...existing, entry];
    const capped = next.slice(Math.max(0, next.length - 60));
    await AsyncStorage.setItem(PROOF_LOG_KEY, JSON.stringify(capped));
  } catch {}
}

async function clearProofLog() {
  try {
    await AsyncStorage.removeItem(PROOF_LOG_KEY);
  } catch {}
}

async function getEffectiveUserId(): Promise<string> {
  try {
    const { data } = await supabase.auth.getUser();
    const uid = data?.user?.id;
    if (uid && uid.length > 0) return uid;
  } catch {}
  return await getGuestId();
}

function clampRadius(input?: number | null) {
  const v = input ?? 100;
  return Math.min(150, Math.max(100, Math.floor(v)));
}

function parseUtcMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function isNowWithinEventWindowUtc(event: Pick<EventRow, "start_utc" | "end_utc">): {
  ok: boolean;
  nowMs: number;
  startMs: number | null;
  endMs: number | null;
} {
  const nowMs = Date.now();
  const startMs = parseUtcMs(event.start_utc);
  const endMs = parseUtcMs(event.end_utc);
  if (startMs == null || endMs == null) return { ok: false, nowMs, startMs, endMs };
  return { ok: startMs <= nowMs && nowMs <= endMs, nowMs, startMs, endMs };
}

async function openAppSettingsSafe() {
  try {
    if (typeof Linking.openSettings === "function") {
      await Linking.openSettings();
      return;
    }
  } catch {}
  try {
    await Linking.openURL("app-settings:");
  } catch {}
}

// =============================================================================
export default function OrganizeEventDetail() {
  const params = useLocalSearchParams<{ id?: string }>();
  const eid = useMemo(() => {
    const s = (params.id ?? "").toString();
    return s && s !== "undefined" ? s : null;
  }, [params.id]);

  console.log("[A-2 LOADED] /organize/events/[id].tsx");

  const pathname = usePathname();
  const renders = useRef(0);
  useEffect(() => {
    renders.current += 1;
    console.log("[route]", pathname, "id=", eid, "renders=", renders.current);
  }, [pathname, eid]);

  const role = useEffectiveRole();
  const showDev = __DEV__;

  // === Proof log preview ======================================================
  const [proofLastLine, setProofLastLine] = useState<string>("—");
  const [proofCount, setProofCount] = useState<number>(0);

  const refreshProofPreview = useCallback(async () => {
    if (!showDev) return;
    const entries = await readProofLog();
    setProofCount(entries.length);
    const last = entries.length > 0 ? entries[entries.length - 1] : null;
    setProofLastLine(last ? formatProofLine(last) : "—");
  }, [showDev]);

  useEffect(() => {
    if (!showDev) return;
    refreshProofPreview();
  }, [refreshProofPreview, showDev]);

  const showProofLog = useCallback(async () => {
    if (!showDev) return;
    const entries = await readProofLog();
    setProofCount(entries.length);
    if (!entries.length) {
      Alert.alert("Proof log", "No entries yet.");
      return;
    }
    const lastN = entries.slice(Math.max(0, entries.length - 12));
    const text = lastN.map(formatProofLine).join("\n");
    Alert.alert("Proof log (last entries)", text);
  }, [showDev]);

  const handleClearProofLog = useCallback(() => {
    if (!showDev) return;
    Alert.alert("Clear proof log", "This will remove local proof logs on this device.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: async () => {
          await clearProofLog();
          await refreshProofPreview();
          Alert.alert("Cleared", "Proof log cleared.");
        },
      },
    ]);
  }, [refreshProofPreview, showDev]);

  // === Event load ============================================================
  const [loading, setLoading] = useState(true);
  const [eventRow, setEventRow] = useState<EventRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!eid) return;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data, error } = await supabase
          .from("events")
          .select(
            "id,title,start_utc,end_utc,venue_lat:lat,venue_lng:lng,venue_radius_m:radius_m,location_name"
          )
          .eq("id", eid)
          .maybeSingle();

        if (error) throw error;
        if (!data) throw new Error("Event not found.");
        setEventRow(data as unknown as EventRow);
      } catch (e: any) {
        setError(e?.message ?? "Failed to load event.");
      } finally {
        setLoading(false);
      }
    })();
  }, [eid]);

  // === RSVP (Attendee) =======================================================
  const [rsvp, setRsvp] = useState<RSVPStatus | null>(null);
  const [rsvpBusy, setRsvpBusy] = useState(false);

  const loadRsvp = useCallback(async () => {
    if (!eid) return;
    try {
      const userId = await getEffectiveUserId();
      const { data, error } = await supabase
        .from("event_members")
        .select("rsvp_status")
        .eq("event_id", eid)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      if (data?.rsvp_status) {
        const raw = String(data.rsvp_status);
        const mapped = raw === "going" ? "going" : raw === "not_going" ? "not_going" : null;
        setRsvp(mapped as RSVPStatus);
      } else setRsvp(null);
    } catch (e: any) {
      console.warn("[rsvp] load failed:", e?.message);
      setRsvp(null);
    }
  }, [eid]);

  useEffect(() => {
    loadRsvp();
  }, [loadRsvp]);

  const saveRsvp = useCallback(
    async (next: RSVPStatus) => {
      if (!eid) return;
      try {
        setRsvpBusy(true);
        setRsvp(next);
        const userId = await getEffectiveUserId();
        const { error } = await supabase.from("event_members").upsert(
          {
            event_id: eid,
            user_id: userId,
            rsvp_status: next,
            invite_source: "rsvp",
          },
          {
            onConflict: "event_id,user_id",
          }
        );
        if (error) throw error;
        Alert.alert("Saved", `RSVP: ${next ?? "—"}`);
      } catch (e: any) {
        Alert.alert("Failed to save RSVP", e?.message ?? "Unknown error");
        loadRsvp();
      } finally {
        setRsvpBusy(false);
      }
    },
    [eid, loadRsvp]
  );

  // === GPS check-in ==========================================================
  const [gpsBusy, setGpsBusy] = useState(false);
  const [lastCheckinAt, setLastCheckinAt] = useState<string | null>(null);

  const handleGpsCheckin = useCallback(async () => {
    if (!eventRow) return;

    try {
      setGpsBusy(true);
      const fg = await Location.getForegroundPermissionsAsync();
      if (fg.status !== "granted") {
        const ask = await Location.requestForegroundPermissionsAsync();
        if (ask.status !== "granted") {
          Alert.alert("Permission required", "Location permission is required.");
          setGpsBusy(false);
          return;
        }
      }

      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
        mayShowUserSettingsDialog: true,
      });

      const radiusM = eventRow.venue_radius_m ?? 100;
      const distM = haversineMeters(
        pos.coords.latitude,
        pos.coords.longitude,
        eventRow.venue_lat ?? 0,
        eventRow.venue_lng ?? 0
      );
      const accThresh = accuracyThreshold(radiusM);

      if ((pos.coords.accuracy ?? 9999) > accThresh) {
        Alert.alert(
          "Low accuracy",
          `Accuracy ${Math.round(pos.coords.accuracy ?? 0)}m > threshold ${Math.round(
            accThresh
          )}m. Move to open area and try again.`
        );
        setGpsBusy(false);
        return;
      }
      if (distM > radiusM) {
        Alert.alert("Outside gate", `Distance ${Math.round(distM)}m > radius ${radiusM}m.`);
        setGpsBusy(false);
        return;
      }

      const userId = await getEffectiveUserId();
      const { error } = await supabase.from("attendance").insert({
        event_id: eventRow.id,
        user_id: userId,
        method: "gps",
      });
      if (error) throw error;

      Alert.alert("Checked in", "GPS check-in recorded.");
      try {
        setLastCheckinAt(new Date().toISOString());
      } catch {}
      try {
        DeviceEventEmitter.emit("rta_attendance_changed", {
          event_id: eventRow.id,
        });
      } catch {}
    } catch (e: any) {
      const msg = e?.message ?? "GPS check-in failed.";
      Alert.alert("Failed", msg);
    } finally {
      setGpsBusy(false);
    }
  }, [eventRow]);

  // === DEV metrics panel =====================================================
  const [devAcc, setDevAcc] = useState<number | null>(null);
  const [devDist, setDevDist] = useState<number | null>(null);
  const [devInside, setDevInside] = useState<boolean | null>(null);
  const [devBusy, setDevBusy] = useState(false);

  const refreshMetrics = useCallback(async () => {
    if (!eventRow) return;
    try {
      setDevBusy(true);
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
        mayShowUserSettingsDialog: true,
      });
      const distM = haversineMeters(
        pos.coords.latitude,
        pos.coords.longitude,
        eventRow.venue_lat ?? 0,
        eventRow.venue_lng ?? 0
      );
      setDevAcc(pos.coords.accuracy ?? null);
      setDevDist(distM);
      setDevInside(distM <= (eventRow.venue_radius_m ?? 100));
    } catch (e: any) {
      Alert.alert("Failed", e?.message ?? "Unable to refresh metrics.");
    } finally {
      setDevBusy(false);
    }
  }, [eventRow]);

  // === Attendee auto-check (Organizer geofence) ==============================
  const [attendeeCheckStatus, setAttendeeCheckStatus] = useState<string>("—");
  const [attendeeStartBusy, setAttendeeStartBusy] = useState(false);
  const [attendeeStopBusy, setAttendeeStopBusy] = useState(false);

  const refreshAttendeeCheckStatus = useCallback(async () => {
    try {
      const { started } = await geofenceStatus();
      setAttendeeCheckStatus(started ? "Active" : "Inactive");
    } catch {
      setAttendeeCheckStatus("Unknown");
    }
  }, []);

  useEffect(() => {
    refreshAttendeeCheckStatus();
  }, [refreshAttendeeCheckStatus]);

  const handleStartAttendeeCheck = useCallback(async () => {
    if (!eventRow) return;

    const baseMeta = {
      route_id: eid,
      event_id: eventRow.id,
      role,
      platform: Platform.OS,
    };

    if (role !== "organizer") {
      console.info("[live] blocked: role", { role });
      await appendProofLog({
        at: safeIsoNow(),
        action: "start",
        decision: "blocked",
        reason: "role_not_organizer",
        event_id: eventRow.id,
        role,
        platform: Platform.OS,
        meta: baseMeta,
      });
      if (showDev) await refreshProofPreview();
      Alert.alert("Not allowed", "Only organizers can start attendee check.");
      return;
    }

    if (Platform.OS === "web") {
      console.info("[live] blocked: platform=web");
      await appendProofLog({
        at: safeIsoNow(),
        action: "start",
        decision: "blocked",
        reason: "platform_web",
        event_id: eventRow.id,
        role,
        platform: Platform.OS,
        meta: baseMeta,
      });
      if (showDev) await refreshProofPreview();
      Alert.alert("Not supported", "Live attendee check is not supported on web.");
      return;
    }

    const win = isNowWithinEventWindowUtc(eventRow);
    if (!win.ok) {
      console.info("[live] blocked: not_in_window", {
        nowMs: win.nowMs,
        startMs: win.startMs,
        endMs: win.endMs,
        start_utc: eventRow.start_utc,
        end_utc: eventRow.end_utc,
      });

      await appendProofLog({
        at: safeIsoNow(),
        action: "start",
        decision: "blocked",
        reason: "not_in_event_window",
        event_id: eventRow.id,
        role,
        platform: Platform.OS,
        meta: {
          ...baseMeta,
          nowMs: win.nowMs,
          startMs: win.startMs,
          endMs: win.endMs,
          start_utc: eventRow.start_utc,
          end_utc: eventRow.end_utc,
        },
      });
      if (showDev) await refreshProofPreview();

      const startText = eventRow.start_utc ? new Date(eventRow.start_utc).toUTCString() : "—";
      const endText = eventRow.end_utc ? new Date(eventRow.end_utc).toUTCString() : "—";
      Alert.alert(
        "Not in event time window",
        `Live attendee check can only start during the event.\n\nStart (UTC): ${startText}\nEnd (UTC): ${endText}`
      );
      return;
    }

    try {
      const accepted = await AsyncStorage.getItem(DISCLOSURE_KEY);
      if (accepted !== "accepted") {
        console.info("[live] blocked: disclosure_not_accepted");
        await appendProofLog({
          at: safeIsoNow(),
          action: "start",
          decision: "blocked",
          reason: "disclosure_not_accepted",
          event_id: eventRow.id,
          role,
          platform: Platform.OS,
          meta: baseMeta,
        });
        if (showDev) await refreshProofPreview();

        router.push({
          pathname: "/location-disclosure",
          params: { next: `/organize/events/${eventRow.id}` },
        } as any);
        return;
      }
    } catch (e: any) {
      await appendProofLog({
        at: safeIsoNow(),
        action: "start",
        decision: "error",
        reason: "disclosure_storage_error",
        event_id: eventRow.id,
        role,
        platform: Platform.OS,
        meta: { ...baseMeta, message: e?.message },
      });
      if (showDev) await refreshProofPreview();
    }

    try {
      setAttendeeStartBusy(true);

      let fg: Location.PermissionResponse | null = null;
      let bg: Location.PermissionResponse | null = null;

      try {
        fg = await Location.getForegroundPermissionsAsync();
      } catch (e: any) {
        console.info("[live] blocked: fg_perm_error", { message: e?.message });
        await appendProofLog({
          at: safeIsoNow(),
          action: "start",
          decision: "error",
          reason: "foreground_permission_read_failed",
          event_id: eventRow.id,
          role,
          platform: Platform.OS,
          meta: { ...baseMeta, message: e?.message },
        });
        if (showDev) await refreshProofPreview();
        Alert.alert("Permission check failed", "Unable to read location permission status.");
        return;
      }

      try {
        bg = await Location.getBackgroundPermissionsAsync();
      } catch (e: any) {
        console.info("[live] blocked: bg_perm_error", { message: e?.message });
        await appendProofLog({
          at: safeIsoNow(),
          action: "start",
          decision: "error",
          reason: "background_permission_read_failed",
          event_id: eventRow.id,
          role,
          platform: Platform.OS,
          meta: { ...baseMeta, message: e?.message },
        });
        if (showDev) await refreshProofPreview();
        Alert.alert("Permission check failed", "Unable to read background location permission status.");
        return;
      }

      const fgGranted = !!fg?.granted || fg?.status === "granted";
      const bgGranted = !!bg?.granted || bg?.status === "granted";

      if (!fgGranted || !bgGranted) {
        console.info("[live] blocked: permission", {
          fg: { status: fg?.status, granted: fg?.granted, canAskAgain: fg?.canAskAgain },
          bg: { status: bg?.status, granted: bg?.granted, canAskAgain: bg?.canAskAgain },
        });

        await appendProofLog({
          at: safeIsoNow(),
          action: "start",
          decision: "blocked",
          reason: "always_permission_missing",
          event_id: eventRow.id,
          role,
          platform: Platform.OS,
          meta: {
            ...baseMeta,
            fg: { status: fg?.status, granted: fg?.granted, canAskAgain: fg?.canAskAgain },
            bg: { status: bg?.status, granted: bg?.granted, canAskAgain: bg?.canAskAgain },
          },
        });
        if (showDev) await refreshProofPreview();

        Alert.alert(
          "Always location required",
          "Live attendee check requires Always / Background location permission. Please enable it in Settings.",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Open Settings",
              onPress: () => {
                openAppSettingsSafe();
              },
            },
          ]
        );
        return;
      }

      const lat = eventRow.venue_lat;
      const lng = eventRow.venue_lng;
      if (lat == null || lng == null) {
        console.info("[live] blocked: missing_location", { lat, lng });
        await appendProofLog({
          at: safeIsoNow(),
          action: "start",
          decision: "blocked",
          reason: "missing_event_location",
          event_id: eventRow.id,
          role,
          platform: Platform.OS,
          meta: { ...baseMeta, lat, lng },
        });
        if (showDev) await refreshProofPreview();

        Alert.alert("Missing location", "This event does not have a valid venue location.");
        return;
      }

      const radius = clampRadius(eventRow.venue_radius_m);

      await appendProofLog({
        at: safeIsoNow(),
        action: "start",
        decision: "allowed",
        reason: "all_guards_passed",
        event_id: eventRow.id,
        role,
        platform: Platform.OS,
        meta: { ...baseMeta, lat, lng, radius },
      });

      await armGeofenceAt({ latitude: lat, longitude: lng }, radius, {
        eventId: eventRow.id,
        notify: false,
      });

      await refreshAttendeeCheckStatus();

      await appendProofLog({
        at: safeIsoNow(),
        action: "start",
        decision: "started",
        reason: "geofence_started",
        event_id: eventRow.id,
        role,
        platform: Platform.OS,
        meta: { ...baseMeta, lat, lng, radius },
      });
      if (showDev) await refreshProofPreview();

      Alert.alert("Attendee check started", "This device will automatically log arrivals and exits.");
    } catch (e: any) {
      await appendProofLog({
        at: safeIsoNow(),
        action: "start",
        decision: "error",
        reason: "start_failed",
        event_id: eventRow?.id ?? null,
        role,
        platform: Platform.OS,
        meta: { ...baseMeta, message: e?.message },
      });
      if (showDev) await refreshProofPreview();
      Alert.alert("Failed to start", e?.message ?? "Unable to start attendee check.");
    } finally {
      setAttendeeStartBusy(false);
    }
  }, [eid, eventRow, refreshAttendeeCheckStatus, refreshProofPreview, role, showDev]);

  const handleStopAttendeeCheck = useCallback(async () => {
    const evId = eventRow?.id ?? null;

    if (role !== "organizer") {
      await appendProofLog({
        at: safeIsoNow(),
        action: "stop",
        decision: "blocked",
        reason: "role_not_organizer",
        event_id: evId,
        role,
        platform: Platform.OS,
        meta: { event_id: evId, role, platform: Platform.OS, route_id: eid },
      });
      if (showDev) await refreshProofPreview();
      Alert.alert("Not allowed", "Only organizers can stop attendee check.");
      return;
    }

    try {
      setAttendeeStopBusy(true);
      await disarmGeofence();
      await refreshAttendeeCheckStatus();

      await appendProofLog({
        at: safeIsoNow(),
        action: "stop",
        decision: "stopped",
        reason: "geofence_stopped",
        event_id: evId,
        role,
        platform: Platform.OS,
        meta: { event_id: evId, role, platform: Platform.OS, route_id: eid },
      });
      if (showDev) await refreshProofPreview();

      Alert.alert("Attendee check stopped");
    } catch (e: any) {
      await appendProofLog({
        at: safeIsoNow(),
        action: "stop",
        decision: "error",
        reason: "stop_failed",
        event_id: evId,
        role,
        platform: Platform.OS,
        meta: { event_id: evId, role, platform: Platform.OS, route_id: eid, message: e?.message },
      });
      if (showDev) await refreshProofPreview();

      Alert.alert("Failed to stop", e?.message ?? "Unable to stop attendee check.");
    } finally {
      setAttendeeStopBusy(false);
    }
  }, [eid, eventRow, refreshAttendeeCheckStatus, refreshProofPreview, role, showDev]);

  const handleShowAttendeeStatus = useCallback(async () => {
    await refreshAttendeeCheckStatus();

    try {
      const { started } = await geofenceStatus();
      await appendProofLog({
        at: safeIsoNow(),
        action: "status",
        decision: "allowed",
        reason: "status_checked",
        event_id: eventRow?.id ?? null,
        role,
        platform: Platform.OS,
        meta: { event_id: eventRow?.id ?? null, role, platform: Platform.OS, started },
      });
      if (showDev) await refreshProofPreview();
    } catch (e: any) {
      await appendProofLog({
        at: safeIsoNow(),
        action: "status",
        decision: "error",
        reason: "status_check_failed",
        event_id: eventRow?.id ?? null,
        role,
        platform: Platform.OS,
        meta: { event_id: eventRow?.id ?? null, role, platform: Platform.OS, message: e?.message },
      });
      if (showDev) await refreshProofPreview();
    }

    Alert.alert("Attendee check", attendeeCheckStatus);
  }, [attendeeCheckStatus, eventRow, refreshAttendeeCheckStatus, refreshProofPreview, role, showDev]);

  // === Delete event (Organizer) ==============================================
  const [deleteBusy, setDeleteBusy] = useState(false);

  const handleDeleteEvent = useCallback(() => {
    if (!eventRow) return;
    Alert.alert(
      "Delete event",
      "This will permanently delete this event. This action cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              setDeleteBusy(true);
              try {
                await disarmGeofence();
              } catch {}
              const { error } = await supabase.from("events").delete().eq("id", eventRow.id);
              if (error) throw error;
              try {
                Alert.alert("Deleted", "Event has been deleted.");
              } catch {}
              router.replace("/events");
            } catch (e: any) {
              Alert.alert("Delete failed", e?.message ?? "Unable to delete event.");
            } finally {
              setDeleteBusy(false);
            }
          },
        },
      ]
    );
  }, [eventRow]);

  if (!eid) {
    return (
      <View style={[styles.container, { justifyContent: "center", alignItems: "center" }]}>
        <Text>Invalid route: missing id.</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[styles.container, { justifyContent: "center", alignItems: "center" }]}>
        <ActivityIndicator />
        <Text style={styles.subtle}>Loading…</Text>
      </View>
    );
  }

  if (error || !eventRow) {
    return (
      <View style={[styles.container, { justifyContent: "center", alignItems: "center" }]}>
        <Text style={{ color: "crimson" }}>{error ?? "Event not found"}</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      <Text style={styles.h1}>{eventRow.title ?? "Event"}</Text>

      <View style={styles.card}>
        <Text style={styles.sectionLabel}>Event</Text>
        <Row label="Start (UTC)" value={String(eventRow.start_utc ?? "—")} />
        <Row label="End (UTC)" value={String(eventRow.end_utc ?? "—")} />
        <Row label="Location" value={String(eventRow.location_name ?? "—")} />
        <Row
          label="Center (lat,lng)"
          value={`${eventRow.venue_lat ?? 0}, ${eventRow.venue_lng ?? 0}`}
        />
        <Row label="Radius (m)" value={String(eventRow.venue_radius_m ?? 100)} />
      </View>

      {role === "attendee" ? (
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>RSVP</Text>
          <View style={styles.rsvpRow}>
            <TouchableOpacity
              style={[styles.rsvpChip, rsvp === "going" && styles.rsvpChipActive]}
              onPress={() => saveRsvp("going")}
              disabled={rsvpBusy}
            >
              <Text style={[styles.rsvpChipText, rsvp === "going" && styles.rsvpChipTextActive]}>
                Going
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.rsvpChip, rsvp === "not_going" && styles.rsvpChipActive]}
              onPress={() => saveRsvp("not_going")}
              disabled={rsvpBusy}
            >
              <Text
                style={[
                  styles.rsvpChipText,
                  rsvp === "not_going" && styles.rsvpChipTextActive,
                ]}
              >
                Not going
              </Text>
            </TouchableOpacity>
          </View>

          {showDev && Platform.OS !== "web" ? (
            <View style={styles.devPanel}>
              <Text style={styles.devTitle}>DEV — Metrics</Text>
              <Row label="Accuracy" value={devAcc == null ? "—" : `${Math.round(devAcc)}m`} />
              <Row
                label="Distance to venue"
                value={devDist == null ? "—" : `${Math.round(devDist)} m`}
              />
              <Row
                label="Inside radius?"
                value={devInside == null ? "—" : devInside ? "Yes (inside)" : "No (outside)"}
              />
              <TouchableOpacity
                style={[styles.btnOutline, devBusy && { opacity: 0.6 }]}
                onPress={refreshMetrics}
                disabled={devBusy}
              >
                <Text style={styles.btnOutlineText}>
                  {devBusy ? "Refreshing…" : "REFRESH METRICS"}
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}

          <View style={{ height: 10 }} />
          <TouchableOpacity style={[styles.btnOutline]} onPress={handleGpsCheckin} disabled={gpsBusy}>
            <Text style={styles.btnOutlineText}>{gpsBusy ? "Checking…" : "CHECK IN (GPS)"}</Text>
          </TouchableOpacity>

          {lastCheckinAt ? (
            <Text style={[styles.subtle, { textAlign: "center" }]}>
              LAST CHECK-IN: {new Date(lastCheckinAt).toLocaleString()}
            </Text>
          ) : null}

          <View style={{ height: 10 }} />
          <TouchableOpacity
            style={[styles.btnOutline]}
            onPress={() => router.push({ pathname: "/attend/scan" } as any)}
          >
            <Text style={styles.btnOutlineText}>OPEN SCANNER</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>Organizer</Text>

          <TouchableOpacity
            style={[styles.btnOutline, deleteBusy && { opacity: 0.6 }]}
            onPress={() =>
              router.push({
                pathname: "/organize/events/[id]/location",
                params: { id: eventRow.id },
              })
            }
            disabled={deleteBusy}
          >
            <Text style={styles.btnOutlineText}>EDIT LOCATION</Text>
          </TouchableOpacity>

          <View style={{ height: 10 }} />

          <Row label="Attendee check" value={attendeeCheckStatus} />
          <View style={{ height: 8 }} />
          <TouchableOpacity
            style={[styles.btnPrimary, (attendeeStartBusy || deleteBusy) && { opacity: 0.6 }]}
            onPress={handleStartAttendeeCheck}
            disabled={attendeeStartBusy || deleteBusy}
          >
            <Text style={styles.btnPrimaryText}>
              {attendeeStartBusy ? "Starting…" : "START ATTENDEE CHECK"}
            </Text>
          </TouchableOpacity>

          <View style={{ height: 8 }} />
          <TouchableOpacity
            style={[styles.btnOutline, (attendeeStopBusy || deleteBusy) && { opacity: 0.6 }]}
            onPress={handleStopAttendeeCheck}
            disabled={attendeeStopBusy || deleteBusy}
          >
            <Text style={styles.btnOutlineText}>
              {attendeeStopBusy ? "Stopping…" : "STOP ATTENDEE CHECK"}
            </Text>
          </TouchableOpacity>

          <View style={{ height: 8 }} />
          <TouchableOpacity
            style={[styles.btnOutline, deleteBusy && { opacity: 0.6 }]}
            onPress={handleShowAttendeeStatus}
            disabled={deleteBusy}
          >
            <Text style={styles.btnOutlineText}>CHECK STATUS</Text>
          </TouchableOpacity>

          {showDev ? (
            <View style={styles.proofPanel}>
              <Text style={styles.proofTitle}>PROOF LOG MARKER</Text>
              <Row label="Entries" value={String(proofCount)} />
              <Text style={styles.proofMono} numberOfLines={3}>
                {proofLastLine}
              </Text>

              <View style={{ height: 8 }} />
              <TouchableOpacity
                style={[styles.btnOutline]}
                onPress={showProofLog}
                disabled={deleteBusy}
              >
                <Text style={styles.btnOutlineText}>VIEW PROOF LOG</Text>
              </TouchableOpacity>

              <View style={{ height: 8 }} />
              <TouchableOpacity
                style={[styles.btnOutline]}
                onPress={handleClearProofLog}
                disabled={deleteBusy}
              >
                <Text style={styles.btnOutlineText}>CLEAR PROOF LOG</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          <View style={{ height: 16 }} />
          <TouchableOpacity
            style={[styles.btnPrimary, deleteBusy && { opacity: 0.6 }]}
            onPress={() =>
              router.push({
                pathname: "/organize/events/[id]/qr",
                params: { id: eventRow.id },
              })
            }
            disabled={deleteBusy}
          >
            <Text style={styles.btnPrimaryText}>SHOW EVENT QR</Text>
          </TouchableOpacity>

          <View style={{ height: 10 }} />
          <TouchableOpacity
            style={[styles.btnOutline, deleteBusy && { opacity: 0.6 }]}
            onPress={() =>
              router.push({
                pathname: "/organize/events/[id]/scan",
                params: { id: eventRow.id },
              } as any)
            }
            disabled={deleteBusy}
          >
            <Text style={styles.btnOutlineText}>SCAN (ORGANIZER)</Text>
          </TouchableOpacity>

          <View style={{ height: 10 }} />
          <TouchableOpacity
            style={[styles.btnOutline, deleteBusy && { opacity: 0.6 }]}
            onPress={() =>
              router.push({
                pathname: "/organize/events/[id]/live",
                params: { id: eventRow.id },
              } as any)
            }
            disabled={deleteBusy}
          >
            <Text style={styles.btnOutlineText}>LIVE (ORGANIZER)</Text>
          </TouchableOpacity>

          <View style={{ height: 10 }} />
          <TouchableOpacity
            style={[styles.btnOutline, deleteBusy && { opacity: 0.6 }]}
            onPress={() =>
              router.push({
                pathname: "/organize/events/[id]/checkin",
                params: { id: eventRow.id },
              })
            }
            disabled={deleteBusy}
          >
            <Text style={styles.btnOutlineText}>CHECK-IN LIST</Text>
          </TouchableOpacity>

          <View style={{ height: 10 }} />
          <TouchableOpacity
            style={[styles.btnOutline, deleteBusy && { opacity: 0.6 }]}
            onPress={() =>
              router.push({
                pathname: "/organize/events/[id]/invite",
                params: { id: eventRow.id },
              })
            }
            disabled={deleteBusy}
          >
            <Text style={styles.btnOutlineText}>INVITE</Text>
          </TouchableOpacity>

          <View style={{ height: 10 }} />
          <TouchableOpacity
            style={[styles.btnOutline, deleteBusy && { opacity: 0.6 }]}
            onPress={() =>
              router.push({
                pathname: "/organize/events/[id]/settings",
                params: { id: eventRow.id },
              })
            }
            disabled={deleteBusy}
          >
            <Text style={styles.btnOutlineText}>SETTINGS</Text>
          </TouchableOpacity>

          <View style={{ height: 16 }} />
          <TouchableOpacity
            style={[styles.btnDanger, deleteBusy && { opacity: 0.6 }]}
            onPress={handleDeleteEvent}
            disabled={deleteBusy}
          >
            <Text style={styles.btnDangerText}>
              {deleteBusy ? "DELETING…" : "DELETE EVENT"}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={{ height: 20 }} />
      <TouchableOpacity
        style={[styles.linkBtn]}
        onPress={() =>
          Linking.openURL(
            `https://www.google.com/maps/search/?api=1&query=${eventRow.venue_lat},${eventRow.venue_lng}`
          )
        }
      >
        <Text style={styles.linkBtnText}>OPEN IN GOOGLE MAPS</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff", paddingTop: 8 },
  scrollContent: {
    paddingBottom: 24,
  },
  h1: {
    fontSize: 24,
    fontWeight: "800",
    color: "#111",
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  subtle: { color: "#555", marginTop: 8 },
  card: {
    marginHorizontal: 16,
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: CARD_BORDER,
    padding: 12,
    marginBottom: 12,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
  },
  rowLabel: { color: "#374151", fontWeight: "600" },
  rowValue: { color: "#111827" },
  sectionLabel: {
    fontSize: 14,
    fontWeight: "700",
    color: "#111",
    marginTop: 6,
    marginBottom: 8,
  },
  devPanel: {
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: CARD_BORDER,
    paddingTop: 8,
  },
  devTitle: {
    fontSize: 12,
    color: "#6B7280",
    marginBottom: 6,
    fontWeight: "700",
  },
  btnPrimary: {
    backgroundColor: BLUE,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  btnPrimaryText: {
    color: "#fff",
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  btnOutline: {
    borderWidth: 1,
    borderColor: BLUE,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  btnOutlineText: {
    color: BLUE,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  btnDanger: {
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    backgroundColor: "#DC2626",
  },
  btnDangerText: {
    color: "#fff",
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  linkBtn: {
    marginHorizontal: 16,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    backgroundColor: "#111827",
  },
  linkBtnText: {
    color: "#fff",
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  rsvpRow: {
    flexDirection: "row",
    gap: 8,
  },
  rsvpChip: {
    borderWidth: 1,
    borderColor: BLUE,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 999,
    alignItems: "center",
  },
  rsvpChipActive: {
    backgroundColor: BLUE,
  },
  rsvpChipText: {
    fontWeight: "700",
    color: BLUE,
  },
  rsvpChipTextActive: {
    color: "#fff",
  },
  proofPanel: {
    marginTop: 10,
    borderTopWidth: 1,
    borderTopColor: CARD_BORDER,
    paddingTop: 10,
  },
  proofTitle: {
    fontSize: 12,
    color: "#6B7280",
    marginBottom: 6,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  proofMono: {
    color: "#111827",
    fontSize: 12,
    lineHeight: 16,
  },
});
