// app/organize/_layout.tsx
import { Stack } from "expo-router";
import { COLORS } from "@ui/theme";

export default function OrganizeOuterStack() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: COLORS.cardBg },
        headerTitleStyle: { color: COLORS.text, fontWeight: "800" },
        headerTintColor: COLORS.primary,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: COLORS.bg },
      }}
    >
      <Stack.Screen name="events/[id]" options={{ title: "Event" }} />
    </Stack>
  );
}
