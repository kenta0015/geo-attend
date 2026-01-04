// app/organize/events/[id]/_layout.tsx
import React from "react";
import { Stack, Link, useLocalSearchParams } from "expo-router";
import Button from "../../../ui/Button";
import { COLORS } from "@ui/theme";

export default function Layout() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const eid = Array.isArray(id) ? id?.[0] : id;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: COLORS.cardBg },
        headerTitleStyle: { color: COLORS.text, fontWeight: "800" },
        headerTintColor: COLORS.primary,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: COLORS.bg },
        headerRight: () =>
          eid ? (
            <Link href={`/organize/events/${eid}/invite`} asChild>
              <Button title="Invite" size="sm" variant="primary" />
            </Link>
          ) : null,
      }}
    >
      <Stack.Screen
        name="live"
        options={{
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="scan"
        options={{
          headerShown: false,
        }}
      />
    </Stack>
  );
}
