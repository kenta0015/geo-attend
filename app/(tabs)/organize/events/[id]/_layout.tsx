// FILE: app/(tabs)/organize/events/[id]/_layout.tsx

import { Stack } from "expo-router";

export const unstable_settings = { initialRouteName: "index" };

export default function EventDetailStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
      }}
    />
  );
}
