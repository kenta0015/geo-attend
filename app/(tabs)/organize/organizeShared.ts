// /Users/ken/app_development/rta-zero_restored/app/(tabs)/organize/organizeShared.ts
import { Platform, StyleSheet } from "react-native";

export type FieldKey = "group" | "title" | "start" | "end" | "address" | "coords" | "radius" | "window";
export type FormErrors = Partial<Record<FieldKey, string>>;

export type PlaceCandidate = {
  id: string;
  title: string;
  subtitle: string;
  lat: number;
  lng: number;
};

export const FIELD_ORDER: FieldKey[] = ["group", "title", "start", "end", "address", "coords", "radius", "window"];

export const DEFAULT_DURATION_MINUTES = 60;

export const MELBOURNE_CBD = { lat: -37.8136, lng: 144.9631 };
export const MAX_PLACE_RESULTS = 10;
export const DEDUPE_RADIUS_M = 100;

export const nowIso = () => new Date().toISOString();
export const plusHoursIso = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

export const PLACE_LOG_PREFIX = "[organize][place]";
export const SAFETY_LOG_PREFIX = "[organize][safety]";

export const AU_STATE_CODES = ["VIC", "NSW", "QLD", "SA", "WA", "TAS", "ACT", "NT"] as const;
export const AU_STATE_REGEX = new RegExp(`\\b(?:${AU_STATE_CODES.join("|")})\\b`, "i");
export const AU_POSTCODE_REGEX = /\b\d{4}\b/g;

export const AMBIGUOUS_WARN_M = 5_000;
export const AMBIGUOUS_STRONG_WARN_M = 50_000;
export const CAPITAL_HINT_WARN_M = 80_000;
export const CAPITAL_HINT_STRONG_WARN_M = 250_000;

export const RADIUS_PRESETS_M = [50, 100, 200, 300] as const;
export const RADIUS_MIN_M = 10;
export const RADIUS_MAX_M = 1000;

export const CAPITAL_HINTS: Array<{ name: string; lat: number; lng: number }> = [
  { name: "Melbourne", lat: MELBOURNE_CBD.lat, lng: MELBOURNE_CBD.lng },
  { name: "Sydney", lat: -33.8688, lng: 151.2093 },
  { name: "Brisbane", lat: -27.4698, lng: 153.0251 },
  { name: "Adelaide", lat: -34.9285, lng: 138.6007 },
  { name: "Perth", lat: -31.9523, lng: 115.8613 },
  { name: "Hobart", lat: -42.8821, lng: 147.3272 },
  { name: "Canberra", lat: -35.2809, lng: 149.13 },
  { name: "Darwin", lat: -12.4634, lng: 130.8456 },
];

export const AU_STATE_NAME_TO_CODE: Record<string, (typeof AU_STATE_CODES)[number]> = {
  VICTORIA: "VIC",
  "NEW SOUTH WALES": "NSW",
  QUEENSLAND: "QLD",
  "SOUTH AUSTRALIA": "SA",
  "WESTERN AUSTRALIA": "WA",
  TASMANIA: "TAS",
  "AUSTRALIAN CAPITAL TERRITORY": "ACT",
  "NORTHERN TERRITORY": "NT",
};

export function safeParseIso(isoUtc: string): Date {
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return new Date();
  return d;
}

export function setLocalDateKeepTime(base: Date, newDate: Date): Date {
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

export function setLocalTimeKeepDate(base: Date, newTime: Date): Date {
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

export function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function buildEndLocalOrNull(startLocal: Date, minutes: number): Date | null {
  const endLocal = new Date(startLocal.getTime() + minutes * 60_000);
  if (!isSameLocalDay(startLocal, endLocal)) return null;
  return endLocal;
}

export function isValidLatLngRange(lat: number, lng: number): boolean {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

export function distanceMetersHaversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
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

export function buildGoogleMapsSearchUrl(query: string): string {
  const q = query.trim();
  if (!q) return "https://www.google.com/maps";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

export function validateIsoZ(iso: string): boolean {
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && iso.includes("T") && iso.endsWith("Z");
}

export function formatLocalDateTime(isoUtc: string): string | null {
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
}

export function analyzeAddressSpecificityAU(address: string): { ok: boolean; missing: string[] } {
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

export function buildFullAddressAlertBody(missing: string[]): string {
  const lines = missing.map((m) => `• Missing: ${m}`);
  lines.push("");
  lines.push("Open Google Maps → select the place → Share → Copy address → paste it here.");
  lines.push("");
  lines.push("Example: 211 La Trobe St, Melbourne VIC 3000");
  return lines.join("\n");
}

export function extractAddressStateCodeAU(address: string): (typeof AU_STATE_CODES)[number] | null {
  const m = address.match(AU_STATE_REGEX);
  if (!m) return null;
  const code = String(m[0] ?? "").trim().toUpperCase();
  return (AU_STATE_CODES as readonly string[]).includes(code) ? (code as any) : null;
}

export function extractAddressPostcodeAU(address: string): string | null {
  const all = Array.from(address.matchAll(AU_POSTCODE_REGEX)).map((m) => m[0]);
  return all.length > 0 ? all[all.length - 1] : null;
}

export function normalizeReverseStateCode(regionLike: unknown): (typeof AU_STATE_CODES)[number] | null {
  const raw = String(regionLike ?? "").trim();
  if (!raw) return null;

  const up = raw.toUpperCase();

  if ((AU_STATE_CODES as readonly string[]).includes(up)) return up as any;

  const compact = up.replace(/\s+/g, " ").trim();
  if (AU_STATE_NAME_TO_CODE[compact]) return AU_STATE_NAME_TO_CODE[compact];

  const head = compact.split(",")[0]?.trim() ?? "";
  if (AU_STATE_NAME_TO_CODE[head]) return AU_STATE_NAME_TO_CODE[head];

  return null;
}

export function extractReversePostcodeAU(postalCodeLike: unknown): string | null {
  const raw = String(postalCodeLike ?? "").trim();
  if (!raw) return null;
  const m = raw.match(/\b\d{4}\b/);
  return m ? m[0] : null;
}

export function detectCapitalHint(address: string): { name: string; lat: number; lng: number } | null {
  const a = address.trim().toLowerCase();
  if (!a) return null;
  for (const c of CAPITAL_HINTS) {
    if (a.includes(c.name.toLowerCase())) return c;
  }
  return null;
}

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return "-";
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  if (km < 10) return `${km.toFixed(2)} km`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

export const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 16, paddingHorizontal: 16 },
  header: { fontSize: 22, fontWeight: "700", marginBottom: 12 },
  bannerError: {
    backgroundColor: "#FFEAEA",
    borderColor: "#FF8A8A",
    borderWidth: 1,
    padding: 12,
    borderRadius: 10,
    marginBottom: 12,
  },
  bannerText: { color: "#B00020" },
  card: {
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
    backgroundColor: "white",
  },
  subCard: {
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 14,
    padding: 12,
    marginTop: 10,
    backgroundColor: "#FAFAFA",
  },
  cardTitle: { fontSize: 16, fontWeight: "700", marginBottom: 8 },
  label: { fontWeight: "600", marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: "#D1D5DB",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    marginBottom: 10,
    backgroundColor: "white",
  },
  inputMono: {
    borderWidth: 1,
    borderColor: "#D1D5DB",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    marginBottom: 10,
    backgroundColor: "white",
    fontFamily: Platform.select({
      ios: "Menlo",
      android: "monospace",
      default: "monospace",
    }),
  },

  pickerField: {
    borderWidth: 1,
    borderColor: "#D1D5DB",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 12,
    marginBottom: 10,
    backgroundColor: "white",
    justifyContent: "center",
  },
  pickerText: { color: "#111827" },
  pickerPlaceholder: { color: "#6B7280" },
  advancedToggle: { alignSelf: "flex-start", marginBottom: 10, marginTop: -2 },
  advancedToggleText: { color: "#2563EB", fontWeight: "700" },
  secondaryToggle: { alignSelf: "flex-start", marginTop: 6 },
  secondaryToggleText: { color: "#374151", fontWeight: "700" },
  advancedBlock: { marginTop: 2 },

  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: -4,
    marginBottom: 8,
  },
  rowInput: { flex: 1, marginRight: 10 },
  rowInputNoRight: { flex: 1, marginRight: 0 },
  btnSmall: {
    borderWidth: 1,
    borderColor: "#111827",
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: "white",
  },
  btnSmallDisabled: { opacity: 0.4 },
  btnSmallText: { fontWeight: "800", color: "#111827" },
  chip: {
    borderWidth: 1,
    borderColor: "#D1D5DB",
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginRight: 8,
    backgroundColor: "white",
  },
  chipActive: { backgroundColor: "#111827", borderColor: "#111827" },
  chipText: { color: "#111827", fontWeight: "600" },
  chipTextActive: { color: "white", fontWeight: "700" },
  help: { color: "#6B7280" },
  helpSmall: { color: "#6B7280", marginTop: 6, fontSize: 12 },
  eventItem: {
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  eventTitle: { fontWeight: "800", color: "#111827", marginBottom: 4 },
  eventMeta: { color: "#6B7280", fontSize: 12, marginBottom: 2 },
  eventLink: { marginTop: 6, color: "#2563EB", fontWeight: "800" },
  primaryBtn: {
    backgroundColor: "#111827",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 2,
  },
  primaryBtnDisabled: { opacity: 0.6 },
  primaryBtnText: { color: "white", fontWeight: "900" },
  center: { alignItems: "center", justifyContent: "center" },

  presetRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    marginTop: -2,
    marginBottom: 8,
  },
  presetChip: {
    borderWidth: 1,
    borderColor: "#D1D5DB",
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: "white",
    marginRight: 8,
    marginBottom: 8,
  },
  presetChipActive: { backgroundColor: "#111827", borderColor: "#111827" },
  presetChipText: { color: "#111827", fontWeight: "800" },
  presetChipTextActive: { color: "white", fontWeight: "900" },

  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 2,
  },
  searchInput: {
    flex: 1,
    marginBottom: 0,
  },
  searchBtn: {
    marginLeft: 10,
    borderWidth: 1,
    borderColor: "#111827",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: "white",
    marginBottom: 0,
    minWidth: 92,
    alignItems: "center",
    justifyContent: "center",
  },
  searchBtnDisabled: { opacity: 0.6 },
  searchBtnText: { fontWeight: "900", color: "#111827" },

  placeRow: {
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    backgroundColor: "white",
  },
  placeTitle: { fontWeight: "900", color: "#111827" },
  placeSubtitle: { color: "#6B7280", marginTop: 4, fontSize: 12 },

  advancedToggleInline: { paddingVertical: 2, paddingLeft: 8 },

  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  modalCard: {
    width: "100%",
    maxWidth: 520,
    borderRadius: 14,
    backgroundColor: "white",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    padding: 14,
  },
  pickerModalCard: {
    width: "100%",
    maxWidth: 520,
    borderRadius: 14,
    backgroundColor: "white",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    padding: 14,
  },
  modalTitle: { fontSize: 18, fontWeight: "800", marginBottom: 6, color: "#111827" },
  modalBody: { color: "#6B7280", lineHeight: 18 },

  modalPrimaryBtn: {
    backgroundColor: "#111827",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  modalPrimaryBtnText: { color: "white", fontWeight: "900" },

  modalBtn: {
    borderWidth: 1,
    borderColor: "#D1D5DB",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    marginRight: 10,
  },
  modalBtnText: { color: "#111827", fontWeight: "900" },

  modalFooter: { flexDirection: "row", justifyContent: "flex-end", marginTop: 10 },

  modalRow: {
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  modalRowTitle: { fontWeight: "900", color: "#111827" },
  modalRowDesc: { color: "#6B7280", marginTop: 4, fontSize: 12 },

  inlineErrorBlock: {
    backgroundColor: "#FFEAEA",
    borderColor: "#FF8A8A",
    borderWidth: 1,
    padding: 10,
    borderRadius: 10,
    marginBottom: 10,
  },
  inlineErrorText: {
    color: "#B00020",
    fontWeight: "700",
    marginTop: -2,
    marginBottom: 10,
  },
});
