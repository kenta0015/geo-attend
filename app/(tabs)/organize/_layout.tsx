// FILE: app/(tabs)/organize/_layout.tsx

import { Stack } from "expo-router";

export const unstable_settings = { initialRouteName: "index" };

export default function OrganizeStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
      }}
    />
  );
}
