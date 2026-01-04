import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  ToastAndroid,
  View,
  Linking,
} from "react-native";
import * as Location from "expo-location";
import { useLocalSearchParams, useRouter } from "expo-router";
import { supabase } from "../../../../../lib/supabase";
import { getGuestId } from "../../../../../stores/session";
import { useEffectiveRole } from "../../../../../stores/devRole";
import Card from "../../../../ui/Card";
import Button from "../../../../ui/Button";
import { COLORS, RADIUS, SPACING } from "../../../../../src/ui/theme";

type EventRow = {
  id: string;
  title: string | null;
  location_name: string | null;
  address_text: string | null;
  lat: number | null;
  lng: number | null;
};

const AU_STATE_CODES = [
  "VIC",
  "NSW",
  "QLD",
  "SA",
  "WA",
  "TAS",
  "ACT",
  "NT",
] as const;

function getEventIdParam(params: Record<string, unknown>): string {
  const raw = params?.id;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (
    Array.isArray(raw) &&
    typeof raw[0] === "string" &&
    raw[0].trim()
  )
    return raw[0].trim();
  return "";
}

function notify(msg: string) {
  if (Platform.OS === "android") ToastAndroid.show(msg, ToastAndroid.SHORT);
  else Alert.alert("Info", msg);
}

function isValidLatLngRange(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  return true;
}

type AddressSpecificity = {
  hasStreetNumber: boolean;
  hasPostcode: boolean;
  hasState: boolean;
};

function analyzeAddressSpecificityAU(input: string): AddressSpecificity {
  const s = (input || "").trim();

  const postcodeMatch = s.match(/\b(\d{4})\b/);
  const hasPostcode = Boolean(postcodeMatch);

  const upper = s.toUpperCase();
  const hasState = AU_STATE_CODES.some((code) =>
    new RegExp(`\\b${code}\\b`).test(upper)
  );

  // street number: "12", "12A", "12-14", "12/34"
  const hasStreetNumber = /\b\d{1,6}([A-Za-z])?\b/.test(s);

  return { hasStreetNumber, hasPostcode, hasState };
}

function buildFullAddressAlertBody(spec: AddressSpecificity): string {
  const missing: string[] = [];
  if (!spec.hasStreetNumber) missing.push("a street number (e.g., 12)");
  if (!spec.hasState) missing.push("a state code (e.g., VIC)");
  if (!spec.hasPostcode) missing.push("a postcode (e.g., 3163)");

  if (missing.length === 0) return "Please enter a more specific address.";
  return `Please include ${missing.join(
    ", "
  )} to make the address specific enough for geocoding.`;
}

function buildGoogleMapsSearchUrl(q: string): string {
  const encoded = encodeURIComponent(q.trim());
  return `https://www.google.com/maps/search/?api=1&query=${encoded}`;
}

export default function EventLocationEditScreen() {
  const params = useLocalSearchParams();
  const router = useRouter();
  const effectiveRole = useEffectiveRole();

  const eventId = useMemo(
    () => getEventIdParam(params as Record<string, unknown>),
    [params]
  );

  const C = COLORS as any;
  const R = RADIUS as any;
  const S = SPACING as any;

  const UI = useMemo(
    () => ({
      bg: C?.bg ?? C?.background ?? "#ffffff",
      text: C?.text ?? C?.primaryText ?? "#111111",
      textMuted: C?.textMuted ?? C?.muted ?? C?.secondaryText ?? "#666666",
      border: C?.border ?? C?.divider ?? "#dddddd",
      card: C?.card ?? C?.surface ?? C?.bg ?? "#ffffff",
      warn:
        C?.warn ??
        C?.warning ??
        C?.danger ??
        C?.primary600 ??
        C?.primary ??
        "#b45309",
    }),
    [C]
  );

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [eventTitle, setEventTitle] = useState<string>("");

  const [venueName, setVenueName] = useState<string>("");
  const [addressText, setAddressText] = useState<string>("");

  const [latText, setLatText] = useState<string>("");
  const [lngText, setLngText] = useState<string>("");

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [coordsManual, setCoordsManual] = useState(false);
  const [coordsAddressSnapshot, setCoordsAddressSnapshot] =
    useState<string>("");

  const coordsStale = useMemo(() => {
    if (coordsManual) return false;
    const snap = (coordsAddressSnapshot || "").trim();
    const cur = (addressText || "").trim();
    if (!snap) return false;
    if (!cur) return false;
    return snap !== cur;
  }, [coordsManual, coordsAddressSnapshot, addressText]);

  async function fetchEvent() {
    if (!eventId) {
      setLoading(false);
      Alert.alert("Error", "Missing event id.");
      return;
    }

    try {
      setLoading(true);

      const {
        data: { user },
      } = await supabase.auth.getUser();

      const userId = user?.id ?? (await getGuestId());

      // Keep the userId read to ensure auth state is initialized similarly to other screens.
      if (!userId) {
        setLoading(false);
        Alert.alert("Error", "Not signed in.");
        return;
      }

      const { data, error } = await supabase
        .from("events")
        .select("id,title,location_name,address_text,lat,lng")
        .eq("id", eventId)
        .maybeSingle();

      if (error) throw error;
      if (!data) {
        setLoading(false);
        Alert.alert("Error", "Event not found.");
        return;
      }

      const row = data as EventRow;

      setEventTitle(row.title ?? "");

      const initialVenueName = row.location_name ?? "";
      const initialAddress = row.address_text ?? row.location_name ?? "";

      setVenueName(initialVenueName);
      setAddressText(initialAddress);

      setLatText(row.lat == null ? "" : String(row.lat));
      setLngText(row.lng == null ? "" : String(row.lng));

      setCoordsManual(false);
      setCoordsAddressSnapshot(initialAddress);
    } catch (e: any) {
      Alert.alert("Error", e?.message ?? "Failed to load event.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchEvent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  async function deriveCoordsFromAddress(
    addr: string
  ): Promise<{ lat: number; lng: number } | null> {
    const trimmed = (addr || "").trim();
    if (!trimmed) {
      Alert.alert("Missing address", "Please enter the venue address.");
      return null;
    }

    const spec = analyzeAddressSpecificityAU(trimmed);
    if (!spec.hasStreetNumber || !spec.hasState || !spec.hasPostcode) {
      Alert.alert("Address too vague", buildFullAddressAlertBody(spec));
      return null;
    }

    try {
      const results = await Location.geocodeAsync(trimmed);
      if (!results || results.length === 0) {
        Alert.alert("Geocode failed", "Could not find coordinates for that address.");
        return null;
      }

      const best = results[0];
      const lat = Number(best.latitude);
      const lng = Number(best.longitude);

      if (!isValidLatLngRange(lat, lng)) {
        Alert.alert("Geocode failed", "Returned coordinates were invalid.");
        return null;
      }

      return { lat, lng };
    } catch (e: any) {
      Alert.alert("Geocode error", e?.message ?? "Failed to geocode address.");
      return null;
    }
  }

  async function onSetCoordsFromAddress() {
    const coords = await deriveCoordsFromAddress(addressText);
    if (!coords) return;

    setLatText(String(coords.lat));
    setLngText(String(coords.lng));
    setCoordsManual(false);
    setCoordsAddressSnapshot(addressText.trim());
    notify("Coordinates updated from address.");
  }

  async function onOpenMaps() {
    const q = (addressText || "").trim() || (venueName || "").trim();
    if (!q) {
      Alert.alert("Missing", "Enter an address or venue name first.");
      return;
    }
    const url = buildGoogleMapsSearchUrl(q);
    const can = await Linking.canOpenURL(url);
    if (!can) {
      Alert.alert("Cannot open", "Unable to open Maps on this device.");
      return;
    }
    Linking.openURL(url);
  }

  async function onSave() {
    if (saving) return;
    if (!eventId) return;

    const nextVenueName = (venueName || "").trim();
    const nextAddress = (addressText || "").trim();

    if (!nextAddress) {
      Alert.alert("Missing address", "Please enter the venue address.");
      return;
    }

    setSaving(true);
    try {
      let finalLat: number | null = null;
      let finalLng: number | null = null;

      if (coordsManual) {
        const lat = Number((latText || "").trim());
        const lng = Number((lngText || "").trim());
        if (!isValidLatLngRange(lat, lng)) {
          Alert.alert("Invalid coordinates", "Please enter valid latitude/longitude.");
          setSaving(false);
          return;
        }
        finalLat = lat;
        finalLng = lng;
      } else {
        const lat = Number((latText || "").trim());
        const lng = Number((lngText || "").trim());
        const hasValidExisting = isValidLatLngRange(lat, lng);

        if (!hasValidExisting || coordsStale) {
          const coords = await deriveCoordsFromAddress(nextAddress);
          if (!coords) {
            setSaving(false);
            return;
          }
          finalLat = coords.lat;
          finalLng = coords.lng;
          setLatText(String(finalLat));
          setLngText(String(finalLng));
          setCoordsAddressSnapshot(nextAddress);
        } else {
          finalLat = lat;
          finalLng = lng;
        }
      }

      const payload: Partial<EventRow> = {
        location_name: nextVenueName ? nextVenueName : null,
        address_text: nextAddress,
        lat: finalLat,
        lng: finalLng,
      };

      const { error } = await supabase.from("events").update(payload).eq("id", eventId);
      if (error) throw error;

      notify("Saved.");
      router.back();
    } catch (e: any) {
      Alert.alert("Error", e?.message ?? "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  if (effectiveRole !== "organizer") {
    return (
      <View style={[styles.center, { backgroundColor: UI.bg }]}>
        <Text style={[styles.title, { color: UI.text }]}>No access</Text>
        <Text style={[styles.subtle, { color: UI.textMuted }]}>
          Only organizers can edit event location.
        </Text>
        <View style={{ height: 12 }} />
        <Button title="Back" onPress={() => router.back()} />
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: UI.bg }]}>
        <ActivityIndicator />
        <Text style={[styles.subtle, { color: UI.textMuted }]}>Loading…</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: UI.bg }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <ScrollView
        contentContainerStyle={[styles.content, { padding: S?.lg ?? 16, gap: S?.md ?? 12 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.title, { color: UI.text }]}>Edit location</Text>
        {eventTitle ? (
          <Text style={[styles.subtitle, { color: UI.textMuted }]}>{eventTitle}</Text>
        ) : null}

        <Card>
          <Text style={[styles.label, { color: UI.textMuted }]}>Venue name (optional)</Text>
          <TextInput
            style={[
              styles.input,
              {
                borderColor: UI.border,
                borderRadius: R?.md ?? 12,
                color: UI.text,
                backgroundColor: UI.card,
              },
            ]}
            placeholder="e.g., Carnegie Library"
            value={venueName}
            onChangeText={setVenueName}
            autoCorrect={false}
            autoCapitalize="words"
            placeholderTextColor={UI.textMuted}
          />

          <View style={{ height: 12 }} />

          <Text style={[styles.label, { color: UI.textMuted }]}>Venue address (required)</Text>
          <TextInput
            style={[
              styles.input,
              styles.textArea,
              {
                borderColor: UI.border,
                borderRadius: R?.md ?? 12,
                color: UI.text,
                backgroundColor: UI.card,
              },
            ]}
            placeholder="e.g., 7 Shepparson Ave, Carnegie VIC 3163"
            value={addressText}
            onChangeText={(t) => {
              setAddressText(t);
              if (!coordsManual) {
                // Keep coordsManual false; we just allow stale detection.
              }
            }}
            autoCorrect={false}
            autoCapitalize="none"
            multiline
            placeholderTextColor={UI.textMuted}
          />

          <View style={{ height: 10 }} />

          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Button title="Open in Maps" variant="outline" onPress={onOpenMaps} />
            </View>
            <View style={{ width: 10 }} />
            <View style={{ flex: 1 }}>
              <Button
                title="Set coords from address"
                variant="outline"
                onPress={onSetCoordsFromAddress}
              />
            </View>
          </View>

          {coordsStale ? (
            <>
              <View style={{ height: 10 }} />
              <Text style={[styles.warn, { color: UI.warn }]}>
                Address changed since coordinates were set. Please set coordinates from address
                again (or enable Advanced and enter coordinates manually).
              </Text>
            </>
          ) : null}

          <View style={{ height: 14 }} />

          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Button
                title={showAdvanced ? "Hide advanced" : "Advanced"}
                variant="ghost"
                onPress={() => setShowAdvanced((v) => !v)}
              />
            </View>
          </View>

          {showAdvanced ? (
            <>
              <View style={{ height: 10 }} />
              <Text style={[styles.label, { color: UI.textMuted }]}>Latitude</Text>
              <TextInput
                style={[
                  styles.input,
                  {
                    borderColor: UI.border,
                    borderRadius: R?.md ?? 12,
                    color: UI.text,
                    backgroundColor: UI.card,
                  },
                ]}
                placeholder="-37.889"
                value={latText}
                onChangeText={(t) => {
                  setLatText(t);
                  setCoordsManual(true);
                }}
                keyboardType="numeric"
                autoCorrect={false}
                autoCapitalize="none"
                placeholderTextColor={UI.textMuted}
              />

              <View style={{ height: 10 }} />

              <Text style={[styles.label, { color: UI.textMuted }]}>Longitude</Text>
              <TextInput
                style={[
                  styles.input,
                  {
                    borderColor: UI.border,
                    borderRadius: R?.md ?? 12,
                    color: UI.text,
                    backgroundColor: UI.card,
                  },
                ]}
                placeholder="145.057"
                value={lngText}
                onChangeText={(t) => {
                  setLngText(t);
                  setCoordsManual(true);
                }}
                keyboardType="numeric"
                autoCorrect={false}
                autoCapitalize="none"
                placeholderTextColor={UI.textMuted}
              />

              <View style={{ height: 10 }} />
              <Text style={[styles.subtle, { color: UI.textMuted }]}>
                Editing coordinates manually will override the address-based coordinates for this event.
              </Text>
            </>
          ) : null}
        </Card>

        <View style={{ height: 14 }} />

        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Button
              title="Cancel"
              variant="outline"
              onPress={() => router.back()}
              disabled={saving}
            />
          </View>
          <View style={{ width: 12 }} />
          <View style={{ flex: 1 }}>
            <Button title={saving ? "Saving…" : "Save"} onPress={onSave} disabled={saving} />
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  content: {
    gap: 12,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    gap: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
  },
  subtitle: {
    fontSize: 14,
    marginTop: -6,
  },
  label: {
    marginBottom: 6,
    fontSize: 13,
  },
  input: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  textArea: {
    minHeight: 80,
    textAlignVertical: "top",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  subtle: {
    fontSize: 13,
    textAlign: "center",
  },
  warn: {
    fontSize: 13,
  },
});
