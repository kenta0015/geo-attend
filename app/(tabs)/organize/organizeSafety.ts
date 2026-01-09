import * as Location from "expo-location";

export type CreateSafetyDecision =
  | { kind: "ok"; reasonCodes: string[]; debug: any }
  | { kind: "warn"; title: string; message: string; reasonCodes: string[]; debug: any }
  | { kind: "block"; title: string; message: string; reasonCodes: string[]; debug: any };

const SAFETY_LOG_PREFIX = "[organize][safety]";

const MELBOURNE_CBD = { lat: -37.8136, lng: 144.9631 };

const AU_STATE_CODES = ["VIC", "NSW", "QLD", "SA", "WA", "TAS", "ACT", "NT"] as const;
const AU_STATE_REGEX = new RegExp(`\\b(?:${AU_STATE_CODES.join("|")})\\b`, "i");
const AU_POSTCODE_REGEX = /\b\d{4}\b/g;

const AMBIGUOUS_WARN_M = 5_000;
const AMBIGUOUS_STRONG_WARN_M = 50_000;
const CAPITAL_HINT_WARN_M = 80_000;
const CAPITAL_HINT_STRONG_WARN_M = 250_000;

const CAPITAL_HINTS: Array<{ name: string; lat: number; lng: number }> = [
  { name: "Melbourne", lat: MELBOURNE_CBD.lat, lng: MELBOURNE_CBD.lng },
  { name: "Sydney", lat: -33.8688, lng: 151.2093 },
  { name: "Brisbane", lat: -27.4698, lng: 153.0251 },
  { name: "Adelaide", lat: -34.9285, lng: 138.6007 },
  { name: "Perth", lat: -31.9523, lng: 115.8613 },
  { name: "Hobart", lat: -42.8821, lng: 147.3272 },
  { name: "Canberra", lat: -35.2809, lng: 149.13 },
  { name: "Darwin", lat: -12.4634, lng: 130.8456 },
];

const AU_STATE_NAME_TO_CODE: Record<string, (typeof AU_STATE_CODES)[number]> = {
  VICTORIA: "VIC",
  "NEW SOUTH WALES": "NSW",
  QUEENSLAND: "QLD",
  "SOUTH AUSTRALIA": "SA",
  "WESTERN AUSTRALIA": "WA",
  TASMANIA: "TAS",
  "AUSTRALIAN CAPITAL TERRITORY": "ACT",
  "NORTHERN TERRITORY": "NT",
};

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

function extractAddressStateCodeAU(address: string): (typeof AU_STATE_CODES)[number] | null {
  const m = address.match(AU_STATE_REGEX);
  if (!m) return null;
  const code = String(m[0] ?? "").trim().toUpperCase();
  return (AU_STATE_CODES as readonly string[]).includes(code) ? (code as (typeof AU_STATE_CODES)[number]) : null;
}

function extractAddressPostcodeAU(address: string): string | null {
  const all = Array.from(address.matchAll(AU_POSTCODE_REGEX)).map((m) => m[0]);
  return all.length > 0 ? all[all.length - 1] : null;
}

function normalizeReverseStateCode(regionLike: unknown): (typeof AU_STATE_CODES)[number] | null {
  const raw = String(regionLike ?? "").trim();
  if (!raw) return null;

  const up = raw.toUpperCase();

  if ((AU_STATE_CODES as readonly string[]).includes(up)) return up as (typeof AU_STATE_CODES)[number];

  const compact = up.replace(/\s+/g, " ").trim();
  if (AU_STATE_NAME_TO_CODE[compact]) return AU_STATE_NAME_TO_CODE[compact];

  const head = compact.split(",")[0]?.trim() ?? "";
  if (AU_STATE_NAME_TO_CODE[head]) return AU_STATE_NAME_TO_CODE[head];

  return null;
}

function extractReversePostcodeAU(postalCodeLike: unknown): string | null {
  const raw = String(postalCodeLike ?? "").trim();
  if (!raw) return null;
  const m = raw.match(/\b\d{4}\b/);
  return m ? m[0] : null;
}

function detectCapitalHint(address: string): { name: string; lat: number; lng: number } | null {
  const a = address.trim().toLowerCase();
  if (!a) return null;
  for (const c of CAPITAL_HINTS) {
    if (a.includes(c.name.toLowerCase())) return c;
  }
  return null;
}

function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return "-";
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  if (km < 10) return `${km.toFixed(2)} km`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

export async function runCreateLocationSafetyCheck(
  address: string,
  resolvedLat: number,
  resolvedLng: number,
  geocodeRawHint: Location.LocationGeocodedLocation[] | null
): Promise<CreateSafetyDecision> {
  const reasonCodes: string[] = [];
  const debug: any = {
    address,
    resolvedLat,
    resolvedLng,
  };

  const addrState = extractAddressStateCodeAU(address);
  const addrPostcode = extractAddressPostcodeAU(address);

  debug.addrState = addrState;
  debug.addrPostcode = addrPostcode;

  let capitalHintName: string | null = null;
  let capitalDistanceM: number | null = null;

  const cap = detectCapitalHint(address);
  if (cap) {
    capitalHintName = cap.name;
    capitalDistanceM = distanceMetersHaversine(cap.lat, cap.lng, resolvedLat, resolvedLng);
    debug.capitalHint = { name: cap.name, distM: capitalDistanceM };
    if (capitalDistanceM >= CAPITAL_HINT_STRONG_WARN_M) {
      reasonCodes.push("TOO_FAR");
    } else if (capitalDistanceM >= CAPITAL_HINT_WARN_M) {
      reasonCodes.push("TOO_FAR");
    }
  }

  let spreadDistanceM: number | null = null;
  let spreadUsedCount = 0;

  try {
    const raw = geocodeRawHint ?? (await Location.geocodeAsync(address));
    const validInOrder = (raw ?? [])
      .map((r) => {
        const latN = typeof (r as any).latitude === "number" ? (r as any).latitude : Number((r as any).latitude);
        const lngN = typeof (r as any).longitude === "number" ? (r as any).longitude : Number((r as any).longitude);
        if (!Number.isFinite(latN) || !Number.isFinite(lngN)) return null;
        if (!isValidLatLngRange(latN, lngN)) return null;
        return { lat: latN, lng: lngN };
      })
      .filter((x): x is { lat: number; lng: number } => !!x);

    spreadUsedCount = validInOrder.length;

    if (validInOrder.length >= 3) {
      spreadDistanceM = distanceMetersHaversine(
        validInOrder[0].lat,
        validInOrder[0].lng,
        validInOrder[2].lat,
        validInOrder[2].lng
      );
      debug.candidateSpread = {
        usedCount: validInOrder.length,
        d13m: spreadDistanceM,
        top3: validInOrder.slice(0, 3).map((v) => ({
          lat: Number(v.lat.toFixed(6)),
          lng: Number(v.lng.toFixed(6)),
        })),
      };

      if (spreadDistanceM >= AMBIGUOUS_STRONG_WARN_M) {
        reasonCodes.push("AMBIGUOUS");
      } else if (spreadDistanceM >= AMBIGUOUS_WARN_M) {
        reasonCodes.push("AMBIGUOUS");
      }
    } else {
      debug.candidateSpread = { usedCount: validInOrder.length };
    }
  } catch (e: any) {
    debug.candidateSpreadError = e?.message ?? String(e);
  }

  let reverse: Location.LocationGeocodedAddress | null = null;
  let reverseError: string | null = null;

  try {
    const rev = await Location.reverseGeocodeAsync({ latitude: resolvedLat, longitude: resolvedLng });
    reverse = (rev?.[0] as any) ?? null;
  } catch (e: any) {
    reverseError = e?.message ?? String(e);
  }

  if (!reverse) {
    reasonCodes.push("REVERSE_UNAVAILABLE");
    debug.reverse = null;
    debug.reverseError = reverseError ?? "No reverse results";
  } else {
    const isoCountry = String((reverse as any)?.isoCountryCode ?? "").trim().toUpperCase();
    const country = String((reverse as any)?.country ?? "").trim();
    const region = String((reverse as any)?.region ?? (reverse as any)?.subregion ?? "").trim();
    const postalCode = String((reverse as any)?.postalCode ?? "").trim();
    const city = String((reverse as any)?.city ?? (reverse as any)?.district ?? "").trim();
    const name = String((reverse as any)?.name ?? "").trim();
    const street = String((reverse as any)?.street ?? "").trim();

    const revState = normalizeReverseStateCode(region);
    const revPostcode = extractReversePostcodeAU(postalCode);

    debug.reverse = {
      isoCountryCode: isoCountry || null,
      country: country || null,
      region: region || null,
      stateCode: revState,
      postalCode: revPostcode,
      city: city || null,
      name: name || null,
      street: street || null,
    };

    const countryLooksAU = (() => {
      if (isoCountry) return isoCountry === "AU";
      if (!country) return null;
      return country.toLowerCase().includes("australia");
    })();

    if (countryLooksAU === false) {
      reasonCodes.push("COUNTRY_NOT_AU");
      const lines: string[] = [];
      lines.push("The resolved location looks outside Australia.");
      lines.push("");
      lines.push(`Address: ${address}`);
      lines.push(`Resolved: ${resolvedLat.toFixed(6)}, ${resolvedLng.toFixed(6)}`);
      lines.push(`Reverse country: ${isoCountry || country || "(unknown)"}`);
      lines.push("");
      lines.push("Please open Google Maps, copy the FULL address, and paste it again.");
      lines.push("");
      lines.push("Open Google Maps → select the place → Share → Copy address → paste it here.");
      const msg = lines.join("\n");

      console.log(`${SAFETY_LOG_PREFIX} block COUNTRY_NOT_AU`, { reasonCodes, debug });

      return { kind: "block", title: "Location mismatch", message: msg, reasonCodes, debug };
    }

    if (addrState && revState && addrState !== revState) {
      reasonCodes.push("STATE_MISMATCH");
      const lines: string[] = [];
      lines.push("State mismatch between your address and the resolved coordinates.");
      lines.push("");
      lines.push(`Address: ${address}`);
      lines.push(`Address state: ${addrState}`);
      lines.push(`Reverse state: ${revState}`);
      lines.push(`Resolved: ${resolvedLat.toFixed(6)}, ${resolvedLng.toFixed(6)}`);
      lines.push("");
      lines.push("Please open Google Maps, copy the FULL address, and paste it again.");
      const msg = lines.join("\n");

      console.log(`${SAFETY_LOG_PREFIX} block STATE_MISMATCH`, { reasonCodes, debug });

      return { kind: "block", title: "Location mismatch", message: msg, reasonCodes, debug };
    }

    if (addrPostcode && revPostcode && addrPostcode !== revPostcode) {
      reasonCodes.push("POSTCODE_MISMATCH");
      const lines: string[] = [];
      lines.push("Postcode mismatch between your address and the resolved coordinates.");
      lines.push("");
      lines.push(`Address: ${address}`);
      lines.push(`Address postcode: ${addrPostcode}`);
      lines.push(`Reverse postcode: ${revPostcode}`);
      lines.push(`Resolved: ${resolvedLat.toFixed(6)}, ${resolvedLng.toFixed(6)}`);
      lines.push("");
      lines.push("Please open Google Maps, copy the FULL address, and paste it again.");
      const msg = lines.join("\n");

      console.log(`${SAFETY_LOG_PREFIX} block POSTCODE_MISMATCH`, { reasonCodes, debug });

      return { kind: "block", title: "Location mismatch", message: msg, reasonCodes, debug };
    }
  }

  const uniqueReasons = Array.from(new Set(reasonCodes));
  debug.reasonCodes = uniqueReasons;

  const shouldWarn = uniqueReasons.some((r) => r === "REVERSE_UNAVAILABLE" || r === "AMBIGUOUS" || r === "TOO_FAR");
  if (!shouldWarn) {
    console.log(`${SAFETY_LOG_PREFIX} ok`, { reasonCodes: uniqueReasons, debug });
    return { kind: "ok", reasonCodes: uniqueReasons, debug };
  }

  const lines: string[] = [];
  const hasStrongAmbiguous = spreadDistanceM !== null && spreadDistanceM >= AMBIGUOUS_STRONG_WARN_M;
  const hasStrongFar = capitalDistanceM !== null && capitalDistanceM >= CAPITAL_HINT_STRONG_WARN_M;

  const warnTitle = hasStrongAmbiguous || hasStrongFar ? "Verify location (important)" : "Verify location";
  lines.push("Please verify the resolved location before creating this event.");
  lines.push("");
  lines.push(`Address: ${address}`);
  lines.push(`Resolved: ${resolvedLat.toFixed(6)}, ${resolvedLng.toFixed(6)}`);

  if (capitalHintName && capitalDistanceM !== null) {
    lines.push(`Distance to ${capitalHintName}: ${formatDistance(capitalDistanceM)}`);
  }

  if (spreadDistanceM !== null) {
    lines.push(`Geocode candidate spread (1st↔3rd): ${formatDistance(spreadDistanceM)}`);
    lines.push(`Candidates used: ${spreadUsedCount}`);
  }

  const rev = debug.reverse as any;
  if (rev && typeof rev === "object") {
    const ctry = rev.isoCountryCode || rev.country || "(unknown)";
    const st = rev.stateCode || rev.region || "(unknown)";
    const pc = rev.postalCode || "(unknown)";
    lines.push(`Reverse: ${ctry}, ${st} ${pc}`);
  } else {
    lines.push("Reverse: unavailable (cannot validate state/postcode)");
  }

  lines.push("");
  lines.push(`Reason codes: ${uniqueReasons.join(", ")}`);

  const msg = lines.join("\n");

  console.log(`${SAFETY_LOG_PREFIX} warn`, { reasonCodes: uniqueReasons, debug });

  return { kind: "warn", title: warnTitle, message: msg, reasonCodes: uniqueReasons, debug };
}
