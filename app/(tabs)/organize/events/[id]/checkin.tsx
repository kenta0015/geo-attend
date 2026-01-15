/// app/(tabs)/organize/events/[id]/checkin.tsx
import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  Pressable,
  ActivityIndicator,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Image,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import Card from "../../../../ui/Card";
import Button from "../../../../ui/Button";
import { COLORS, SPACING, RADIUS } from "@ui/theme";
import { supabase } from "../../../../../lib/supabase";
import { RSVP } from "../../../../../lib/types";
import getAvatarSignedUrl from "../../../../../lib/avatarUrl";

type Filter = "all" | "going" | "not_going";

type ListItem = {
  user_id: string;
  name: string;
  rsvp_status: RSVP;
  checked_in_at_utc?: string | null;
  avatar_url?: string | null;
};

const PAGE_SIZE = 100;

// strict UUID v4-ish validator (accepts canonical 8-4-4-4-12 hex)
function isUuid(v: string | null | undefined): v is string {
  if (!v) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v)
  );
}

export default function CheckinScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const eventId = (id ?? "").toString();

  const [filter, setFilter] = useState<Filter>("going");
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const [items, setItems] = useState<ListItem[]>([]);
  const [goingCount, setGoingCount] = useState(0);
  const [presentCount, setPresentCount] = useState(0);
  const [unansweredCount, setUnansweredCount] = useState(0);
  const [memberTotalCount, setMemberTotalCount] = useState(0);
  const offsetRef = useRef(0);

  const avatarUrlByUserIdRef = useRef<Map<string, string | null>>(new Map());
  const avatarPathByUserIdRef = useRef<Map<string, string | null>>(new Map());

  const [nameModalOpen, setNameModalOpen] = useState(false);
  const [editUserId, setEditUserId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);

  const [unansweredOpen, setUnansweredOpen] = useState(false);

  const hasMore = offsetRef.current < memberTotalCount;

  const goingAll = useMemo(
    () => items.filter((x) => x.rsvp_status === "going"),
    [items]
  );
  const goingChecked = useMemo(
    () => goingAll.filter((x) => !!x.checked_in_at_utc),
    [goingAll]
  );
  const goingNotChecked = useMemo(
    () => goingAll.filter((x) => !x.checked_in_at_utc),
    [goingAll]
  );
  const notGoingAll = useMemo(
    () => items.filter((x) => x.rsvp_status === "not_going"),
    [items]
  );
  const unansweredAll = useMemo(
    () => items.filter((x) => x.rsvp_status === null),
    [items]
  );

  const filtered = useMemo(() => {
    const goingCheckedSorted = [...goingChecked].sort((a, b) =>
      (b.checked_in_at_utc ?? "").localeCompare(a.checked_in_at_utc ?? "")
    );
    const goingNotCheckedSorted = [...goingNotChecked].sort((a, b) =>
      (a.name || "").localeCompare(b.name || "")
    );
    const notGoingSorted = [...notGoingAll].sort((a, b) =>
      (a.name || "").localeCompare(b.name || "")
    );

    if (filter === "going")
      return [...goingCheckedSorted, ...goingNotCheckedSorted];
    if (filter === "not_going") return notGoingSorted;
    return [...goingCheckedSorted, ...goingNotCheckedSorted, ...notGoingSorted];
  }, [filter, goingChecked, goingNotChecked, notGoingAll]);

  const onRefresh = useCallback(async () => {
    if (!eventId) return;
    setRefreshing(true);
    offsetRef.current = 0;
    await Promise.all([fetchCounts(eventId), loadPage(eventId, true)]);
    setRefreshing(false);
  }, [eventId]);

  useEffect(() => {
    if (!eventId) return;
    setFilter("going");
    didFallbackRef.current = false;

    (async () => {
      setLoading(true);
      offsetRef.current = 0;
      await Promise.all([fetchCounts(eventId), loadPage(eventId, true)]);
      setLoading(false);
    })();
  }, [eventId]);

  const loadMore = useCallback(async () => {
    if (!eventId || loadingMore || !hasMore) return;
    setLoadingMore(true);
    await loadPage(eventId, false);
    setLoadingMore(false);
  }, [eventId, loadingMore, hasMore]);

  const renderItem = useCallback(({ item }: { item: ListItem }) => {
    const when =
      item.checked_in_at_utc &&
      new Date(item.checked_in_at_utc).toLocaleString();
    const missingName = !item.name || item.name === "(No name)";

    return (
      <Card style={styles.card}>
        <View style={styles.row}>
          <View style={{ flex: 1, paddingRight: SPACING.sm }}>
            <View style={styles.nameLine}>
              <View style={styles.nameLeft}>
                <AvatarThumb
                  uri={item.avatar_url ?? null}
                  name={item.name || "(No name)"}
                  size={28}
                />
                <Text style={styles.name} numberOfLines={1}>
                  {item.name || "(No name)"}
                </Text>
              </View>
              {item.rsvp_status !== null ? (
                <LocalPill
                  label={item.rsvp_status === "going" ? "Going" : "Not going"}
                  tone={item.rsvp_status === "going" ? "info" : "muted"}
                />
              ) : (
                <LocalPill label="Unanswered" tone="idle" />
              )}
            </View>
            <Text style={styles.sub}>
              {item.checked_in_at_utc ? `Checked in: ${when}` : "Not checked-in"}
            </Text>
          </View>
          <LocalPill
            label={item.checked_in_at_utc ? "Checked in" : "Not checked-in"}
            tone={item.checked_in_at_utc ? "success" : "idle"}
          />
        </View>

        {missingName && (
          <View style={{ marginTop: SPACING.md }}>
            <Button
              title="Add name"
              onPress={() => openNameModal(item.user_id, item.name)}
            />
            <Text style={styles.hint}>
              Set attendee name and phone for roster clarity.
            </Text>
          </View>
        )}
      </Card>
    );
  }, []);

  const keyExtractor = useCallback((x: ListItem) => `${x.user_id}`, []);

  const goingCountDerived = useMemo(() => goingAll.length, [goingAll.length]);
  const notGoingCountDerived = useMemo(
    () => notGoingAll.length,
    [notGoingAll.length]
  );
  const allCountDerived = useMemo(
    () => goingAll.length + notGoingAll.length,
    [goingAll.length, notGoingAll.length]
  );

  const didFallbackRef = useRef(false);
  useEffect(() => {
    if (
      !loading &&
      filter === "going" &&
      goingCount === 0 &&
      !didFallbackRef.current
    ) {
      setFilter("all");
      didFallbackRef.current = true;
    }
  }, [loading, filter, goingCount]);

  return (
    <View style={styles.container}>
      <Header
        eventId={eventId || "-"}
        goingCount={goingCount}
        presentCount={presentCount}
        unansweredCount={unansweredCount}
        onPressUnanswered={() => setUnansweredOpen(true)}
      />

      <Segmented
        value={filter}
        onChange={setFilter}
        counters={{
          going: goingCountDerived,
          notGoing: notGoingCountDerived,
          all: allCountDerived,
        }}
      />

      {loading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator />
          <Text style={styles.loadingText}>Loading…</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              No participants to show yet. Pull to refresh.
            </Text>
          }
          ListFooterComponent={
            hasMore ? (
              <View style={styles.footer}>
                <Button
                  title={loadingMore ? "Loading…" : "Load more"}
                  onPress={loadMore}
                  disabled={loadingMore}
                />
              </View>
            ) : (
              <View style={styles.footerSpace} />
            )
          }
        />
      )}

      <EditNameModal
        visible={nameModalOpen}
        saving={savingProfile}
        name={editName}
        phone={editPhone}
        onChangeName={setEditName}
        onChangePhone={setEditPhone}
        onCancel={() => {
          setNameModalOpen(false);
          setEditUserId(null);
          setEditName("");
          setEditPhone("");
        }}
        onSave={saveNamePhone}
      />

      <UnansweredModal
        visible={unansweredOpen}
        onClose={() => setUnansweredOpen(false)}
        items={unansweredAll}
      />
    </View>
  );

  function openNameModal(uid: string, currentName: string) {
    setEditUserId(uid);
    setEditName(currentName && currentName !== "(No name)" ? currentName : "");
    setEditPhone("");
    setNameModalOpen(true);
  }

  // --- optimized counts (gps/qr only for present) ---
  async function fetchCounts(evId: string) {
    const [goingMeta, presentMeta, membersMeta, unansweredMeta] =
      await Promise.all([
        supabase
          .from("event_members")
          .select("user_id", { head: true, count: "exact" })
          .eq("event_id", evId)
          .eq("rsvp_status", "going"),
        supabase
          .from("attendance")
          .select("user_id", { head: true, count: "exact" })
          .eq("event_id", evId)
          .in("method", ["gps", "qr"]),
        supabase
          .from("event_members")
          .select("user_id", { head: true, count: "exact" })
          .eq("event_id", evId),
        supabase
          .from("event_members")
          .select("user_id", { head: true, count: "exact" })
          .eq("event_id", evId)
          .is("rsvp_status", null),
      ]);

    if (typeof goingMeta.count === "number") setGoingCount(goingMeta.count ?? 0);
    if (typeof presentMeta.count === "number")
      setPresentCount(presentMeta.count ?? 0);
    if (typeof membersMeta.count === "number")
      setMemberTotalCount(membersMeta.count ?? 0);
    if (typeof unansweredMeta.count === "number")
      setUnansweredCount(unansweredMeta.count ?? 0);
  }

  async function loadPage(evId: string, replace: boolean) {
    const start = offsetRef.current;
    const end = start + PAGE_SIZE - 1;

    // page through members (paginated source)
    const { data: memberRowsRaw } = await supabase
      .from("event_members")
      .select("user_id,rsvp_status")
      .eq("event_id", evId)
      .order("user_id", { ascending: true })
      .range(start, end);

    const memberRows =
      (memberRowsRaw as { user_id: string; rsvp_status: RSVP }[] | null) ?? [];
    const memberIds: string[] = memberRows
      .map((r) => String(r.user_id))
      .filter((v): v is string => !!v);

    const rsvpMap = new Map<string, RSVP>();
    memberRows.forEach((r) => {
      rsvpMap.set(String(r.user_id), (r.rsvp_status ?? null) as RSVP);
    });

    // attendees (ids only; include walk-ins)
    const { data: attOnlyIdsRaw } = await supabase
      .from("attendance")
      .select("user_id")
      .eq("event_id", evId)
      .in("method", ["gps", "qr"]);

    const attendeeIds: string[] =
      ((attOnlyIdsRaw as { user_id: string }[] | null) ?? [])
        .map((r) => String(r.user_id))
        .filter((v): v is string => !!v);

    const combinedIds: string[] = Array.from(
      new Set<string>([...memberIds, ...attendeeIds])
    );
    if (combinedIds.length === 0) {
      if (replace) {
        setItems([]);
        offsetRef.current = 0;
      }
      return;
    }

    // --- profiles (user_profile.user_id is TEXT so combinedIds can be used as-is) ---
    const { data: profileRowsRaw } = await supabase
      .from("user_profile")
      .select("user_id, display_name, ice_name, avatar_path")
      .in("user_id", combinedIds);

    const profileRows =
      (profileRowsRaw as {
        user_id: string;
        display_name: string | null;
        ice_name: string | null;
        avatar_path: string | null;
      }[] | null) ?? [];

    const nameMap = new Map<string, string>();
    profileRows.forEach((p) => {
      const bestName = (p.display_name ?? p.ice_name ?? "").trim();
      nameMap.set(String(p.user_id), bestName);
    });

    // --- avatar signed URLs (cache per user_id + avatar_path; fallback to initials when missing) ---
    const toFetch: { uid: string; path: string | null }[] = [];
    profileRows.forEach((p) => {
      const uid = String(p.user_id);
      const path = (p.avatar_path ?? null) as string | null;

      const prevPath = avatarPathByUserIdRef.current.get(uid) ?? null;
      const hasUrl = avatarUrlByUserIdRef.current.has(uid);

      if (!hasUrl || prevPath !== path) {
        toFetch.push({ uid, path });
      }
    });

    if (toFetch.length > 0) {
      await Promise.all(
        toFetch.map(async ({ uid, path }) => {
          const url = await getAvatarSignedUrl(path);
          avatarPathByUserIdRef.current.set(uid, path);
          avatarUrlByUserIdRef.current.set(uid, url);
        })
      );
    }

    // --- attendance timestamps (only pass UUIDs to IN; limited to gps+qr) ---
    const uuidOnly = combinedIds.filter(isUuid);
    let attMap = new Map<string, string | null>();
    if (uuidOnly.length > 0) {
      const { data: attRowsRaw } = await supabase
        .from("attendance")
        .select("user_id,checked_in_at_utc")
        .eq("event_id", evId)
        .in("method", ["gps", "qr"])
        .in("user_id", uuidOnly);

      const attRows =
        (attRowsRaw as {
          user_id: string;
          checked_in_at_utc: string | null;
        }[] | null) ?? [];

      // latest timestamp per user (client-side reduce)
      attMap = attRows.reduce<Map<string, string | null>>((map, row) => {
        const uid = String(row.user_id);
        const prev = map.get(uid);
        const cur = row.checked_in_at_utc ?? null;
        if (!prev) {
          map.set(uid, cur);
        } else if (cur && prev) {
          map.set(uid, cur > prev ? cur : prev);
        }
        return map;
      }, new Map());
    }

    const pageItems: ListItem[] = combinedIds.map((uid) => ({
      user_id: uid,
      name: (nameMap.get(uid) ?? "").trim() || "(No name)",
      rsvp_status: rsvpMap.get(uid) ?? null,
      checked_in_at_utc: attMap.get(uid) ?? null,
      avatar_url: avatarUrlByUserIdRef.current.get(uid) ?? null,
    }));

    setItems((prev) => {
      const merged = mergeItemsNonNullWins(replace ? [] : prev, pageItems);
      offsetRef.current = replace
        ? memberIds.length
        : offsetRef.current + memberIds.length;
      return merged;
    });
  }

  async function saveNamePhone() {
    if (!editUserId) return;
    const trimmedName = editName.trim();
    const trimmedPhone = editPhone.trim();

    setSavingProfile(true);
    const payload: Record<string, unknown> = {
      user_id: String(editUserId), // user_profile.user_id is text
      ice_phone: trimmedPhone || null,
    };

    if (trimmedName) {
      // Keep both fields in sync so older data (ice_name) and newer data (display_name) show consistently.
      payload.display_name = trimmedName;
      payload.ice_name = trimmedName;
    }

    const { error } = await supabase
      .from("user_profile")
      .upsert([payload], { onConflict: "user_id" });

    setSavingProfile(false);
    if (!error) {
      setItems((prev) =>
        prev.map((it) =>
          it.user_id === editUserId
            ? { ...it, name: trimmedName ? trimmedName : it.name }
            : it
        )
      );
      setNameModalOpen(false);
      setEditUserId(null);
      setEditName("");
      setEditPhone("");
    }
  }
}

function Header(props: {
  eventId: string;
  goingCount: number;
  presentCount: number;
  unansweredCount: number;
  onPressUnanswered: () => void;
}) {
  const showUnanswered = props.unansweredCount > 0;
  return (
    <View style={styles.header}>
      <Text style={styles.title}>Check-in list</Text>
      <Text style={styles.meta}>Event ID: {props.eventId}</Text>

      <View style={styles.counters}>
        <Counter label="Going" value={props.goingCount} />
        <Counter label="Checked-in" value={props.presentCount} />
      </View>

      {showUnanswered && (
        <Pressable
          onPress={props.onPressUnanswered}
          style={styles.unansweredChip}
        >
          <Text style={styles.unansweredChipText}>
            Unanswered ({props.unansweredCount})
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.counterBox}>
      <Text style={styles.counterValue}>{value}</Text>
      <Text style={styles.counterLabel}>{label}</Text>
    </View>
  );
}

function Segmented(props: {
  value: Filter;
  onChange: (v: Filter) => void;
  counters: { going: number; notGoing: number; all: number };
}) {
  return (
    <View style={styles.segment}>
      <SegmentBtn
        active={props.value === "going"}
        label={`Going (${props.counters.going})`}
        onPress={() => props.onChange("going")}
      />
      <SegmentBtn
        active={props.value === "not_going"}
        label={`Not going (${props.counters.notGoing})`}
        onPress={() => props.onChange("not_going")}
      />
      <SegmentBtn
        active={props.value === "all"}
        label={`All (${props.counters.all})`}
        onPress={() => props.onChange("all")}
      />
    </View>
  );
}

function SegmentBtn({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.segmentBtn,
        active ? styles.segmentBtnActive : styles.segmentBtnIdle,
      ]}
    >
      <Text style={active ? styles.segmentTextActive : styles.segmentTextIdle}>
        {label}
      </Text>
    </Pressable>
  );
}

function LocalPill({
  label,
  tone,
}: {
  label: string;
  tone: "success" | "info" | "muted" | "idle";
}) {
  const infoBg = (COLORS as any).infoBg ?? "#E8EDFF";
  const bg =
    tone === "success"
      ? COLORS.success
      : tone === "info"
      ? infoBg
      : tone === "muted"
      ? COLORS.border
      : COLORS.border;
  const fg =
    tone === "success"
      ? COLORS.primaryTextOn
      : tone === "info"
      ? COLORS.text
      : COLORS.text;
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={[styles.pillText, { color: fg }]}>{label}</Text>
    </View>
  );
}

function AvatarThumb(props: {
  uri: string | null;
  name: string;
  size?: number;
}) {
  const size = props.size ?? 28;
  const initials = useMemo(() => {
    const raw = (props.name || "").trim();
    if (!raw || raw === "(No name)" || raw.startsWith("(")) return "?";

    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const a = parts[0].slice(0, 1);
      const b = parts[1].slice(0, 1);
      return `${a}${b}`.toUpperCase();
    }

    return raw.slice(0, 1).toUpperCase();
  }, [props.name]);

  return (
    <View
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: size / 2 },
      ]}
    >
      {props.uri ? (
        <Image
          source={{ uri: props.uri }}
          style={{ width: size, height: size, borderRadius: size / 2 }}
        />
      ) : (
        <Text style={styles.avatarText}>{initials}</Text>
      )}
    </View>
  );
}

function EditNameModal(props: {
  visible: boolean;
  saving: boolean;
  name: string;
  phone: string;
  onChangeName: (v: string) => void;
  onChangePhone: (v: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const canSave = props.name.trim().length > 0 || props.phone.trim().length > 0;

  return (
    <Modal visible={props.visible} animationType="slide" transparent>
      <KeyboardAvoidingView
        behavior={Platform.select({ ios: "padding", android: undefined })}
        style={styles.modalWrap}
      >
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Add attendee details</Text>

          <Text style={styles.inputLabel}>Name</Text>
          <TextInput
            value={props.name}
            onChangeText={props.onChangeName}
            placeholder="e.g., John Smith"
            placeholderTextColor={COLORS.text + "99"}
            style={styles.input}
          />

          <Text style={styles.inputLabel}>Phone (optional)</Text>
          <TextInput
            value={props.phone}
            onChangeText={props.onChangePhone}
            placeholder="e.g., 0400 000 000"
            placeholderTextColor={COLORS.text + "99"}
            keyboardType="phone-pad"
            style={styles.input}
          />

          <View style={styles.modalButtons}>
            <Button title="Cancel" onPress={props.onCancel} />
            <View style={{ width: SPACING.sm }} />
            <Button
              title={props.saving ? "Saving…" : "Save"}
              onPress={props.onSave}
              disabled={!canSave || props.saving}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function UnansweredModal(props: {
  visible: boolean;
  onClose: () => void;
  items: ListItem[];
}) {
  return (
    <Modal visible={props.visible} animationType="slide" transparent>
      <View style={styles.modalWrap}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Unanswered</Text>
          {props.items.length === 0 ? (
            <Text style={styles.empty}>No unanswered participants.</Text>
          ) : (
            <View style={{ maxHeight: 420 }}>
              <FlatList
                data={[...props.items].sort((a, b) =>
                  (a.name || "").localeCompare(b.name || "")
                )}
                keyExtractor={(x) => x.user_id}
                renderItem={({ item }) => (
                  <View style={styles.unItem}>
                    <Text style={styles.name} numberOfLines={1}>
                      {item.name || "(No name)"}
                    </Text>
                    <Text style={styles.sub}>
                      {item.checked_in_at_utc ? "Checked in" : "Not checked-in"}
                    </Text>
                  </View>
                )}
              />
            </View>
          )}
          <View style={styles.modalButtons}>
            <Button title="Close" onPress={props.onClose} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function mergeItemsNonNullWins(prev: ListItem[], next: ListItem[]): ListItem[] {
  const map = new Map<string, ListItem>();
  for (const it of prev) map.set(it.user_id, it);

  for (const it of next) {
    const existing = map.get(it.user_id);
    if (!existing) {
      map.set(it.user_id, it);
      continue;
    }
    const merged: ListItem = {
      user_id: it.user_id,
      name: it.name && it.name !== "(No name)" ? it.name : existing.name,
      rsvp_status:
        it.rsvp_status !== null ? it.rsvp_status : existing.rsvp_status,
      checked_in_at_utc:
        it.checked_in_at_utc ?? existing.checked_in_at_utc ?? null,
      avatar_url: it.avatar_url ?? existing.avatar_url ?? null,
    };
    map.set(it.user_id, merged);
  }
  return Array.from(map.values());
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },

  header: {
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.lg,
    paddingBottom: SPACING.md,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    color: COLORS.text,
    marginBottom: SPACING.xs,
  },
  meta: { fontSize: 12, color: COLORS.text, opacity: 0.7 },

  counters: { flexDirection: "row", gap: SPACING.md, marginTop: SPACING.md },
  counterBox: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    backgroundColor: COLORS.cardBg,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: "center",
    justifyContent: "center",
  },
  counterValue: { fontSize: 18, fontWeight: "700", color: COLORS.text },
  counterLabel: { fontSize: 12, color: COLORS.text, opacity: 0.7 },

  unansweredChip: {
    alignSelf: "flex-start",
    marginTop: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: 6,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: (COLORS as any).infoBg ?? "#E8EDFF",
  },
  unansweredChipText: { color: COLORS.text, fontWeight: "700" },

  segment: {
    flexDirection: "row",
    gap: SPACING.xs,
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.sm,
  },
  segmentBtn: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
  },
  segmentBtnActive: {
    backgroundColor: COLORS.primary600,
    borderColor: COLORS.primary600,
  },
  segmentBtnIdle: { backgroundColor: COLORS.cardBg, borderColor: COLORS.border },
  segmentTextActive: { color: COLORS.primaryTextOn, fontWeight: "700" },
  segmentTextIdle: { color: COLORS.text },

  listContent: {
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.xl,
    gap: SPACING.sm,
  },
  card: { padding: SPACING.md, borderRadius: RADIUS.lg },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  nameLine: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: SPACING.xs,
  },
  nameLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  avatar: {
    backgroundColor: COLORS.border,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarText: {
    fontSize: 12,
    fontWeight: "800",
    color: COLORS.text,
  },
  name: { fontSize: 16, fontWeight: "600", color: COLORS.text, flexShrink: 1 },
  sub: { fontSize: 12, color: COLORS.text, opacity: 0.8 },
  pill: { paddingHorizontal: SPACING.sm, paddingVertical: 4, borderRadius: 999 },
  pillText: { fontSize: 12, fontWeight: "700" },
  empty: {
    textAlign: "center",
    color: COLORS.text,
    opacity: 0.7,
    paddingVertical: SPACING.xl,
  },
  footer: { paddingVertical: SPACING.lg, alignItems: "center" },
  footerSpace: { height: SPACING.lg },
  loadingBox: { paddingTop: SPACING.xl, alignItems: "center" },
  loadingText: { marginTop: SPACING.sm, color: COLORS.text, opacity: 0.7 },

  hint: {
    marginTop: SPACING.xs,
    fontSize: 12,
    color: COLORS.text,
    opacity: 0.7,
  },

  modalWrap: {
    flex: 1,
    backgroundColor: "#00000066",
    justifyContent: "center",
    paddingHorizontal: SPACING.lg,
  },
  modalCard: {
    backgroundColor: COLORS.cardBg,
    borderRadius: RADIUS.lg,
    padding: SPACING.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: COLORS.text,
    marginBottom: SPACING.md,
  },
  inputLabel: {
    fontSize: 12,
    color: COLORS.text,
    opacity: 0.8,
    marginTop: SPACING.sm,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bg,
    borderRadius: RADIUS.lg,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    color: COLORS.text,
  },
  modalButtons: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: SPACING.lg,
  },

  unItem: {
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
});
