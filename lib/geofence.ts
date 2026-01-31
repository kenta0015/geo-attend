// lib/geofence.ts
// Geofencing task + server sync with offline queue (Step 6).
// Exports:
// - GEOFENCE_TASK
// - ensureLocationPermissions()
// - hasGeofencingStarted()
// - startGeofencing(regions)
// - stopGeofencing()
// - setActiveEventId(eventId)
// - setActiveEventMeta(meta)
//
// Behavior:
// - Background task listens ENTER/EXIT and posts to Supabase via RPC('geofence_log') or table insert fallback.
// - If post fails, pushes to offline queue and attempts a best-effort flush.
// - Active event context is persisted so the background task can attach event_id even after reload.
// - If active_event_end_utc is saved and is expired, active context is auto-cleared (best-effort stop).
// - If event_id cannot be resolved, the geofence event is ignored (never posts/queues null event_id).

import * as TaskManager from "expo-task-manager";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as Crypto from "expo-crypto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "./supabase";
import { enqueue, flushOnce, GeoEventPayload } from "./syncQueue";
import { notiAvailable } from "./safeNoti";

export const GEOFENCE_TASK = "rta-geofence";

const ACTIVE_EVENT_KEY = "@rta.active_event_id"; // legacy (kept for backward compatibility)
const ACTIVE_EVENT_META_KEY = "@rta.active_event_meta_v1";
const LAST_EVENT_KEY = "@rta.geo.last.v1";
const DEBOUNCE_SEC = 30;

// Enable per-ENTER/EXIT notifications for all builds (including production).
// Users will receive local notifications when entering/exiting geofence regions.
const GEOFENCE_DEBUG_NOTI = true;

type ActiveEventMeta = {
  event_id: string;
  active_event_end_utc: string | null; // ISO UTC (from DB) or null
  saved_at: string; // ISO
};

function safeIsoNow() {
  try {
    return new Date().toISOString();
  } catch {
    return String(Date.now());
  }
}

function parseUtcMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

async function safeStopGeofencingIfStarted() {
  try {
    const started = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false);
    if (started) await Location.stopGeofencingAsync(GEOFENCE_TASK).catch(() => {});
  } catch {}
}

/** Persist active event meta so the background task can attach event_id (+ optional strong auto-off). */
export async function setActiveEventMeta(
  meta: { eventId: string; endUtc: string | null } | null
) {
  if (!meta) {
    try {
      await AsyncStorage.removeItem(ACTIVE_EVENT_META_KEY);
    } catch {}
    try {
      await AsyncStorage.removeItem(ACTIVE_EVENT_KEY);
    } catch {}
    return;
  }

  const eventId = String(meta.eventId ?? "").trim();
  if (!eventId) {
    await setActiveEventMeta(null);
    return;
  }

  const payload: ActiveEventMeta = {
    event_id: eventId,
    active_event_end_utc: meta.endUtc ? String(meta.endUtc) : null,
    saved_at: safeIsoNow(),
  };

  try {
    await AsyncStorage.setItem(ACTIVE_EVENT_META_KEY, JSON.stringify(payload));
  } catch {}

  // Keep legacy key in sync (for older callers / fallbacks).
  try {
    await AsyncStorage.setItem(ACTIVE_EVENT_KEY, eventId);
  } catch {}
}

/** Persist active event id so the background task can attach it. (Legacy-compatible) */
export async function setActiveEventId(eventId: string | null) {
  const normalized = eventId ? String(eventId).trim() : "";
  if (!normalized) {
    await setActiveEventMeta(null);
    return;
  }

  // Preserve end_utc if already stored for the same event id.
  const existing = await getActiveEventMetaUnsafe();
  if (existing && existing.event_id === normalized && existing.active_event_end_utc) {
    // Ensure legacy key is still written.
    try {
      await AsyncStorage.setItem(ACTIVE_EVENT_KEY, normalized);
    } catch {}
    return;
  }

  await setActiveEventMeta({ eventId: normalized, endUtc: null });
}

async function getActiveEventMetaUnsafe(): Promise<ActiveEventMeta | null> {
  try {
    const raw = await AsyncStorage.getItem(ACTIVE_EVENT_META_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ActiveEventMeta;
    if (!parsed || typeof parsed !== "object") return null;
    const id = String((parsed as any).event_id ?? "").trim();
    if (!id) return null;

    const end = (parsed as any).active_event_end_utc;
    const savedAt = String((parsed as any).saved_at ?? safeIsoNow());
    return {
      event_id: id,
      active_event_end_utc: end == null ? null : String(end),
      saved_at: savedAt,
    };
  } catch {
    return null;
  }
}

async function getActiveEventId(): Promise<string | null> {
  // Prefer meta key; fall back to legacy key.
  const meta = await getActiveEventMetaUnsafe();

  if (meta) {
    const endMs = parseUtcMs(meta.active_event_end_utc);
    if (endMs != null && Date.now() > endMs) {
      // Strong auto-off: clear stale context and best-effort stop geofencing.
      await setActiveEventMeta(null);
      await safeStopGeofencingIfStarted();
      return null;
    }
    return meta.event_id;
  }

  try {
    const legacy = (await AsyncStorage.getItem(ACTIVE_EVENT_KEY)) || null;
    const id = legacy ? String(legacy).trim() : "";
    return id ? id : null;
  } catch {
    return null;
  }
}

/** Best-effort local notification (safe in background); ignore errors. */
async function notify(title: string, body: string) {
  try {
    // Check if notifications are available (not on web/Expo Go Android)
    if (!notiAvailable) {
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        console.log("[geofence] notifications not available (web/Expo Go)");
      }
      return;
    }

    // Check notification permissions (best-effort, don't block if check fails)
    try {
      const { status } = await Notifications.getPermissionsAsync();
      if (status !== "granted") {
        if (typeof __DEV__ !== "undefined" && __DEV__) {
          console.warn("[geofence] notification permission not granted:", status);
        }
        return;
      }
    } catch (permErr) {
      // Permission check failed, but continue anyway (might work)
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        console.warn("[geofence] permission check failed:", permErr);
      }
    }

    await Notifications.scheduleNotificationAsync({
      content: { title, body },
      trigger: null,
    });

    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.log("[geofence] notification sent:", title, body);
    }
  } catch (e: any) {
    // Log error for debugging (only in development)
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn("[geofence] notification failed:", e?.message ?? String(e));
    }
  }
}

function nowIso() {
  return new Date().toISOString();
}

async function shouldDebounce(dir: "ENTER" | "EXIT"): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(LAST_EVENT_KEY);
    const last = raw
      ? (JSON.parse(raw) as { dir: "ENTER" | "EXIT"; at: string })
      : null;
    const now = Date.now();
    if (last && last.dir === dir) {
      const dt = (now - Date.parse(last.at)) / 1000;
      if (dt < DEBOUNCE_SEC) return true;
    }
    await AsyncStorage.setItem(
      LAST_EVENT_KEY,
      JSON.stringify({ dir, at: new Date(now).toISOString() })
    );
    return false;
  } catch {
    return false;
  }
}

/** Create idempotency key stable within a 30s window. */
async function makeIdem(
  eventId: string,
  regionId: string | null,
  dir: "ENTER" | "EXIT",
  atIso: string
) {
  // Round down to 30s windows for natural idempotency across retries.
  const slot = Math.floor(Date.parse(atIso) / 1000 / DEBOUNCE_SEC);
  const base = `${eventId}|${regionId ?? "null"}|${dir}|${slot}`;
  return await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, base);
}

async function postToServer(p: GeoEventPayload): Promise<boolean> {
  try {
    // Prefer RPC if available (server will upsert by idem + update attendance/arrival_result)
    const resp = await supabase.rpc("geofence_log", {
      p_event_id: p.event_id,
      p_dir: p.dir,
      p_at: p.at,
      p_region: p.region_id ?? null,
      p_acc: p.acc_m ?? null,
      p_device: p.device ?? null,
      p_idem: p.idem,
    });
    if (resp.error) {
      // Fallback: raw insert to geofence_events (if table exists)
      const ins = await supabase.from("geofence_events").insert({
        event_id: p.event_id,
        dir: p.dir,
        at: p.at,
        region_id: p.region_id ?? null,
        acc_m: p.acc_m ?? null,
        device: p.device ?? null,
        idem: p.idem,
      });
      if (ins.error) throw ins.error;
    }
    return true;
  } catch {
    return false;
  }
}

// Define background task once
let __defined = false;
function defineTaskOnce() {
  if (__defined) return;
  try {
    TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
      if (error) {
        await notify("Geofence task error", String(error?.message ?? "Unknown error"));
        return;
      }

      const eventType = (data as any)?.eventType as Location.GeofencingEventType | undefined;
      const region = (data as any)?.region as Location.LocationRegion | undefined;

      const dir: "ENTER" | "EXIT" =
        eventType === Location.GeofencingEventType.Enter
          ? "ENTER"
          : eventType === Location.GeofencingEventType.Exit
          ? "EXIT"
          : "ENTER";

      if (await shouldDebounce(dir)) return;

      const at = nowIso();
      const regionId = (region?.identifier as string | undefined) ?? null;

      // Prefer persisted active event id; fallback to identifier parsing.
      let eventId = await getActiveEventId();
      if (!eventId && regionId && regionId.startsWith("event:")) {
        const parsed = regionId.slice("event:".length).trim();
        eventId = parsed ? parsed : null;
      }

      // Phase 2 guarantee: never post/queue null event_id.
      if (!eventId) return;

      const payload: GeoEventPayload = {
        event_id: eventId,
        dir,
        at,
        region_id: regionId,
        acc_m: null,
        device: "mobile",
        idem: await makeIdem(eventId, regionId, dir, at),
      };

      const ok = await postToServer(payload);
      if (!ok) {
        await enqueue(payload);
        await flushOnce(postToServer); // best-effort
      }

      // Local notification for ENTER/EXIT events (enabled for all builds).
      // Users will be notified when entering or exiting the geofence region.
      if (GEOFENCE_DEBUG_NOTI) {
        const shortEvent = eventId.slice(0, 8);
        const title = dir === "ENTER" ? "Geofence ENTER" : "Geofence EXIT";
        const bodyParts = [
          `event=${shortEvent}…`,
          regionId ? `region=${regionId}` : null,
        ].filter(Boolean);
        await notify(title, bodyParts.join(" • "));
      }
    });
    __defined = true;
  } catch {
    __defined = true; // already defined (HMR)
  }
}
defineTaskOnce();

// Public helpers

export async function ensureLocationPermissions(): Promise<{
  ok: boolean;
  status: Location.PermissionStatus;
  bg?: Location.PermissionStatus;
}> {
  const f = await Location.requestForegroundPermissionsAsync();
  if (f.status !== "granted") return { ok: false, status: f.status };

  let bg: Location.PermissionStatus | undefined;
  if (await Location.isBackgroundLocationAvailableAsync()) {
    const r = await Location.requestBackgroundPermissionsAsync();
    bg = r.status;
    if (r.status !== "granted") return { ok: false, status: f.status, bg: r.status };
  }
  return { ok: true, status: f.status, bg };
}

export async function hasGeofencingStarted(): Promise<boolean> {
  try {
    return await Location.hasStartedGeofencingAsync(GEOFENCE_TASK);
  } catch {
    return false;
  }
}

export type GeofenceRegion = {
  identifier?: string;
  latitude: number;
  longitude: number;
  radius: number; // meters
  notifyOnEnter?: boolean;
  notifyOnExit?: boolean;
};

export async function startGeofencing(regions: GeofenceRegion[]): Promise<void> {
  const p = await ensureLocationPermissions();
  if (!p.ok) throw new Error("Location permission not granted");
  try {
    const started = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false);
    if (started) await Location.stopGeofencingAsync(GEOFENCE_TASK).catch(() => {});
    await Location.startGeofencingAsync(GEOFENCE_TASK, regions as any);
    // trigger early flush attempt
    await flushOnce(postToServer);
  } catch (e: any) {
    throw new Error(e?.message ?? "Failed to start geofencing.");
  }
}

export async function stopGeofencing(): Promise<void> {
  try {
    const started = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false);
    if (started) await Location.stopGeofencingAsync(GEOFENCE_TASK);
  } catch {}
}
