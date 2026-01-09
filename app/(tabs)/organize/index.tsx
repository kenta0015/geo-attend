import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  Platform,
  Alert,
  ScrollView,
  ActivityIndicator,
  ToastAndroid,
  Linking,
  RefreshControl,
  Modal,
  Pressable,
} from "react-native";
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import * as Location from "expo-location";
import { useRouter, useLocalSearchParams } from "expo-router";
import { supabase } from "../../../lib/supabase";
import { getGuestId } from "../../../stores/session";
import { useEffectiveRole, type Role } from "../../../stores/devRole";
import { runCreateLocationSafetyCheck, type CreateSafetyDecision } from "./organizeSafety";
import { styles } from "./styles";

type GroupRow = { id: string; name: string | null; description?: string | null };
type MembershipRow = { group_id: string };

type EventRow = {
  id: string;
  title: string | null;
  start_utc: string | null;
  end_utc: string | null;
  lat: number | null;
  lng: number | null;
  radius_m: number | null;
  window_minutes: number | null;
  location_name: string | null;
  address_text: string | null;
  group_id: string | null;
};

type PlaceCandidate = {
  id: string;
  title: string;
  subtitle: string;
  lat: number;
  lng: number;
};

type FieldKey = "group" | "title" | "start" | "end" | "address" | "coords" | "radius" | "window";
type FormErrors = Partial<Record<FieldKey, string>>;

const FIELD_ORDER: FieldKey[] = ["group", "title", "start", "end", "address", "coords", "radius", "window"];

const DEFAULT_DURATION_MINUTES = 60;

const MELBOURNE_CBD = { lat: -37.8136, lng: 144.9631 };
const MAX_PLACE_RESULTS = 10;
const DEDUPE_RADIUS_M = 100;

const nowIso = () => new Date().toISOString();
const plusHoursIso = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

const PLACE_LOG_PREFIX = "[organize][place]";

const AU_STATE_CODES = ["VIC", "NSW", "QLD", "SA", "WA", "TAS", "ACT", "NT"] as const;
const AU_STATE_REGEX = new RegExp(`\\b(?:${AU_STATE_CODES.join("|")})\\b`, "i");
const AU_POSTCODE_REGEX = /\b\d{4}\b/g;

const RADIUS_PRESETS_M = [50, 100, 200, 300] as const;
const RADIUS_MIN_M = 10;
const RADIUS_MAX_M = 1000;

async function getEffectiveUserId(): Promise<string> {
  try {
    const { data } = await supabase.auth.getUser();
    if (data?.user?.id) return data.user.id;
  } catch {
    // ignore
  }
  const guest = await getGuestId();
  return guest;
}

function safeParseIso(isoUtc: string): Date {
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return new Date();
  return d;
}

function setLocalDateKeepTime(base: Date, newDate: Date): Date {
  return new Date(
    newDate.getFullYear(),
    newDate.getMonth(),
    newDate.getDate(),
    base.getHours(),
    base.getMinutes(),
    0,
    0
  );
}

function setLocalTimeKeepDate(base: Date, newTime: Date): Date {
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    newTime.getHours(),
    newTime.getMinutes(),
    0,
    0
  );
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function buildEndLocalOrNull(startLocal: Date, minutes: number): Date | null {
  const endLocal = new Date(startLocal.getTime() + minutes * 60_000);
  if (!isSameLocalDay(startLocal, endLocal)) return null;
  return endLocal;
}

function isValidLatLngRange(lat: number, lng: number): boolean {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function distanceMetersHaversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);

  const sin1 = Math.sin(dLat / 2);
  const sin2 = Math.sin(dLng / 2);
  const h = sin1 * sin1 + Math.cos(lat1) * Math.cos(lat2) * sin2 * sin2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function buildGoogleMapsSearchUrl(query: string): string {
  const q = query.trim();
  if (!q) return "https://www.google.com/maps";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

function analyzeAddressSpecificityAU(address: string): { ok: boolean; missing: string[] } {
  const a = address.trim();
  const missing: string[] = [];

  const postcodeMatch = a.match(AU_POSTCODE_REGEX);
  const postcode = postcodeMatch ? postcodeMatch[0] : null;
  const hasPostcode = !!postcode;

  const hasState = AU_STATE_REGEX.test(a);

  const head = a.slice(0, 32);
  const nums = Array.from(head.matchAll(/\d{1,6}/g)).map((m) => m[0]);
  const nonPostcodeNums = nums.filter((n) => (!postcode ? true : n !== postcode));
  const streetCandidate = nonPostcodeNums.length > 0 ? nonPostcodeNums[nonPostcodeNums.length - 1] : null;
  const hasStreetNumber = !!streetCandidate;

  if (!hasStreetNumber) missing.push("street number (e.g., 211)");
  if (!hasState) missing.push(`state code (${AU_STATE_CODES.join("/")})`);
  if (!hasPostcode) missing.push("4-digit postcode (e.g., 3000)");

  return { ok: missing.length === 0, missing };
}

function buildFullAddressAlertBody(missing: string[]): string {
  const lines = missing.map((m) => `• Missing: ${m}`);
  lines.push("");
  lines.push("Open Google Maps → select the place → Share → Copy address → paste it here.");
  lines.push("");
  lines.push("Example: 211 La Trobe St, Melbourne VIC 3000");
  return lines.join("\n");
}

export default function OrganizeIndexScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ gid?: string }>();
  const passedGid = typeof params.gid === "string" ? params.gid : undefined;

  const role: Role = useEffectiveRole();

  const scrollRef = useRef<ScrollView | null>(null);
  const createInFlightRef = useRef(false);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState<string>("");
  const [groupId, setGroupId] = useState<string | null>(null);
  const [startUtc, setStartUtc] = useState<string>(nowIso());
  const [endUtc, setEndUtc] = useState<string>(plusHoursIso(1));
  const [showAdvancedTime, setShowAdvancedTime] = useState(false);
  const [lat, setLat] = useState<string>("");
  const [lng, setLng] = useState<string>("");
  const [coordsManual, setCoordsManual] = useState(false);
  const [coordsAddressSnapshot, setCoordsAddressSnapshot] = useState<string | null>(null);
  const [venueName, setVenueName] = useState<string>("");
  const [addressText, setAddressText] = useState<string>("");
  const [radiusM, setRadiusM] = useState<string>("100");
  const [windowMin, setWindowMin] = useState<string>("30");
  const [submitting, setSubmitting] = useState(false);

  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [createCardY, setCreateCardY] = useState(0);
  const [fieldY, setFieldY] = useState<Partial<Record<FieldKey, number>>>({});

  const [addrGeocoding, setAddrGeocoding] = useState(false);

  const [placeQuery, setPlaceQuery] = useState<string>("");
  const [placeResults, setPlaceResults] = useState<PlaceCandidate[]>([]);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [placeSearched, setPlaceSearched] = useState(false);
  const [placeSearching, setPlaceSearching] = useState(false);
  const [showAdvancedLocation, setShowAdvancedLocation] = useState(false);
  const [showPlaceSearch, setShowPlaceSearch] = useState(false);

  const [manageOpen, setManageOpen] = useState(false);

  const [startPickerOpen, setStartPickerOpen] = useState(false);
  const [startPickerStep, setStartPickerStep] = useState<"date" | "time">("date");
  const [tempStartLocal, setTempStartLocal] = useState<Date>(() => safeParseIso(nowIso()));

  const [howToOpen, setHowToOpen] = useState(false);
  const openHowTo = useCallback(() => setHowToOpen(true), []);
  const closeHowTo = useCallback(() => setHowToOpen(false), []);

  const notify = (msg: string) => {
    if (Platform.OS === "android") ToastAndroid.show(msg, ToastAndroid.SHORT);
    else Alert.alert("Info", msg);
  };

  const clearFieldError = useCallback((key: FieldKey) => {
    setFormErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const registerFieldY = useCallback((key: FieldKey) => {
    return (e: any) => {
      const y = e?.nativeEvent?.layout?.y;
      if (typeof y !== "number") return;
      setFieldY((prev) => (prev[key] === y ? prev : { ...prev, [key]: y }));
    };
  }, []);

  const scrollToField = useCallback(
    (key: FieldKey) => {
      const within = fieldY[key];
      if (typeof within !== "number") return;
      const y = Math.max(0, createCardY + within - 12);
      scrollRef.current?.scrollTo({ y, animated: true });
    },
    [createCardY, fieldY]
  );

  const setErrorsAndScroll = useCallback(
    (errs: FormErrors) => {
      setFormErrors(errs);
      const first = FIELD_ORDER.find((k) => !!errs[k]);
      if (first) scrollToField(first);
    },
    [scrollToField]
  );

  const setFieldErrorAndScroll = useCallback(
    (key: FieldKey, msg: string) => {
      setFormErrors((prev) => ({ ...prev, [key]: msg }));
      scrollToField(key);
    },
    [scrollToField]
  );

  const renderFieldError = useCallback(
    (key: FieldKey) => {
      const msg = formErrors[key];
      if (!msg) return null;
      return <Text style={styles.inlineErrorText}>{msg}</Text>;
    },
    [formErrors]
  );

  const formatLocalDateTime = (isoUtc: string): string | null => {
    if (!isoUtc) return null;
    const d = new Date(isoUtc);
    if (Number.isNaN(d.getTime())) return null;

    try {
      return d.toLocaleString(undefined, {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return d.toString();
    }
  };

  const startLocalDisplay = useMemo(() => formatLocalDateTime(startUtc), [startUtc]);
  const endLocalDisplay = useMemo(() => formatLocalDateTime(endUtc), [endUtc]);

  const tempStartPreview = useMemo(() => {
    try {
      return tempStartLocal.toLocaleString(undefined, {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return tempStartLocal.toString();
    }
  }, [tempStartLocal]);

  const fetchEventsForGroup = useCallback(async (gid: string | null) => {
    try {
      if (!gid) {
        setEvents([]);
        return;
      }

      const ev = await supabase
        .from("events")
        .select("id, title, start_utc, end_utc, lat, lng, radius_m, window_minutes, location_name, address_text, group_id")
        .eq("group_id", gid)
        .order("start_utc", { ascending: false })
        .limit(20);

      if (ev.error) throw ev.error;
      setEvents(ev.data ?? []);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load events");
      setEvents([]);
    }
  }, []);

  const fetchBootstrap = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const uid = await getEffectiveUserId();

      const memQuery = supabase.from("group_members").select("group_id").eq("user_id", uid);

      const memRes = role === "organizer" ? await memQuery.eq("role", "organizer") : await memQuery;

      if (memRes.error) throw memRes.error;

      const groupIds = ((memRes.data ?? []) as MembershipRow[]).map((m) => m.group_id);
      if (groupIds.length === 0) {
        setGroups([]);
        setEvents([]);
        setGroupId(null);
        return;
      }

      const grRes = await supabase
        .from("groups")
        .select("id, name, description")
        .in("id", groupIds)
        .order("created_at", { ascending: false });

      if (grRes.error) throw grRes.error;

      const list = (grRes.data ?? []) as GroupRow[];
      setGroups(list);

      const first = passedGid ?? list[0]?.id ?? null;
      setGroupId(first);

      await fetchEventsForGroup(first);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load groups");
      setGroups([]);
      setEvents([]);
      setGroupId(null);
    } finally {
      setLoading(false);
    }
  }, [fetchEventsForGroup, passedGid, role]);

  useEffect(() => {
    fetchBootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchBootstrap();
    } finally {
      setRefreshing(false);
    }
  }, [fetchBootstrap]);

  const useLocalNow = useCallback(() => {
    const startLocal = new Date();
    const endLocal = buildEndLocalOrNull(startLocal, DEFAULT_DURATION_MINUTES);
    if (!endLocal) {
      Alert.alert(
        "Same-day only",
        `Start + ${DEFAULT_DURATION_MINUTES} minutes must stay within the same day. Please choose a different start time.`
      );
      return;
    }

    setStartUtc(startLocal.toISOString());
    setEndUtc(endLocal.toISOString());
    notify("Filled start/end from local now (stored as UTC ISO).");
  }, []);

  const runPlaceSearchForward = useCallback(async () => {
    const startedAt = Date.now();
    const q = placeQuery.trim();

    console.log(`${PLACE_LOG_PREFIX} search start`, {
      q,
      qLen: q.length,
      ts: new Date().toISOString(),
      maxResults: MAX_PLACE_RESULTS,
      dedupeRadiusM: DEDUPE_RADIUS_M,
      melbourneCbd: MELBOURNE_CBD,
    });

    setPlaceError(null);
    setPlaceSearched(false);
    setPlaceResults([]);

    if (q.length < 2) {
      console.log(`${PLACE_LOG_PREFIX} blocked: query too short`, { q, qLen: q.length });
      setPlaceError("Please type at least 2 characters to search.");
      setPlaceSearched(true);
      return;
    }

    setPlaceSearching(true);
    try {
      const raw = await Location.geocodeAsync(q);

      console.log(`${PLACE_LOG_PREFIX} geocode raw returned`, {
        rawCount: raw?.length ?? 0,
        sample: (raw ?? []).slice(0, 5).map((r) => ({
          latitude: (r as any)?.latitude,
          longitude: (r as any)?.longitude,
        })),
      });

      const valid = (raw ?? [])
        .map((r, idx) => {
          const latN = typeof (r as any).latitude === "number" ? (r as any).latitude : Number((r as any).latitude);
          const lngN = typeof (r as any).longitude === "number" ? (r as any).longitude : Number((r as any).longitude);
          if (Number.isNaN(latN) || Number.isNaN(lngN)) return null;
          if (!isValidLatLngRange(latN, lngN)) return null;

          const distToCbdM = distanceMetersHaversine(MELBOURNE_CBD.lat, MELBOURNE_CBD.lng, latN, lngN);

          return {
            _idx: idx,
            lat: latN,
            lng: lngN,
            distToCbdM,
          };
        })
        .filter((x): x is { _idx: number; lat: number; lng: number; distToCbdM: number } => !!x);

    console.log(`${PLACE_LOG_PREFIX} valid coords`, {
      validCount: valid.length,
      invalidCount: (raw?.length ?? 0) - valid.length,
      sample: valid.slice(0, 8).map((v) => ({
        idx: v._idx,
        lat: Number(v.lat.toFixed(6)),
        lng: Number(v.lng.toFixed(6)),
        distToCbdM: Math.round(v.distToCbdM),
      })),
    });

      valid.sort((a, b) => a.distToCbdM - b.distToCbdM);

      console.log(`${PLACE_LOG_PREFIX} sorted by CBD distance`, {
        top: valid.slice(0, 8).map((v) => ({
          lat: Number(v.lat.toFixed(6)),
          lng: Number(v.lng.toFixed(6)),
          distToCbdM: Math.round(v.distToCbdM),
        })),
      });

      const deduped: { lat: number; lng: number; distToCbdM: number }[] = [];
      let collapsedByDedupe = 0;

      for (const r of valid) {
        const tooClose = deduped.some((k) => distanceMetersHaversine(k.lat, k.lng, r.lat, r.lng) <= DEDUPE_RADIUS_M);
        if (!tooClose) deduped.push(r);
        else collapsedByDedupe += 1;

        if (deduped.length >= MAX_PLACE_RESULTS) break;
      }

      console.log(`${PLACE_LOG_PREFIX} dedupe summary`, {
        inputCount: valid.length,
        outputCount: deduped.length,
        collapsedByDedupe,
        outputSample: deduped.slice(0, 8).map((v) => ({
          lat: Number(v.lat.toFixed(6)),
          lng: Number(v.lng.toFixed(6)),
          distToCbdM: Math.round(v.distToCbdM),
        })),
      });

      const candidates: PlaceCandidate[] = deduped.slice(0, MAX_PLACE_RESULTS).map((r, i) => ({
        id: `geo-${i}-${r.lat.toFixed(6)}-${r.lng.toFixed(6)}`,
        title: q,
        subtitle: `${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}`,
        lat: r.lat,
        lng: r.lng,
      }));

      console.log(`${PLACE_LOG_PREFIX} final candidates`, {
        candidatesCount: candidates.length,
        first: candidates[0]
          ? {
              id: candidates[0].id,
              title: candidates[0].title,
              subtitle: candidates[0].subtitle,
            }
          : null,
        elapsedMs: Date.now() - startedAt,
      });

      setPlaceSearched(true);

      if (candidates.length === 0) {
        setPlaceError("No results. Try a more specific keyword (e.g., suburb or street).");
        setPlaceResults([]);
        return;
      }

      setPlaceError(null);
      setPlaceResults(candidates);
    } catch (e: any) {
      console.log(`${PLACE_LOG_PREFIX} search error`, {
        message: e?.message ?? String(e),
        name: e?.name,
        stack: e?.stack,
        elapsedMs: Date.now() - startedAt,
      });
      setPlaceSearched(true);
      setPlaceResults([]);
      setPlaceError(e?.message ?? "Search failed. Please try again.");
    } finally {
      console.log(`${PLACE_LOG_PREFIX} search end`, { elapsedMs: Date.now() - startedAt });
      setPlaceSearching(false);
    }
  }, [placeQuery]);

  const selectPlace = useCallback(
    (p: PlaceCandidate) => {
      console.log(`${PLACE_LOG_PREFIX} select candidate`, {
        id: p.id,
        title: p.title,
        subtitle: p.subtitle,
        lat: p.lat,
        lng: p.lng,
      });

      if (!isValidLatLngRange(p.lat, p.lng)) {
        Alert.alert("Invalid location", "Selected location has invalid coordinates.");
        return;
      }

      setLat(String(p.lat));
      setLng(String(p.lng));
      setCoordsManual(false);
      setCoordsAddressSnapshot(null);
      if (formErrors.coords) clearFieldError("coords");
      setSubmitError(null);

      if (!venueName.trim()) setVenueName(p.title);
      setPlaceError(null);
      notify("Coordinates set from quick search. Please paste the full address from Google Maps into Venue address.");
    },
    [clearFieldError, formErrors.coords, venueName]
  );

  const openManageGroups = useCallback(() => setManageOpen(true), []);
  const closeManageGroups = useCallback(() => setManageOpen(false), []);

  const openGroup = useCallback(
    (gid: string) => {
      closeManageGroups();
      router.push({ pathname: "/organize/admin", params: { gid } });
    },
    [closeManageGroups, router]
  );

  const validateIso = (s: string) => {
    const d = new Date(s);
    return !Number.isNaN(d.getTime()) && s.includes("T") && s.endsWith("Z");
  };

  const closeStartPicker = useCallback(() => {
    setStartPickerOpen(false);
    setStartPickerStep("date");
  }, []);

  const openStartPickerIOS = useCallback(() => {
    setTempStartLocal(safeParseIso(startUtc));
    setStartPickerStep("date");
    setStartPickerOpen(true);
  }, [startUtc]);

  const commitStartPickerIOS = useCallback(() => {
    const endLocal = buildEndLocalOrNull(tempStartLocal, DEFAULT_DURATION_MINUTES);
    if (!endLocal) {
      Alert.alert(
        "Same-day only",
        `Start + ${DEFAULT_DURATION_MINUTES} minutes must stay within the same day. Please choose a different start time.`
      );
      return;
    }

    setStartUtc(tempStartLocal.toISOString());
    setEndUtc(endLocal.toISOString());

    if (formErrors.start) clearFieldError("start");
    if (formErrors.end) clearFieldError("end");
    setSubmitError(null);

    notify("Start updated (End auto-set to +60 minutes).");
    closeStartPicker();
  }, [clearFieldError, closeStartPicker, formErrors.end, formErrors.start, tempStartLocal]);

  const openStartPickerAndroid = useCallback(() => {
    const initial = safeParseIso(startUtc);

    DateTimePickerAndroid.open({
      value: initial,
      mode: "date",
      is24Hour: true,
      onChange: (event, selectedDate) => {
        if (event?.type !== "set" || !selectedDate) return;

        const baseAfterDate = setLocalDateKeepTime(initial, selectedDate);

        DateTimePickerAndroid.open({
          value: baseAfterDate,
          mode: "time",
          is24Hour: true,
          onChange: (event2, selectedTime) => {
            if (event2?.type !== "set" || !selectedTime) return;

            const finalLocal = setLocalTimeKeepDate(baseAfterDate, selectedTime);
            const endLocal = buildEndLocalOrNull(finalLocal, DEFAULT_DURATION_MINUTES);

            if (!endLocal) {
              Alert.alert(
                "Same-day only",
                `Start + ${DEFAULT_DURATION_MINUTES} minutes must stay within the same day. Please choose a different start time.`
              );
              return;
            }

            setStartUtc(finalLocal.toISOString());
            setEndUtc(endLocal.toISOString());

            if (formErrors.start) clearFieldError("start");
            if (formErrors.end) clearFieldError("end");
            setSubmitError(null);

            notify("Start updated (End auto-set to +60 minutes).");
          },
        });
      },
    });
  }, [clearFieldError, formErrors.end, formErrors.start, startUtc]);

  const openStartPicker = useCallback(() => {
    if (Platform.OS === "android") openStartPickerAndroid();
    else openStartPickerIOS();
  }, [openStartPickerAndroid, openStartPickerIOS]);

  const openWebUrl = useCallback(async (url: string) => {
    try {
      const ok = await Linking.canOpenURL(url);
      if (!ok) throw new Error("Cannot open URL");
      await Linking.openURL(url);
    } catch (e: any) {
      Alert.alert("Open link failed", e?.message ?? "Failed to open link");
    }
  }, []);

  const openGoogleMapsSearch = useCallback(
    async (query: string) => {
      const url = buildGoogleMapsSearchUrl(query);
      await openWebUrl(url);
    },
    [openWebUrl]
  );

  const confirmProceedWithSafetyWarning = useCallback(
    async (titleText: string, messageText: string, mapsQuery: string): Promise<boolean> => {
      return await new Promise<boolean>((resolve) => {
        Alert.alert(
          titleText,
          messageText,
          [
            { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
            {
              text: "OPEN MAPS",
              onPress: () => {
                void openGoogleMapsSearch(mapsQuery || "Australia");
                resolve(false);
              },
            },
            { text: "Continue", style: "default", onPress: () => resolve(true) },
          ],
          { cancelable: true, onDismiss: () => resolve(false) }
        );
      });
    },
    [openGoogleMapsSearch]
  );

  const showSafetyBlockAlert = useCallback(
    (titleText: string, messageText: string, mapsQuery: string) => {
      Alert.alert(
        titleText,
        messageText,
        [
          {
            text: "OPEN MAPS",
            onPress: () => {
              void openGoogleMapsSearch(mapsQuery || "Australia");
            },
          },
          { text: "OK", style: "default" },
        ],
        { cancelable: true }
      );
    },
    [openGoogleMapsSearch]
  );

  const setCoordsFromAddress = useCallback(async () => {
    setSubmitError(null);

    const addr = addressText.trim();
    if (!addr) {
      setFieldErrorAndScroll("address", "Venue address is required to set coordinates.");
      return;
    }

    const spec = analyzeAddressSpecificityAU(addr);
    if (!spec.ok) {
      Alert.alert("Please paste a full address from Google Maps", buildFullAddressAlertBody(spec.missing));
      setFormErrors((prev) => ({
        ...prev,
        address: `Please paste a full address from Google Maps. Missing: ${spec.missing.join(", ")}.`,
        coords: "Coordinates will not be derived from a vague address. Paste a full address or enter lat/lng in Advanced.",
      }));
      scrollToField("address");
      return;
    }

    setAddrGeocoding(true);
    try {
      const raw = await Location.geocodeAsync(addr);
      const first = raw?.[0];

      const latN = first ? Number((first as any).latitude) : NaN;
      const lngN = first ? Number((first as any).longitude) : NaN;

      if (!Number.isFinite(latN) || !Number.isFinite(lngN) || !isValidLatLngRange(latN, lngN)) {
        setFormErrors((prev) => ({
          ...prev,
          address: "Could not find coordinates from this address. Paste the full address from Google Maps.",
          coords: "Coordinates not set yet. Tap 'Set coords from address' again after pasting the full address.",
        }));
        scrollToField("address");
        return;
      }

      setLat(String(latN));
      setLng(String(lngN));
      setCoordsManual(false);
      setCoordsAddressSnapshot(addr);

      if (formErrors.address) clearFieldError("address");
      if (formErrors.coords) clearFieldError("coords");
      setSubmitError(null);
      notify("Coordinates set from address. Use OPEN MAPS to verify.");
    } catch (e: any) {
      setFormErrors((prev) => ({
        ...prev,
        address: e?.message ?? "Failed to set coordinates from address. Try pasting the full Google Maps address.",
      }));
      scrollToField("address");
    } finally {
      setAddrGeocoding(false);
    }
  }, [addressText, clearFieldError, formErrors.address, formErrors.coords, scrollToField, setFieldErrorAndScroll]);

  const createEvent = useCallback(async () => {
    if (createInFlightRef.current) return;
    if (submitting) return;

    setSubmitError(null);

    const errs: FormErrors = {};
    let addressSpecificityMissing: string[] | null = null;

    if (!groupId) errs.group = "Please select a group.";

    const eventTitle = title.trim();
    if (!eventTitle) errs.title = "Title is required.";

    const startTrim = startUtc.trim();
    const endTrim = endUtc.trim();

    if (!startTrim) errs.start = "Start is required.";
    if (!endTrim) errs.end = "End is required.";

    if (startTrim && !validateIso(startTrim)) errs.start = "Start must be a valid UTC ISO string ending in Z.";
    if (endTrim && !validateIso(endTrim)) errs.end = "End must be a valid UTC ISO string ending in Z.";

    if (startTrim && validateIso(startTrim)) {
      const startLocal = safeParseIso(startTrim);
      const expectedEndLocal = buildEndLocalOrNull(startLocal, DEFAULT_DURATION_MINUTES);
      if (!expectedEndLocal) {
        errs.start = `Start + ${DEFAULT_DURATION_MINUTES} minutes must stay within the same day.`;
      }
    }

    const address = addressText.trim();
    if (!address) errs.address = "Venue address is required.";

    if (address && !coordsManual) {
      const spec = analyzeAddressSpecificityAU(address);
      if (!spec.ok) {
        addressSpecificityMissing = spec.missing;
        errs.address = `Please paste a full address from Google Maps. Missing: ${spec.missing.join(", ")}.`;
        errs.coords = "Coordinates will not be derived from a vague address. Paste a full address or enter lat/lng in Advanced.";
      }
    }

    const rTrim = radiusM.trim();
    const wTrim = windowMin.trim();

    if (!rTrim) errs.radius = "Radius is required.";
    if (!wTrim) errs.window = "Window is required.";

    const r = Number(rTrim);
    if (rTrim && !Number.isFinite(r)) errs.radius = "Radius must be a number.";
    if (rTrim && Number.isFinite(r) && (r < RADIUS_MIN_M || r > RADIUS_MAX_M)) {
      errs.radius = `Radius must be between ${RADIUS_MIN_M} and ${RADIUS_MAX_M} meters.`;
    }

    const w = Number(wTrim);
    if (wTrim && (!Number.isFinite(w) || w < 0)) errs.window = "Window must be 0 or more.";

    if (Object.keys(errs).length > 0) {
      if (addressSpecificityMissing) {
        Alert.alert("Please paste a full address from Google Maps", buildFullAddressAlertBody(addressSpecificityMissing));
      }
      setErrorsAndScroll(errs);
      return;
    }

    createInFlightRef.current = true;
    setSubmitting(true);

    const latTrim = lat.trim();
    const lngTrim = lng.trim();

    const parsedLat = Number(latTrim);
    const parsedLng = Number(lngTrim);
    const existingCoordsValid =
      !!latTrim &&
      !!lngTrim &&
      Number.isFinite(parsedLat) &&
      Number.isFinite(parsedLng) &&
      isValidLatLngRange(parsedLat, parsedLng);

    try {
      let finalLatN: number | null = null;
      let finalLngN: number | null = null;

      let geocodeRawForSafety: Location.LocationGeocodedLocation[] | null = null;

      if (coordsManual) {
        if (!existingCoordsValid) {
          setErrorsAndScroll({
            coords: "Coordinates must be valid lat (-90..90) and lng (-180..180).",
          });
          return;
        }
        finalLatN = parsedLat;
        finalLngN = parsedLng;
      } else {
        const canReuse =
          existingCoordsValid && typeof coordsAddressSnapshot === "string" && coordsAddressSnapshot.trim() === address;

        if (canReuse) {
          finalLatN = parsedLat;
          finalLngN = parsedLng;
        } else {
          setAddrGeocoding(true);
          try {
            const raw = await Location.geocodeAsync(address);
            geocodeRawForSafety = raw ?? null;

            const first = raw?.[0];

            const latN = first ? Number((first as any).latitude) : NaN;
            const lngN = first ? Number((first as any).longitude) : NaN;

            if (!Number.isFinite(latN) || !Number.isFinite(lngN) || !isValidLatLngRange(latN, lngN)) {
              setFormErrors((prev) => ({
                ...prev,
                address:
                  "Could not find coordinates from this address. Paste the full address from Google Maps (include street number, suburb, VIC, and postcode).",
                coords: "Coordinates could not be derived. Please paste a more specific address or enter lat/lng in Advanced.",
              }));
              scrollToField("address");
              return;
            }

            setLat(String(latN));
            setLng(String(lngN));
            setCoordsManual(false);
            setCoordsAddressSnapshot(address);

            if (formErrors.address) clearFieldError("address");
            if (formErrors.coords) clearFieldError("coords");
            setSubmitError(null);

            finalLatN = latN;
            finalLngN = lngN;
          } finally {
            setAddrGeocoding(false);
          }
        }
      }

      if (finalLatN === null || finalLngN === null || !isValidLatLngRange(finalLatN, finalLngN)) {
        setFormErrors((prev) => ({
          ...prev,
          coords: "Coordinates are required. Paste a full address (recommended) or enter lat/lng in Advanced.",
        }));
        scrollToField("coords");
        return;
      }

      if (!coordsManual) {
        const decision: CreateSafetyDecision = await runCreateLocationSafetyCheck(
          address,
          finalLatN,
          finalLngN,
          geocodeRawForSafety
        );

        if (decision.kind === "block") {
          setErrorsAndScroll({
            address: "Address and coordinates do not match. Please paste the full address from Google Maps again.",
            coords: "Blocked: resolved location failed safety checks. Fix the address or use Advanced lat/lng.",
          });
          showSafetyBlockAlert(decision.title, decision.message, address);
          return;
        }

        if (decision.kind === "warn") {
          const proceed = await confirmProceedWithSafetyWarning(decision.title, decision.message, address);
          if (!proceed) return;
        }
      }

      const venueNameTrim = venueName.trim();
      const payload = {
        group_id: groupId,
        title: eventTitle,
        start_utc: startTrim,
        end_utc: endTrim,
        lat: finalLatN,
        lng: finalLngN,
        radius_m: r,
        window_minutes: w,
        location_name: venueNameTrim ? venueNameTrim : null,
        address_text: address,
      };

      const res = await supabase.from("events").insert(payload).select("id").single();
      if (res.error) throw res.error;

      notify("Event created.");

      setFormErrors({});
      setSubmitError(null);

      setTitle("");
      setVenueName("");
      setAddressText("");

      setLat("");
      setLng("");
      setCoordsManual(false);
      setCoordsAddressSnapshot(null);

      setShowAdvancedLocation(false);

      setPlaceQuery("");
      setPlaceResults([]);
      setPlaceError(null);
      setPlaceSearched(false);

      await fetchEventsForGroup(groupId);
    } catch (e: any) {
      setSubmitError(e?.message ?? "Failed to create event");
    } finally {
      createInFlightRef.current = false;
      setSubmitting(false);
      setAddrGeocoding(false);
    }
  }, [
    addressText,
    clearFieldError,
    confirmProceedWithSafetyWarning,
    coordsAddressSnapshot,
    coordsManual,
    endUtc,
    fetchEventsForGroup,
    formErrors.address,
    formErrors.coords,
    groupId,
    lat,
    lng,
    radiusM,
    runCreateLocationSafetyCheck,
    scrollToField,
    setErrorsAndScroll,
    showSafetyBlockAlert,
    startUtc,
    submitting,
    title,
    validateIso,
    venueName,
    windowMin,
  ]);

  const openEvent = useCallback(
    (eventId: string) => {
      router.push({ pathname: "/organize/events/[id]", params: { id: eventId } });
    },
    [router]
  );

  const groupLabel = useMemo(() => {
    const g = groups.find((x) => x.id === groupId);
    return g?.name ?? "(Select group)";
  }, [groups, groupId]);

  const hasCoords = useMemo(() => {
    const latN = Number(lat);
    const lngN = Number(lng);
    return !!lat && !!lng && !Number.isNaN(latN) && !Number.isNaN(lngN) && isValidLatLngRange(latN, lngN);
  }, [lat, lng]);

  const mapsQuery = useMemo(() => {
    const a = addressText.trim();
    if (a) return a;
    const v = venueName.trim();
    if (v) return v;
    return "Melbourne";
  }, [addressText, venueName]);

  const coordsStale = useMemo(() => {
    const addr = addressText.trim();
    if (!addr) return false;
    if (!hasCoords) return false;
    if (coordsManual) return false;
    if (!coordsAddressSnapshot) return false;
    return coordsAddressSnapshot.trim() !== addr;
  }, [addressText, coordsAddressSnapshot, coordsManual, hasCoords]);

  const activeRadiusPreset = useMemo(() => {
    const n = Number(radiusM.trim());
    if (!Number.isFinite(n)) return null;
    return (RADIUS_PRESETS_M as readonly number[]).includes(n) ? n : null;
  }, [radiusM]);

  const howToBody = useMemo(() => {
    const lines: string[] = [];

    lines.push("Quick start");
    lines.push("• Enter a Title, start/end time and Venue address, then tap Create.");
    lines.push("");
    lines.push("Venue address (two options)");
    lines.push("1) Type an address directly (place name is optional in this case).");
    lines.push(
      "2) Type a place (e.g. “Melbourne Central”) in the Place name section, then click OPEN MAPS button, copy an address from Google Maps and paste it in the Venue address field."
    );
    lines.push("");
    lines.push("Coordinates");
    lines.push("• Used for geofence check-in.");
    lines.push("• Tap “SET COORDS FROM ADDRESS” to preview coordinates.");
    lines.push("• If the address changes, coordinates will be re-derived on Create.");
    lines.push("• Use “Show advanced (lat/lng)” only if you want to enter coordinates manually.");
    lines.push("");
    lines.push("Radius / Window");
    lines.push("• Radius (m): how far from the venue center counts as inside.");
    lines.push("• Window ± (min): allowed minutes before/after the event time.");
    lines.push("");
    lines.push("Advanced");
    lines.push("• “Show advanced (UTC ISO)” shows the stored timestamps (UTC ISO ending in Z).");
    lines.push("• “Show quick search (experimental)” may return wrong coordinates.");

    return lines.join("\n");
  }, []);

  if (loading) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator />
        <Text style={{ marginTop: 10, color: "#6B7280" }}>Loading…</Text>
      </View>
    );
  }

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.container}
      contentContainerStyle={{ paddingBottom: 24 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={styles.header}>Organize</Text>
        <TouchableOpacity
          onPress={openHowTo}
          accessibilityRole="button"
          accessibilityLabel="How to use"
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: "#111827",
            alignItems: "center",
            justifyContent: "center",
            marginTop: Platform.OS === "android" ? 8 : 0,
          }}
        >
          <Text style={{ fontWeight: "900", color: "#111827" }}>?</Text>
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={styles.bannerError}>
          <Text style={styles.bannerText}>Error: {error}</Text>
        </View>
      ) : null}

      {role === "organizer" ? (
        <View
          style={styles.card}
          onLayout={(e) => {
            const y = e?.nativeEvent?.layout?.y;
            if (typeof y === "number") setCreateCardY(y);
          }}
        >
          <Text style={styles.cardTitle}>Create event</Text>

          {submitError ? (
            <View style={styles.inlineErrorBlock}>
              <Text style={styles.inlineErrorText}>{submitError}</Text>
            </View>
          ) : null}

          <View onLayout={registerFieldY("group")}>
            <Text style={styles.label}>Group</Text>
            <View style={styles.row}>
              <TouchableOpacity style={styles.btnSmall} onPress={openManageGroups}>
                <Text style={styles.btnSmallText}>MANAGE GROUPS</Text>
              </TouchableOpacity>
            </View>

            <View style={{ height: 10 }} />

            {groups.length === 0 ? (
              <Text style={styles.help}>No groups found. Create a group first.</Text>
            ) : (
              <FlatList
                horizontal
                data={groups}
                keyExtractor={(g) => g.id}
                renderItem={({ item }) => {
                  const active = item.id === groupId;
                  return (
                    <TouchableOpacity
                      style={[styles.chip, active && styles.chipActive]}
                      onPress={async () => {
                        setGroupId(item.id);
                        if (formErrors.group) clearFieldError("group");
                        setSubmitError(null);
                        await fetchEventsForGroup(item.id);
                      }}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>
                        {item.name ?? "(Untitled group)"}
                      </Text>
                    </TouchableOpacity>
                  );
                }}
              />
            )}

            {renderFieldError("group")}
          </View>

          <View style={{ height: 12 }} />

          <View onLayout={registerFieldY("title")}>
            <Text style={styles.label}>Title (required)</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Math 101 — Quiz 2"
              value={title}
              onChangeText={(t) => {
                setTitle(t);
                if (formErrors.title) clearFieldError("title");
                setSubmitError(null);
              }}
            />
            {renderFieldError("title")}
          </View>

          <View onLayout={registerFieldY("start")}>
            <Text style={styles.label}>Start (local)</Text>
            <View style={styles.row}>
              <TouchableOpacity style={styles.btnSmall} onPress={useLocalNow}>
                <Text style={styles.btnSmallText}>Use local now</Text>
              </TouchableOpacity>
            </View>

            <View style={{ height: 10 }} />

            <Pressable
              style={styles.pickerField}
              onPress={() => {
                if (formErrors.start) clearFieldError("start");
                if (formErrors.end) clearFieldError("end");
                setSubmitError(null);
                openStartPicker();
              }}
            >
              <Text style={startLocalDisplay ? styles.pickerText : styles.pickerPlaceholder}>
                {startLocalDisplay ?? "Tap to select start…"}
              </Text>
            </Pressable>
            {renderFieldError("start")}
          </View>

          <View onLayout={registerFieldY("end")}>
            <Text style={styles.label}>End (local)</Text>
            <Pressable
              style={styles.pickerField}
              onPress={() => {
                if (formErrors.end) clearFieldError("end");
                setSubmitError(null);
                console.log("[organize] End pressed (picker TODO)");
              }}
            >
              <Text style={endLocalDisplay ? styles.pickerText : styles.pickerPlaceholder}>
                {endLocalDisplay ?? "Tap to select end…"}
              </Text>
            </Pressable>
            {renderFieldError("end")}
          </View>

          <TouchableOpacity style={styles.advancedToggle} onPress={() => setShowAdvancedTime((v) => !v)}>
            <Text style={styles.advancedToggleText}>
              {showAdvancedTime ? "Hide advanced (UTC ISO)" : "Show advanced (UTC ISO)"}
            </Text>
          </TouchableOpacity>

          {showAdvancedTime ? (
            <View style={styles.advancedBlock}>
              <Text style={styles.label}>Start (UTC ISO)</Text>
              <TextInput
                style={styles.inputMono}
                placeholder="e.g. 2025-08-28T05:18:02.660Z"
                value={startUtc}
                onChangeText={(t) => {
                  setStartUtc(t);
                  if (formErrors.start) clearFieldError("start");
                  setSubmitError(null);
                }}
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Text style={styles.label}>End (UTC ISO)</Text>
              <TextInput
                style={styles.inputMono}
                placeholder="e.g. 2025-08-28T06:18:02.660Z"
                value={endUtc}
                onChangeText={(t) => {
                  setEndUtc(t);
                  if (formErrors.end) clearFieldError("end");
                  setSubmitError(null);
                }}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          ) : null}

          <View style={{ height: 6 }} />

          <View onLayout={registerFieldY("address")}>
            <Text style={styles.label}>Venue name (optional)</Text>
            <TextInput
              style={styles.input}
              placeholder='e.g. "Melbourne Central" / "Uni Library"'
              value={venueName}
              onChangeText={(t) => {
                setVenueName(t);
                setSubmitError(null);
              }}
              autoCapitalize="words"
              autoCorrect={false}
            />

            <Text style={styles.label}>Venue address (required)</Text>
            <TextInput
              style={styles.input}
              placeholder="Paste full address from Google Maps (e.g. 211 La Trobe St, Melbourne VIC 3000)"
              value={addressText}
              onChangeText={(t) => {
                setAddressText(t);
                if (formErrors.address) clearFieldError("address");
                setSubmitError(null);
              }}
              autoCapitalize="words"
              autoCorrect={false}
            />

            <View style={{ height: 10 }} />

            <View style={styles.row}>
              <TouchableOpacity style={styles.btnSmall} onPress={() => openGoogleMapsSearch(mapsQuery)}>
                <Text style={styles.btnSmallText}>OPEN MAPS</Text>
              </TouchableOpacity>
            </View>

            {renderFieldError("address")}
          </View>

          <View style={{ height: 8 }} />

          <View onLayout={registerFieldY("coords")}>
            <Text style={styles.label}>Venue coordinates</Text>

            <View style={styles.row}>
              <TouchableOpacity
                style={[styles.btnSmall, addrGeocoding && styles.btnSmallDisabled]}
                onPress={setCoordsFromAddress}
                disabled={addrGeocoding}
              >
                <Text style={styles.btnSmallText}>{addrGeocoding ? "SETTING…" : "SET COORDS FROM ADDRESS"}</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.rowBetween}>
              <View />
              <TouchableOpacity style={styles.advancedToggleInline} onPress={() => setShowAdvancedLocation((v) => !v)}>
                <Text style={styles.advancedToggleText}>
                  {showAdvancedLocation ? "Hide advanced (lat/lng)" : "Show advanced (lat/lng)"}
                </Text>
              </TouchableOpacity>
            </View>

            {coordsStale ? (
              <Text style={[styles.helpSmall, { marginTop: 4 }]}>Coordinates are stale (address changed).</Text>
            ) : null}

            {showAdvancedLocation ? (
              <View style={styles.advancedBlock}>
                <Text style={styles.label}>Venue lat / lng</Text>
                <View style={styles.row}>
                  <TextInput
                    style={[styles.inputMono, styles.rowInput]}
                    placeholder="lat (e.g. -37.9025)"
                    value={lat}
                    onChangeText={(t) => {
                      setLat(t);
                      setCoordsManual(true);
                      setCoordsAddressSnapshot(null);
                      if (formErrors.coords) clearFieldError("coords");
                      setSubmitError(null);
                    }}
                    keyboardType="decimal-pad"
                  />
                  <TextInput
                    style={[styles.inputMono, styles.rowInputNoRight]}
                    placeholder="lng (e.g. 145.0394)"
                    value={lng}
                    onChangeText={(t) => {
                      setLng(t);
                      setCoordsManual(true);
                      setCoordsAddressSnapshot(null);
                      if (formErrors.coords) clearFieldError("coords");
                      setSubmitError(null);
                    }}
                    keyboardType="decimal-pad"
                  />
                </View>
              </View>
            ) : null}

            {renderFieldError("coords")}
          </View>

          <TouchableOpacity style={styles.secondaryToggle} onPress={() => setShowPlaceSearch((v) => !v)}>
            <Text style={styles.secondaryToggleText}>
              {showPlaceSearch ? "Hide quick search (experimental)" : "Show quick search (experimental)"}
            </Text>
          </TouchableOpacity>

          {showPlaceSearch ? (
            <View style={styles.subCard}>
              <Text style={styles.label}>Quick search (experimental)</Text>
              <Text style={[styles.helpSmall, { marginTop: -2 }]}>
                This uses on-device geocoding and may return the wrong coordinates. Prefer pasting the address from Google
                Maps.
              </Text>

              <View style={{ height: 8 }} />

              <View style={styles.searchRow}>
                <TextInput
                  style={[styles.input, styles.searchInput]}
                  placeholder="e.g. Melbourne Central / Albert Park / 123 Example St"
                  value={placeQuery}
                  onChangeText={(t) => {
                    setPlaceQuery(t);
                    setPlaceError(null);
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                  onSubmitEditing={runPlaceSearchForward}
                  editable={!placeSearching}
                />

                <TouchableOpacity
                  style={[styles.searchBtn, placeSearching && styles.searchBtnDisabled]}
                  onPress={runPlaceSearchForward}
                  disabled={placeSearching}
                >
                  {placeSearching ? <ActivityIndicator /> : <Text style={styles.searchBtnText}>Search</Text>}
                </TouchableOpacity>
              </View>

              {placeError ? (
                <Text style={[styles.helpSmall, { marginTop: 6, color: "#B00020" }]}>{placeError}</Text>
              ) : null}

              {placeSearched ? (
                placeResults.length === 0 ? (
                  <Text style={styles.helpSmall}>No candidates.</Text>
                ) : (
                  <View style={{ marginTop: 6 }}>
                    {placeResults.map((p) => (
                      <TouchableOpacity key={p.id} style={styles.placeRow} onPress={() => selectPlace(p)}>
                        <Text style={styles.placeTitle}>{p.title}</Text>
                        <Text style={styles.placeSubtitle}>{p.subtitle}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )
              ) : null}
            </View>
          ) : null}

          <View style={{ height: 10 }} />

          <View onLayout={registerFieldY("radius")}>
            <View style={styles.row}>
              <View style={{ flex: 1, marginRight: 10 }}>
                <Text style={styles.label}>Radius (m)</Text>
                <TextInput
                  style={styles.input}
                  value={radiusM}
                  onChangeText={(t) => {
                    setRadiusM(t);
                    if (formErrors.radius) clearFieldError("radius");
                    setSubmitError(null);
                  }}
                  keyboardType="number-pad"
                />

                <View style={styles.presetRow}>
                  {(RADIUS_PRESETS_M as readonly number[]).map((v) => {
                    const active = activeRadiusPreset === v;
                    return (
                      <TouchableOpacity
                        key={`r-${v}`}
                        style={[styles.presetChip, active && styles.presetChipActive]}
                        onPress={() => {
                          setRadiusM(String(v));
                          if (formErrors.radius) clearFieldError("radius");
                          setSubmitError(null);
                        }}
                      >
                        <Text style={[styles.presetChipText, active && styles.presetChipTextActive]}>{v}m</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {renderFieldError("radius")}
              </View>

              <View style={{ flex: 1 }} onLayout={registerFieldY("window")}>
                <Text style={styles.label}>Window ± (min)</Text>
                <TextInput
                  style={styles.input}
                  value={windowMin}
                  onChangeText={(t) => {
                    setWindowMin(t);
                    if (formErrors.window) clearFieldError("window");
                    setSubmitError(null);
                  }}
                  keyboardType="number-pad"
                />
                {renderFieldError("window")}
              </View>
            </View>
          </View>

          <TouchableOpacity
            style={[styles.primaryBtn, submitting && styles.primaryBtnDisabled]}
            onPress={createEvent}
            disabled={submitting}
          >
            <Text style={styles.primaryBtnText}>{submitting ? "Creating…" : "Create"}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Organizer tools</Text>
          <Text style={styles.help}>You are signed in, but your role is not organizer.</Text>
          <Text style={[styles.help, { marginTop: 8 }]}>Current role: {String(role)}</Text>
          <TouchableOpacity
            style={[styles.btnSmall, { marginTop: 12, alignSelf: "flex-start" }]}
            onPress={() => router.push("/me")}
          >
            <Text style={styles.btnSmallText}>Go to Profile</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Recent events</Text>

        {events.length === 0 ? (
          <Text style={styles.help}>No events yet.</Text>
        ) : (
          events.map((ev) => {
            const titleText = ev.title ?? "(Untitled event)";
            const start = ev.start_utc ?? "";
            const end = ev.end_utc ?? "";
            const loc = (ev.address_text ?? ev.location_name ?? "").trim();
            return (
              <TouchableOpacity key={ev.id} style={styles.eventItem} onPress={() => openEvent(ev.id)}>
                <Text style={styles.eventTitle}>{titleText}</Text>
                <Text style={styles.eventMeta}>
                  {start} → {end}
                </Text>
                {loc ? <Text style={styles.eventMeta}>📍 {loc}</Text> : null}
                <Text style={styles.eventLink}>Open</Text>
              </TouchableOpacity>
            );
          })
        )}

        <View style={{ height: 10 }} />

        <View style={styles.row}>
          <TouchableOpacity
            style={styles.btnSmall}
            onPress={() => {
              const gid = groupId ?? passedGid;
              if (!gid) {
                Alert.alert("Select a group", "Please select a group first.");
                return;
              }
              const url = `rta://organize?gid=${encodeURIComponent(gid)}`;
              openWebUrl(url);
            }}
          >
            <Text style={styles.btnSmallText}>Open deep link (rta://)</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.btnSmall} onPress={() => router.push("/organize/location-test")}>
            <Text style={styles.btnSmallText}>Location test</Text>
          </TouchableOpacity>
        </View>

        <Text style={[styles.helpSmall, { marginTop: 10 }]}>Selected group: {groupLabel}</Text>
      </View>

      <Modal visible={howToOpen} transparent animationType="fade" onRequestClose={closeHowTo}>
        <View style={styles.modalOverlay}>
          <Pressable
            onPress={closeHowTo}
            style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
          />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>How to use</Text>
            <Text style={styles.modalBody}>{howToBody}</Text>

            <View style={{ height: 12 }} />

            <View style={styles.modalFooter}>
              <TouchableOpacity style={styles.modalPrimaryBtn} onPress={closeHowTo}>
                <Text style={styles.modalPrimaryBtnText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={manageOpen} transparent animationType="fade" onRequestClose={closeManageGroups}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Manage groups</Text>
            <Text style={styles.modalBody}>Open a group admin screen.</Text>

            <View style={{ height: 10 }} />

            {groups.length === 0 ? (
              <Text style={styles.help}>No groups found.</Text>
            ) : (
              groups.map((g) => (
                <TouchableOpacity key={g.id} style={styles.modalRow} onPress={() => openGroup(g.id)}>
                  <Text style={styles.modalRowTitle}>{g.name ?? "(Untitled group)"}</Text>
                  {g.description ? <Text style={styles.modalRowDesc}>{g.description}</Text> : null}
                </TouchableOpacity>
              ))
            )}

            <View style={{ height: 12 }} />

            <View style={styles.modalFooter}>
              <TouchableOpacity style={styles.modalBtn} onPress={closeManageGroups}>
                <Text style={styles.modalBtnText}>Close</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.modalPrimaryBtn} onPress={() => router.push("/organize/admin")}>
                <Text style={styles.modalPrimaryBtnText}>Open Admin</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={startPickerOpen} transparent animationType="slide" onRequestClose={closeStartPicker}>
        <View style={styles.modalOverlay}>
          <View style={styles.pickerModalCard}>
            <Text style={styles.modalTitle}>
              {startPickerStep === "date" ? "Select start date" : "Select start time"}
            </Text>
            <Text style={styles.modalBody}>Preview: {tempStartPreview}</Text>

            <View style={{ height: 12 }} />

            {Platform.OS === "ios" ? (
              <DateTimePicker
                value={tempStartLocal}
                mode={startPickerStep}
                display="spinner"
                is24Hour
                onChange={(_, selected) => {
                  if (!selected) return;
                  if (startPickerStep === "date") {
                    setTempStartLocal((prev) => setLocalDateKeepTime(prev, selected));
                  } else {
                    setTempStartLocal((prev) => setLocalTimeKeepDate(prev, selected));
                  }
                }}
              />
            ) : null}

            <View style={{ height: 12 }} />

            <View style={styles.modalFooter}>
              <TouchableOpacity style={styles.modalBtn} onPress={closeStartPicker}>
                <Text style={styles.modalBtnText}>Cancel</Text>
              </TouchableOpacity>

              {startPickerStep === "date" ? (
                <TouchableOpacity style={styles.modalPrimaryBtn} onPress={() => setStartPickerStep("time")}>
                  <Text style={styles.modalPrimaryBtnText}>Next</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity style={styles.modalPrimaryBtn} onPress={commitStartPickerIOS}>
                  <Text style={styles.modalPrimaryBtnText}>Confirm</Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={{ height: 8 }} />

            <Text style={styles.helpSmall}>Stored as UTC ISO (Z). Displayed in your local time.</Text>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}
