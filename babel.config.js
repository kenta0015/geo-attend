// babel.config.js
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      [
        "module-resolver",
        {
          root: ["."],
          alias: {
            // Root
            "@": "./",

            // App sources
            "@app": "./app",
            "@/app": "./app",

            // Moved to src/ (new canonical paths)
            "@ui": "./src/ui",
            "@/ui": "./src/ui",
            "@styles": "./src/styles",
            "@/styles": "./src/styles",

            // Lib
            "@lib": "./lib",
            "@/lib": "./lib",

            // (optional legacy) keep organize for direct imports if any
            "@organize": "./archive/legacy_routes/organize",
            "@/organize": "./archive/legacy_routes/organize"
          },
          extensions: [".ts", ".tsx", ".js", ".jsx", ".json"]
        }
      ],
      "react-native-reanimated/plugin"
    ]
  };
};
