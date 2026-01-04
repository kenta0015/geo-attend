// app/organize/events/[id]/history.tsx
import React, { useEffect } from "react";
import { View, ActivityIndicator, Text, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

export default function EventHistoryRedirect() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();

  useEffect(() => {
    // Legacy wrapper: permanently redirect to the canonical Organizer Live screen.
    if (id && id !== "undefined") {
      router.replace(`/organize/events/${id}/live`);
    } else {
      router.replace("/organize");
    }
  }, [id, router]);

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" />
      <Text style={styles.label}>Redirecting…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  label: {
    marginTop: 12,
    fontSize: 16,
  },
});
