import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

const DEV_CSP = [
  "default-src 'self' customprotocol: asset: http://localhost:1420",
  "connect-src ipc: http://ipc.localhost http://localhost:1420 ws://localhost:1420 ws://localhost:1421 https://static-cdn.jtvnw.net https://cdn.betterttv.net https://cdn.frankerfacez.com https://cdn.7tv.app",
  "img-src 'self' asset: http://asset.localhost blob: data: https://static-cdn.jtvnw.net https://cdn.betterttv.net https://cdn.frankerfacez.com https://cdn.7tv.app",
  "frame-src https://player.twitch.tv https://embed.twitch.tv",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' http://localhost:1420 'unsafe-eval' 'wasm-unsafe-eval'",
].join("; ");

export default defineConfig(async () => ({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    headers: {
      "Content-Security-Policy": DEV_CSP,
    },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
