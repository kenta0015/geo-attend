// app.config.js (FULL)
export default ({ config }) => {
  const env = process.env.APP_ENV ?? "internal"; // "internal" | "production"
  const isProd = env === "production";

  const androidPackage = isProd
    ? "com.kenta0015.geoattendance"
    : "com.kenta0015.geoattendance.internal";

  const iosBundleIdentifier = isProd
    ? "com.kenta0015.geoattendance"
    : "com.kenta0015.geoattendance.internal";

  return {
    // ---- base ----
    ...config,
    owner: "kenta0015",
    name: "GeoAttend",
    slug: "geoattendance",
    scheme: "rta",
    orientation: "portrait",
    platforms: ["android", "ios", "web"],
    version: "1.0.0",

    runtimeVersion: { policy: "appVersion" },
    updates: {
      url: "https://u.expo.dev/18a62c09-a52c-4ff1-93eb-c86674e29bd9",
    },

    extra: {
      appEnv: env,
      eas: { projectId: "18a62c09-a52c-4ff1-93eb-c86674e29bd9" },
    },

    plugins: [
      "expo-router",
      [
        "expo-camera",
        {
          cameraPermission:
            "Allow GeoAttendance to access your camera to scan QR codes for attendance verification.",
          microphonePermission:
            "Allow GeoAttendance to access your microphone when recording audio is required for app features.",
        },
      ],
      "@react-native-community/datetimepicker",
      "expo-notifications",
      "expo-mail-composer",
    ],

    // ---- Android ----
    android: {
      package: androidPackage,
      versionCode: isProd ? 1 : 7,
      permissions: [
        "ACCESS_FINE_LOCATION",
        "ACCESS_COARSE_LOCATION",
        "ACCESS_BACKGROUND_LOCATION",
        "FOREGROUND_SERVICE",
        "POST_NOTIFICATIONS",
        "android.permission.CAMERA",
        "android.permission.RECORD_AUDIO",
      ],
      foregroundService: {
        type: "location",
      },
    },

    // ---- iOS ----
    ios: {
      bundleIdentifier: iosBundleIdentifier,
      buildNumber: "1",
      supportsTablet: false,
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        UIBackgroundModes: ["location"],
        NSLocationWhenInUseUsageDescription:
          "We use your location to verify on-site attendance.",
        NSLocationAlwaysAndWhenInUseUsageDescription:
          "We use your location in the background to detect venue entry and exit.",
        NSCameraUsageDescription:
          "We use your camera to scan QR codes for attendance verification.",
        NSMicrophoneUsageDescription:
          "We use your microphone when recording audio is required for app features.",
      },
    },

    // ---- Web ----
    web: { favicon: "./assets/favicon.png" },

    // ---- Branding ----
    icon: "./assets/icon.png",
    userInterfaceStyle: "light",
    newArchEnabled: true,
    splash: {
      image: "./assets/splash-icon.png",
      resizeMode: "contain",
      backgroundColor: "#ffffff",
    },
  };
};
