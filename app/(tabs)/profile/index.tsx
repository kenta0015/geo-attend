import { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Platform,
  ToastAndroid,
  Alert,
  Image,
  ActivityIndicator,
  Modal,
  TextInput,
  KeyboardAvoidingView,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { router } from "expo-router";
import { getGuestId } from "../../../stores/session";
import Button from "../../ui/Button";
import { supabase } from "../../../lib/supabase";
import { useEffectiveRole, devSwitchEnabled } from "../../../stores/devRole";
import { getAvatarSignedUrl } from "../../../lib/avatarUrl";
import {
  pickAvatarFromLibrary,
  takeAvatarPhoto,
  processToSquare512Jpeg,
  uploadAvatarForUser,
  removeAvatarForUser,
} from "../../../lib/avatarUpload";

const enableDev = devSwitchEnabled();

export default function ProfileScreen() {
  const [guestId, setGuestId] = useState<string>("(loading…)");
  const [signingOut, setSigningOut] = useState(false);

  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);

  const [avatarPath, setAvatarPath] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);

  const [profileName, setProfileName] = useState<string | null>(null);
  const [nameModalOpen, setNameModalOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [savingName, setSavingName] = useState(false);

  const role = useEffectiveRole();

  const isAuthenticated = !!sessionUserId;

  const notify = (m: string) =>
    Platform.OS === "android"
      ? ToastAndroid.show(m, ToastAndroid.SHORT)
      : Alert.alert("Info", m);

  const loadSession = useCallback(async () => {
    try {
      setSessionLoading(true);
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      setSessionUserId(data.session?.user?.id ?? null);
    } catch {
      setSessionUserId(null);
    } finally {
      setSessionLoading(false);
    }
  }, []);

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      notify("Signed out");
      setAvatarPath(null);
      setAvatarUrl(null);
      setProfileName(null);
      setEditName("");
      setNameModalOpen(false);
    } catch (e: any) {
      notify(e?.message ?? "Sign out failed");
    } finally {
      setSigningOut(false);
    }
  };

  const loadGuestId = useCallback(async () => {
    const id = await getGuestId();
    setGuestId(id);
  }, []);

  const refreshProfileFromDb = useCallback(
    async (userId: string) => {
      try {
        const { data, error } = await supabase
          .from("user_profile")
          .select("avatar_path, avatar_updated_at, display_name, ice_name")
          .eq("user_id", userId)
          .maybeSingle();

        if (error) throw error;

        const nextPath = (data as any)?.avatar_path ?? null;
        setAvatarPath(nextPath);

        const displayName = String((data as any)?.display_name ?? "").trim();
        const iceName = String((data as any)?.ice_name ?? "").trim();
        const bestName = (displayName || iceName || "").trim();
        setProfileName(bestName ? bestName : null);

        if (nextPath) {
          const url = await getAvatarSignedUrl(nextPath);
          setAvatarUrl(url);
        } else {
          setAvatarUrl(null);
        }
      } catch {
        setAvatarPath(null);
        setAvatarUrl(null);
        setProfileName(null);
      }
    },
    [setAvatarPath, setAvatarUrl, setProfileName]
  );

  useEffect(() => {
    loadGuestId();
  }, [loadGuestId]);

  useEffect(() => {
    let isMounted = true;

    (async () => {
      await loadSession();
    })();

    const listener = supabase.auth.onAuthStateChange((_event, session) => {
      if (!isMounted) return;
      const uid = session?.user?.id ?? null;
      setSessionUserId(uid);
      setSessionLoading(false);

      if (!uid) {
        setAvatarPath(null);
        setAvatarUrl(null);
        setProfileName(null);
        setEditName("");
        setNameModalOpen(false);
      }
    });

    return () => {
      isMounted = false;
      try {
        (listener as any)?.data?.subscription?.unsubscribe?.();
      } catch {
        // ignore
      }
    };
  }, [loadSession]);

  useEffect(() => {
    if (!sessionUserId) return;
    refreshProfileFromDb(sessionUserId);
  }, [sessionUserId, refreshProfileFromDb]);

  useFocusEffect(
    useCallback(() => {
      loadGuestId();
      loadSession();
      if (sessionUserId) {
        refreshProfileFromDb(sessionUserId);
      }
    }, [loadGuestId, loadSession, refreshProfileFromDb, sessionUserId])
  );

  const fallbackInitial = useMemo(() => {
    if (sessionLoading) return "?";
    if (!isAuthenticated) return "G";
    const n = String(profileName ?? "").trim();
    if (n) return n.slice(0, 1).toUpperCase();
    return "U";
  }, [isAuthenticated, sessionLoading, profileName]);

  const promptPhotoSource = useCallback(() => {
    if (!sessionUserId) return;

    Alert.alert("Profile Photo", "Choose a source", [
      {
        text: "Library",
        onPress: async () => {
          setAvatarBusy(true);
          try {
            const picked = await pickAvatarFromLibrary();
            if (!picked) return;

            const processedUri = await processToSquare512Jpeg(picked);
            const path = await uploadAvatarForUser(sessionUserId, processedUri);
            if (!path) {
              notify("Upload failed");
              return;
            }

            setAvatarPath(path);
            const url = await getAvatarSignedUrl(path);
            setAvatarUrl(url);
            notify("Profile photo updated");
          } catch (e: any) {
            notify(e?.message ?? "Upload failed");
          } finally {
            setAvatarBusy(false);
          }
        },
      },
      {
        text: "Camera",
        onPress: async () => {
          setAvatarBusy(true);
          try {
            const picked = await takeAvatarPhoto();
            if (!picked) return;

            const processedUri = await processToSquare512Jpeg(picked);
            const path = await uploadAvatarForUser(sessionUserId, processedUri);
            if (!path) {
              notify("Upload failed");
              return;
            }

            setAvatarPath(path);
            const url = await getAvatarSignedUrl(path);
            setAvatarUrl(url);
            notify("Profile photo updated");
          } catch (e: any) {
            notify(e?.message ?? "Upload failed");
          } finally {
            setAvatarBusy(false);
          }
        },
      },
      { text: "Cancel", style: "cancel" },
    ]);
  }, [notify, sessionUserId]);

  const handleRemovePhoto = useCallback(async () => {
    if (!sessionUserId) return;

    setAvatarBusy(true);
    try {
      const ok = await removeAvatarForUser(sessionUserId, avatarPath);
      if (!ok) {
        notify("Remove failed");
        return;
      }
      setAvatarPath(null);
      setAvatarUrl(null);
      notify("Profile photo removed");
    } catch (e: any) {
      notify(e?.message ?? "Remove failed");
    } finally {
      setAvatarBusy(false);
    }
  }, [avatarPath, notify, sessionUserId]);

  const handleGoToJoin = useCallback(() => {
    router.push("/join");
  }, []);

  const openEditNameModal = useCallback(() => {
    if (!sessionUserId) return;
    setEditName(String(profileName ?? "").trim());
    setNameModalOpen(true);
  }, [profileName, sessionUserId]);

  const handleSaveName = useCallback(async () => {
    if (!sessionUserId) return;
    const trimmed = editName.trim();
    if (!trimmed) return;

    setSavingName(true);
    try {
      const payload: Record<string, unknown> = {
        user_id: String(sessionUserId),
        display_name: trimmed,
        ice_name: trimmed,
      };

      const { error } = await supabase
        .from("user_profile")
        .upsert([payload], { onConflict: "user_id" });

      if (error) throw error;

      setProfileName(trimmed);
      setNameModalOpen(false);
      notify("Name updated");
    } catch (e: any) {
      notify(e?.message ?? "Save failed");
    } finally {
      setSavingName(false);
    }
  }, [editName, notify, sessionUserId]);

  const canSaveName = useMemo(() => editName.trim().length > 0 && !savingName, [editName, savingName]);

  return (
    <View style={styles.container}>
      <Text style={styles.header}>Profile</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Profile photo</Text>

        <View style={styles.avatarRow}>
          <View style={styles.avatarCircle}>
            {avatarBusy && <ActivityIndicator />}
            {!avatarBusy && avatarUrl && <Image source={{ uri: avatarUrl }} style={styles.avatarImg} />}
            {!avatarBusy && !avatarUrl && <Text style={styles.avatarInitial}>{fallbackInitial}</Text>}
          </View>

          <View style={styles.avatarActions}>
            {isAuthenticated ? (
              <>
                <Button
                  title={avatarBusy ? "Working…" : "Change photo"}
                  onPress={promptPhotoSource}
                  disabled={avatarBusy}
                  style={styles.actionButton}
                />
                <Button
                  title="Remove photo"
                  onPress={handleRemovePhoto}
                  disabled={avatarBusy || !avatarPath}
                  style={styles.actionButton}
                />
              </>
            ) : (
              <>
                <Text style={styles.hint}>Sign in to set a profile photo.</Text>
                <Button
                  title="Sign in"
                  onPress={handleGoToJoin}
                  disabled={avatarBusy}
                  style={styles.actionButton}
                />
              </>
            )}
          </View>
        </View>

        <View style={styles.nameBlock}>
          <Text style={styles.nameLabel}>Name</Text>
          {isAuthenticated ? (
            <>
              <Text style={styles.nameValue}>{profileName ? profileName : "(No name)"}</Text>
              <Button
                title="Change name"
                onPress={openEditNameModal}
                disabled={avatarBusy || sessionLoading}
                style={styles.actionButton}
              />
            </>
          ) : (
            <>
              <Text style={styles.hint}>Sign in to set your name.</Text>
              <Button title="Sign in" onPress={handleGoToJoin} style={styles.actionButton} />
            </>
          )}
        </View>

        {isAuthenticated ? (
          <Text style={styles.hint}>
            Your photo is stored privately and only shared with organizers when appropriate.
          </Text>
        ) : (
          <Text style={styles.hint}>Guest profiles cannot upload photos.</Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Current role</Text>
        <Text style={styles.value}>{role.toUpperCase()}</Text>
        <Text style={styles.hint}>
          {enableDev ? "Toggle via the yellow DEV ROLE badge." : "Role is determined by your account on the server."}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Guest ID</Text>
        <Text style={styles.mono}>{guestId}</Text>
        <Text style={styles.hint}>Stored locally. Resetting app data will change this value.</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Account</Text>
        <Text style={styles.hint}>Sign out to switch account or return to guest mode.</Text>
        <Button
          title={signingOut ? "Signing out…" : "Sign out"}
          onPress={handleSignOut}
          disabled={signingOut}
          style={styles.logoutButton}
        />
      </View>

      <Modal visible={nameModalOpen} animationType="slide" transparent>
        <KeyboardAvoidingView
          behavior={Platform.select({ ios: "padding", android: undefined })}
          style={styles.modalWrap}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Change name</Text>

            <Text style={styles.inputLabel}>Name</Text>
            <TextInput
              value={editName}
              onChangeText={setEditName}
              placeholder="e.g., John Smith"
              placeholderTextColor={"#11182799"}
              style={styles.input}
              autoCapitalize="words"
              autoCorrect={false}
            />

            <View style={styles.modalButtons}>
              <Button
                title="Cancel"
                onPress={() => {
                  setNameModalOpen(false);
                  setEditName(String(profileName ?? "").trim());
                }}
                disabled={savingName}
              />
              <View style={{ width: 10 }} />
              <Button title={savingName ? "Saving…" : "Save"} onPress={handleSaveName} disabled={!canSaveName} />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16, paddingTop: 16 },
  header: { fontSize: 22, fontWeight: "700", marginBottom: 12 },
  card: {
    borderWidth: 1,
    borderColor: "#E5E7EB",
    backgroundColor: "white",
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  label: { fontWeight: "700", marginBottom: 6 },
  value: { fontSize: 18, fontWeight: "800" },
  mono: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    color: "#111827",
  },
  hint: { color: "#6B7280", marginTop: 6, fontSize: 12 },
  logoutButton: { marginTop: 8, alignSelf: "flex-start" },

  avatarRow: { flexDirection: "row", alignItems: "center" },
  avatarCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#F3F4F6",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#E5E7EB",
  },
  avatarImg: { width: 64, height: 64 },
  avatarInitial: { fontSize: 22, fontWeight: "800", color: "#111827" },
  avatarActions: { marginLeft: 12, flex: 1 },
  actionButton: { marginTop: 6, alignSelf: "flex-start" },

  nameBlock: { marginTop: 10 },
  nameLabel: { fontSize: 12, fontWeight: "700", color: "#111827" },
  nameValue: { marginTop: 6, fontSize: 16, fontWeight: "700", color: "#111827" },

  modalWrap: {
    flex: 1,
    backgroundColor: "#00000066",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  modalCard: {
    backgroundColor: "white",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "#E5E7EB",
  },
  modalTitle: { fontSize: 18, fontWeight: "800", color: "#111827", marginBottom: 10 },
  inputLabel: { fontSize: 12, fontWeight: "700", color: "#111827", marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: "#E5E7EB",
    backgroundColor: "#F9FAFB",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#111827",
  },
  modalButtons: { flexDirection: "row", justifyContent: "flex-end", marginTop: 12 },
});
