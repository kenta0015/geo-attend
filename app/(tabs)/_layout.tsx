// app/(tabs)/_layout.tsx
import { Tabs } from "expo-router";
import { Platform } from "react-native";
import { useEffect } from "react";
import * as KeepAwake from "expo-keep-awake";
import HardBoundary from "../../components/HardBoundary";
import { useEffectiveRole, devSwitchEnabled } from "../../stores/devRole";

export const unstable_settings = { initialRouteName: "events" };

const enableDev = devSwitchEnabled();

console.log("[tabs/_layout] module loaded. enableDev =", enableDev);

// --- keep-awake (fail-safe) ---
async function safeKeepAwake() {
  try {
    // @ts-ignore different APIs across SDKs
    if ((KeepAwake as any).activateKeepAwakeAsync) {
      await (KeepAwake as any).activateKeepAwakeAsync();
    } else if ((KeepAwake as any).activate) {
      await (KeepAwake as any).activate();
    }
  } catch (e) {
    console.log("[keep-awake] skip:", String(e));
  }
}

export default function TabLayout() {
  const role = useEffectiveRole();

  useEffect(() => {
    console.log("[TabLayout] mounted. enableDev =", enableDev);
    // prevent "Uncaught (in promise) Unable to activate keep awake"
    safeKeepAwake().catch((e) => {
      console.log("[keep-awake] skip(caller):", String(e));
    });
  }, []);

  useEffect(() => {
    console.log("[TabLayout] render with role =", role, "enableDev =", enableDev);
  }, [role]);

  return (
    <HardBoundary>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: "#2563eb",
          tabBarInactiveTintColor: "#94a3b8",
          tabBarStyle: {
            borderTopColor: "#e5e7eb",
            borderTopWidth: Platform.OS === "android" ? 0.4 : 0.2,
          },
        }}
      >
        {/* Visible tabs (match immediate children) */}
        <Tabs.Screen
          name="events" // app/(tabs)/events.tsx
          options={{
            title: "History",
            href: { pathname: "/events" },
          }}
        />
        <Tabs.Screen
          name="organize/index" // app/(tabs)/organize/index.tsx
          options={{
            title: role === "attendee" ? "Organize (locked)" : "Organize",
            href:
              role === "attendee" && !enableDev
                ? null
                : { pathname: "/organize" },
          }}
        />
        <Tabs.Screen
          name="profile/index" // app/(tabs)/profile/index.tsx
          options={{
            title: "Profile",
            href: { pathname: "/profile" },
          }}
        />
        <Tabs.Screen
          name="debug" // app/(tabs)/debug.tsx
          options={{
            title: "Debug",
            href: enableDev ? { pathname: "/debug" } : null,
          }}
        />

        {/* Hidden entries (must match router children exactly) */}
        <Tabs.Screen name="me/events" options={{ href: null }} />
        <Tabs.Screen name="me/groups" options={{ href: null }} />
        <Tabs.Screen name="organize/location-test" options={{ href: null }} />
        <Tabs.Screen name="organize/admin" options={{ href: null }} />
        <Tabs.Screen name="organize/events/[id]" options={{ href: null }} />
        <Tabs.Screen
          name="organize/events/[id]/location"
          options={{ href: null }}
        />
        <Tabs.Screen
          name="organize/events/[id]/invite"
          options={{ href: null }}
        />
        <Tabs.Screen
          name="organize/events/[id]/qr"
          options={{ href: null }}
        />
        <Tabs.Screen
          name="organize/events/[id]/settings"
          options={{ href: null }}
        />
        <Tabs.Screen
          name="organize/events/[id]/checkin"
          options={{ href: null }}
        />
        <Tabs.Screen
          name="organize/events/[id]/live"
          options={{ href: null }}
        />
        <Tabs.Screen
          name="organize/events/[id]/scan"
          options={{ href: null }}
        />
        <Tabs.Screen name="screens/EventsList" options={{ href: null }} />
      </Tabs>
    </HardBoundary>
  );
}
