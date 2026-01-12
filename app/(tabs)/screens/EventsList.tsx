
//history screen

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  ToastAndroid,
  View,
  Linking,
  RefreshControl,
  TouchableOpacity,
  TextInput,
} from "react-native";
import { useRouter } from "expo-router";
import { supabase } from "../../../lib/supabase";
import { getEffectiveUserId } from "../../../stores/session";

// Common UI
import Card from "../../ui/Card";
import Button from "../../ui/Button";
import Pill from "../../ui/Pill";
import Tile from "../../ui/Tile";
import { COLORS, SPACING } from "@ui/theme";

// Timezone utils (venue-fixed rendering)
import { formatRangeInVenueTZ, maybeLocalHint } from "../../../src/utils/timezone";

import { useEffectiveRole, type Role } from "../../../stores/devRole";

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
  group_id: string | null;
  created_by?: string | null;
};

type GroupRow = { id: string; name: string | null };

type GroupMemberRow = {
  group_id: string;
  role: "organizer" | "member";
};

function normalizeInviteCode(raw: string): string {
  return String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

async function getSignedInUserId(): Promise<string | null> {
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) return null;
    const uid = data?.user?.id ?? null;
    return uid && uid.length > 0 ? uid : null;
  } catch {
    return null;
  }
}

function mapJoinErrorMessage(err: any): string {
  const msg = String(err?.message ?? err ?? "");

  if (msg.includes("not_authenticated")) return "Please sign in to join a group.";
  if (msg.includes("invalid_invite_code")) return "Please enter a valid invite code.";
  if (msg.includes("invite_code_not_found")) return "Invite code not found. Please check and try again.";

  return msg;
}

export default function EventsListScreen() {
  const router = useRouter();
  const role = useEffectiveRole();

  // NOTE: This holds the EFFECTIVE user id (session user if signed in, otherwise stable guest id)
  const [guestId, setGuestId] = useState<string>("");

  const [signedInUserId, setSignedInUserId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Join UI (Attendee)
  const [joinCode, setJoinCode] = useState("");
  const [joining, setJoining] = useState(false);

  // Chips (group filter)
  const [chipGroups, setChipGroups] = useState<GroupRow[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null); // null = All

  // All events fetched for this screen (client filters by selectedGroupId)
  const [events, setEvents] = useState<EventRow[]>([]);

  const now = useMemo(() => Date.now(), [loading, role]);

  const notify = (m: string) =>
    Platform.OS === "android" ? ToastAndroid.show(m, ToastAndroid.SHORT) : Alert.alert("Info", m);

  const fetchGroupsForChips = useCallback(async (signedUid: string | null, r: Role): Promise<GroupRow[]> => {
    if (!signedUid) return [];

    // Chips = groups in group_members (organizer: organizer-only, attendee: all memberships)
    const memQ = supabase.from("group_members").select("group_id, role").eq("user_id", signedUid);
    const memRes = r === "organizer" ? await memQ.eq("role", "organizer") : await memQ;

    if (memRes.error) throw memRes.error;

    const mems = (memRes.data ?? []) as GroupMemberRow[];
    const groupIds = Array.from(new Set(mems.map((m) => m.group_id))).filter(Boolean);

    if (groupIds.length === 0) return [];

    const gr = await supabase.from("groups").select("id, name").in("id", groupIds).order("name", { ascending: true });
    if (gr.error) throw gr.error;

    return (gr.data ?? []) as GroupRow[];
  }, []);

  const fetchEventsFor = useCallback(
    async (effectiveId: string, signedUid: string | null, r: Role, groupsForChips: GroupRow[]) => {
      console.log("[EventsList] fetchEventsFor start", {
        role: r,
        effectiveIdShort: effectiveId?.slice(0, 6),
        hasSignedIn: !!signedUid,
        chipGroups: groupsForChips.length,
      });

      // Organizer: created_by + attendance (unchanged behavior)
      if (r === "organizer") {
        const att = await supabase
          .from("attendance")
          .select("event_id")
          .eq("user_id", effectiveId)
          .order("checked_in_at_utc", { ascending: false })
          .limit(100);

        if (att.error) {
          console.log("[EventsList] attendance query error", att.error);
          throw att.error;
        }

        const attendedIds = Array.from(new Set((att.data ?? []).map((x: any) => x.event_id))).filter(Boolean) as string[];
        console.log("[EventsList] attendedIds", attendedIds.length);

        const cr = await supabase
          .from("events")
          .select("id,title,start_utc,end_utc,lat,lng,radius_m,window_minutes,location_name,group_id,created_by")
          .eq("created_by", effectiveId)
          .order("start_utc", { ascending: false })
          .limit(100);

        if (cr.error) {
          console.log("[EventsList] createdBy query error", cr.error);
          throw cr.error;
        }
        const created = (cr.data ?? []) as EventRow[];
        console.log("[EventsList] createdBy count", created.length);

        let attendedRows: EventRow[] = [];
        if (attendedIds.length > 0) {
          const ev = await supabase
            .from("events")
            .select("id,title,start_utc,end_utc,lat,lng,radius_m,window_minutes,location_name,group_id,created_by")
            .in("id", attendedIds)
            .limit(100);

          if (ev.error) {
            console.log("[EventsList] attended rows query error", ev.error);
            throw ev.error;
          }
          attendedRows = (ev.data ?? []) as EventRow[];
          console.log("[EventsList] attendedRows count", attendedRows.length);
        }

        const merged = dedupeById([...created, ...attendedRows]);
        console.log("[EventsList] merged (organizer) count", merged.length);
        return merged;
      }

      // Attendee: A plan = events in ALL groups the user belongs to (via group_members)
      if (signedUid && groupsForChips.length > 0) {
        const groupIds = groupsForChips.map((g) => g.id);

        const ev = await supabase
          .from("events")
          .select("id,title,start_utc,end_utc,lat,lng,radius_m,window_minutes,location_name,group_id,created_by")
          .in("group_id", groupIds)
          .order("start_utc", { ascending: false })
          .limit(200);

        if (ev.error) {
          console.log("[EventsList] attendee events-by-group query error", ev.error);
          throw ev.error;
        }

        const rows = (ev.data ?? []) as EventRow[];
        console.log("[EventsList] attendee events-by-group count", rows.length);
        return rows;
      }

      // Fallback (not signed in): attendance-only
      const att = await supabase
        .from("attendance")
        .select("event_id")
        .eq("user_id", effectiveId)
        .order("checked_in_at_utc", { ascending: false })
        .limit(100);

      if (att.error) {
        console.log("[EventsList] attendance fallback query error", att.error);
        throw att.error;
      }

      const attendedIds = Array.from(new Set((att.data ?? []).map((x: any) => x.event_id))).filter(Boolean) as string[];
      console.log("[EventsList] attendee fallback attendedIds", attendedIds.length);

      if (attendedIds.length === 0) return [];

      const ev = await supabase
        .from("events")
        .select("id,title,start_utc,end_utc,lat,lng,radius_m,window_minutes,location_name,group_id,created_by")
        .in("id", attendedIds)
        .limit(100);

      if (ev.error) {
        console.log("[EventsList] attendee fallback attended rows query error", ev.error);
        throw ev.error;
      }

      const rows = (ev.data ?? []) as EventRow[];
      console.log("[EventsList] attendee fallback attendedRows count", rows.length);
      return rows;
    },
    []
  );

  const initialLoad = useCallback(async () => {
    console.log("[EventsList] initialLoad start, role =", role);
    try {
      setLoading(true);
      setError(null);

      const effectiveId = await getEffectiveUserId();
      setGuestId(effectiveId);

      const signedUid = await getSignedInUserId();
      setSignedInUserId(signedUid);

      const groupsForChips = await fetchGroupsForChips(signedUid, role);
      setChipGroups(groupsForChips);

      const data = await fetchEventsFor(effectiveId, signedUid, role, groupsForChips);
      setEvents(data);

      const valid = selectedGroupId === null ? true : groupsForChips.some((g) => g.id === selectedGroupId);

      if (!valid) {
        setSelectedGroupId(groupsForChips.length > 0 ? groupsForChips[0].id : null);
      } else if (selectedGroupId === null && groupsForChips.length > 0) {
        setSelectedGroupId(groupsForChips[0].id);
      }

      console.log("[EventsList] initialLoad success", {
        chipGroups: groupsForChips.length,
        events: data.length,
      });
    } catch (e: any) {
      console.log("[EventsList] initialLoad error", e?.message ?? e);
      setError(e?.message ?? "Failed to load");
    } finally {
      setLoading(false);
      console.log("[EventsList] initialLoad done -> loading=false");
    }
  }, [role, fetchEventsFor, fetchGroupsForChips, selectedGroupId]);

  const onRefresh = useCallback(async () => {
    console.log("[EventsList] onRefresh, role =", role);
    try {
      setRefreshing(true);
      setError(null);

      const effectiveId = await getEffectiveUserId();
      setGuestId(effectiveId);

      const signedUid = await getSignedInUserId();
      setSignedInUserId(signedUid);

      const groupsForChips = await fetchGroupsForChips(signedUid, role);
      setChipGroups(groupsForChips);

      const data = await fetchEventsFor(effectiveId, signedUid, role, groupsForChips);
      setEvents(data);

      const stillValid = selectedGroupId === null ? true : groupsForChips.some((g) => g.id === selectedGroupId);

      if (!stillValid) {
        setSelectedGroupId(groupsForChips.length > 0 ? groupsForChips[0].id : null);
      }

      console.log("[EventsList] refresh success", { chipGroups: groupsForChips.length, events: data.length });
      notify("Refreshed");
    } catch (e: any) {
      console.log("[EventsList] refresh error", e?.message ?? e);
      setError(e?.message ?? "Failed to refresh");
    } finally {
      setRefreshing(false);
    }
  }, [role, fetchEventsFor, fetchGroupsForChips, selectedGroupId]);

  const joinByInviteCode = useCallback(async () => {
    if (joining) return;

    const cleaned = normalizeInviteCode(joinCode);

    if (!cleaned) {
      Alert.alert("Missing code", "Please enter an invite code.");
      return;
    }

    const signedUid = await getSignedInUserId();
    setSignedInUserId(signedUid);

    if (!signedUid) {
      Alert.alert("Not signed in", "Please sign in to join a group.");
      return;
    }

    try {
      setJoining(true);

      const { data, error: rpcErr } = await supabase.rpc("join_group_by_invite_code", { p_invite_code: cleaned });
      if (rpcErr) throw rpcErr;

      const row: any = Array.isArray(data) ? data[0] : data;
      const gid = row?.group_id ? String(row.group_id) : null;
      const gname = String(row?.group_name ?? "Group");
      const didJoin = !!row?.joined;

      notify(didJoin ? `Joined: ${gname}` : `Already joined: ${gname}`);
      setJoinCode("");

      const effectiveId = await getEffectiveUserId();
      setGuestId(effectiveId);

      const groupsForChips = await fetchGroupsForChips(signedUid, role);
      setChipGroups(groupsForChips);

      const evs = await fetchEventsFor(effectiveId, signedUid, role, groupsForChips);
      setEvents(evs);

      if (gid) setSelectedGroupId(gid);
    } catch (e: any) {
      Alert.alert("Join failed", mapJoinErrorMessage(e));
    } finally {
      setJoining(false);
    }
  }, [joining, joinCode, role, fetchGroupsForChips, fetchEventsFor]);

  useEffect(() => {
    console.log("[EventsList] mount or role changed. role =", role);
    initialLoad();
  }, [initialLoad]);

  const visibleEvents = useMemo(() => {
    if (!selectedGroupId) return events;
    return events.filter((e) => e.group_id === selectedGroupId);
  }, [events, selectedGroupId]);

  const { active, upcoming, past } = useMemo(() => {
    const nowMs = Date.now();
    const parse = (s: string | null) => (s ? Date.parse(s) : NaN);

    const act: EventRow[] = [];
    const up: EventRow[] = [];
    const pa: EventRow[] = [];

    for (const e of visibleEvents) {
      const ts = parse(e.start_utc);
      const te = parse(e.end_utc);
      if (Number.isNaN(ts) || Number.isNaN(te)) continue;
      if (ts <= nowMs && nowMs < te) act.push(e);
      else if (ts > nowMs) up.push(e);
      else pa.push(e);
    }

    act.sort((a, b) => Date.parse(a.start_utc!) - Date.parse(b.start_utc!));
    up.sort((a, b) => Date.parse(a.start_utc!) - Date.parse(b.start_utc!));
    pa.sort((a, b) => Date.parse(b.end_utc!) - Date.parse(a.end_utc!));

    const sliced = { active: act, upcoming: up, past: pa.slice(0, 20) };
    console.log("[EventsList] buckets", {
      selectedGroupId: selectedGroupId ?? "ALL",
      active: sliced.active.length,
      upcoming: sliced.upcoming.length,
      past: sliced.past.length,
    });
    return sliced;
  }, [visibleEvents, now, selectedGroupId]);

  const counts = useMemo(
    () => ({
      active: active.length,
      upcoming: upcoming.length,
      past: past.length,
    }),
    [active, upcoming, past]
  );

  const selectedGroupName = useMemo(() => {
    if (!selectedGroupId) return "All";
    const g = chipGroups.find((x) => x.id === selectedGroupId);
    return (g?.name ?? "").trim() || "Group";
  }, [chipGroups, selectedGroupId]);

  if (loading) {
    console.log("[EventsList] render loading spinner");
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  console.log("[EventsList] render content", { error: !!error, counts, effectiveIdShort: guestId?.slice(0, 6) });

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: 28 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <Text style={styles.header}>History</Text>

      <View style={styles.tilesRow}>
        <Tile label="Active" value={counts.active} style={{ flex: 1, minWidth: 0 }} />
        <Tile label="Upcoming" value={counts.upcoming} style={{ flex: 1, minWidth: 0 }} />
        <Tile label="Past" value={counts.past} style={{ flex: 1, minWidth: 0 }} />
      </View>

      {error ? (
        <Card variant="soft" style={{ borderColor: COLORS.danger }}>
          <Text style={{ color: COLORS.danger }}>Error: {error}</Text>
        </Card>
      ) : null}

      <Text style={styles.hint}>
        {role === "organizer"
          ? "History shows events you created (as the current account) and events you checked into."
          : "History shows events in your groups (and a fallback to attended events if not signed in)."}
      </Text>

      {role !== "organizer" ? (
        <Card style={{ marginBottom: 10 }}>
          <Text style={styles.joinTitle}>Join a group</Text>

          {signedInUserId ? (
            <>
              <Text style={styles.joinLabel}>Invite code</Text>
              <TextInput
                value={joinCode}
                onChangeText={(t) => setJoinCode(normalizeInviteCode(t))}
                placeholder="e.g. ABCD2345"
                placeholderTextColor={COLORS.textMuted}
                style={styles.joinInput}
                autoCapitalize="characters"
                autoCorrect={false}
                editable={!joining}
              />
              <View style={{ height: 10 }} />
              <Button title={joining ? "Joining..." : "Join"} onPress={joinByInviteCode} fullWidth />
              <View style={{ height: 8 }} />
              <Text style={styles.joinHint}>
                After joining, your group will appear in the chips and events will load automatically.
              </Text>
            </>
          ) : (
            <Text style={styles.joinHint}>Sign in to join a group with an invite code.</Text>
          )}
        </Card>
      ) : null}

      {chipGroups.length > 0 ? (
        <View style={{ marginBottom: 10 }}>
          <Text style={styles.filterLabel}>Group filter</Text>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
            <TouchableOpacity
              onPress={() => setSelectedGroupId(null)}
              style={[styles.chip, selectedGroupId === null && styles.chipActive]}
            >
              <Text style={[styles.chipText, selectedGroupId === null && styles.chipTextActive]}>All</Text>
            </TouchableOpacity>

            {chipGroups.map((g) => {
              const isActive = selectedGroupId === g.id;
              return (
                <TouchableOpacity
                  key={g.id}
                  onPress={() => setSelectedGroupId(g.id)}
                  style={[styles.chip, isActive && styles.chipActive]}
                >
                  <Text style={[styles.chipText, isActive && styles.chipTextActive]}>{g.name ?? "(Untitled group)"}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <View style={{ height: 8 }} />

          <Card variant="soft" style={{ paddingVertical: 10 }}>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <Text style={{ color: COLORS.textMuted }}>Showing: </Text>
              <Text style={{ color: COLORS.text, fontWeight: "800" }}>{selectedGroupName}</Text>
            </View>
          </Card>
        </View>
      ) : null}

      {section("ACTIVE", active, "success", role, router)}
      {section("UPCOMING", upcoming, "info", role, router)}
      {section("PAST", past, "neutral", role, router)}

      {active.length + upcoming.length + past.length === 0 ? (
        <Card style={{ marginTop: 8 }}>
          <Text style={styles.help}>
            {role === "organizer"
              ? selectedGroupId
                ? "No events for this group yet. Create an event in this group, or check in to see it here."
                : "No history yet. Create an event or check in to see it here."
              : selectedGroupId
              ? "No events for this group yet."
              : "No events yet."}
          </Text>
          <View style={{ height: 8 }} />
          <Button title="Go To Organize" onPress={() => router.push("/organize")} />
        </Card>
      ) : null}
    </ScrollView>
  );
}

function mapsUrl(lat: number, lng: number, label?: string | null) {
  const q = encodeURIComponent(label ? `${label} @ ${lat},${lng}` : `${lat},${lng}`);
  return `https://maps.google.com/?q=${q}`;
}
function embedUrl(lat: number, lng: number) {
  return `https://www.google.com/maps?q=${lat},${lng}&z=15&output=embed`;
}

function dedupeById(list: EventRow[]) {
  const map = new Map<string, EventRow>();
  for (const e of list) {
    if (!e?.id) continue;
    map.set(e.id, e);
  }
  return Array.from(map.values());
}

function section(
  title: "ACTIVE" | "UPCOMING" | "PAST",
  rows: EventRow[],
  pillVariant: "success" | "info" | "neutral",
  role: Role,
  router: ReturnType<typeof useRouter>
) {
  if (rows.length === 0) return null;

  console.log("[EventsList] render section", title, "rows", rows.length);

  return (
    <Card style={{ marginTop: SPACING.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
        <Text style={styles.cardTitle}>{title}</Text>
        <View style={{ flex: 1 }} />
        <Pill text={title === "ACTIVE" ? "Active" : title === "UPCOMING" ? "Upcoming" : "Past"} variant={pillVariant} tone="soft" />
      </View>

      {rows.map((e) => {
        const hasTimes = !!e.start_utc && !!e.end_utc;
        const when = hasTimes ? formatRangeInVenueTZ(e.start_utc!, e.end_utc!) : "—";
        const local = hasTimes ? maybeLocalHint(e.start_utc!) : null;

        return (
          <Card key={e.id} style={{ marginTop: 10 }}>
            <Text style={styles.eventTitle}>{e.title ?? "(Untitled event)"}</Text>
            <Text style={styles.meta}>{when}</Text>
            {local ? <Text style={styles.metaSmall}>{local}</Text> : null}

            <Text style={styles.metaSmall}>
              radius {e.radius_m ?? 0}m • window ±{e.window_minutes ?? 0}m
            </Text>

            {e.lat != null && e.lng != null ? (
              Platform.OS === "web" ? (
                <View style={styles.mapBox}>
                  {/* @ts-ignore */}
                  <iframe src={embedUrl(e.lat, e.lng)} width="100%" height="160" style={{ border: 0, borderRadius: 12 }} loading="lazy" />
                </View>
              ) : (
                <View style={{ marginTop: 10 }}>
                  <Button title="Open In Google Maps" onPress={() => Linking.openURL(mapsUrl(e.lat!, e.lng!, e.location_name))} />
                </View>
              )
            ) : null}

            {role === "organizer" ? (
              <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
                <View style={{ flex: 1 }}>
                  <Button
                    title="Open Detail"
                    onPress={() => {
                      console.log("[EventsList] nav -> detail", e.id);
                      router.push(`/organize/events/${e.id}`);
                    }}
                    fullWidth
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    title="check in rank"
                    onPress={() => {
                      console.log("[EventsList] nav -> live", e.id);
                      router.push(`/organize/events/${e.id}/live`);
                    }}
                    fullWidth
                  />
                </View>
              </View>
            ) : (
              <View style={{ marginTop: 12 }}>
                <Button
                  title="Open Detail"
                  onPress={() => {
                    console.log("[EventsList] nav -> detail (attendee)", e.id);
                    router.push(`/events/${e.id}`);
                  }}
                />
              </View>
            )}
          </Card>
        );
      })}
    </Card>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: COLORS.bg,
  },
  container: {
    flex: 1,
    paddingTop: 16,
    paddingHorizontal: 16,
    backgroundColor: COLORS.bg,
  },
  header: {
    fontSize: 22,
    fontWeight: "800",
    marginBottom: 10,
    color: COLORS.text,
  },
  hint: { color: COLORS.textMuted, marginBottom: 8 },

  tilesRow: {
    flexDirection: "row",
    gap: SPACING.md,
    marginBottom: SPACING.md,
  },

  joinTitle: { fontSize: 14, fontWeight: "900", color: COLORS.text, marginBottom: 10 },
  joinLabel: { color: COLORS.textMuted, fontSize: 12, fontWeight: "800", marginBottom: 8 },
  joinInput: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: COLORS.text,
    backgroundColor: "#FFFFFF",
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 1,
  },
  joinHint: { color: COLORS.textMuted, fontSize: 12 },

  filterLabel: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: "800",
    marginBottom: 8,
  },
  chipsRow: {
    gap: 10,
    paddingRight: 6,
  },
  chip: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: "#FFFFFF",
  },
  chipActive: {
    backgroundColor: COLORS.text,
    borderColor: COLORS.text,
  },
  chipText: {
    color: COLORS.text,
    fontWeight: "800",
    fontSize: 13,
  },
  chipTextActive: {
    color: "#FFFFFF",
  },

  cardTitle: { fontSize: 14, fontWeight: "800", color: COLORS.text },
  eventTitle: { fontWeight: "800", marginBottom: 2, color: COLORS.text },
  meta: { color: COLORS.textMuted },
  metaSmall: { color: COLORS.textSubtle, fontSize: 12 },
  help: { color: COLORS.textMuted, textAlign: "center" },

  mapBox: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    overflow: "hidden",
  },
});
