import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const xmldomStub = path.resolve(root, "src/pixi/xmldom-stub.ts");
const host = process.env.TAURI_DEV_HOST;
const isTauriDev = Boolean(process.env.TAURI_ENV_PLATFORM);

const DEV_CSP = [
  "default-src 'self' customprotocol: asset: http://localhost:1420",
  "connect-src ipc: http://ipc.localhost http://localhost:1420 ws://localhost:1420 ws://localhost:1421 https://static-cdn.jtvnw.net https://d3aqoihi2n8ty8.cloudfront.net https://cdn.betterttv.net https://cdn.frankerfacez.com https://cdn.frankerfacez.net https://cdn.7tv.app https://cdn.jsdelivr.net https://fourtf.com",
  "img-src 'self' asset: http://asset.localhost blob: data: https://static-cdn.jtvnw.net https://d3aqoihi2n8ty8.cloudfront.net https://cdn.betterttv.net https://cdn.frankerfacez.com https://cdn.frankerfacez.net https://cdn.7tv.app https://cdn.jsdelivr.net https://fourtf.com",
  "frame-src https://player.twitch.tv https://embed.twitch.tv",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' http://localhost:1420 'unsafe-eval' 'wasm-unsafe-eval'",
  "worker-src 'self' blob: http://localhost:1420",
].join("; ");

export default defineConfig(async () => ({
  clearScreen: false,
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(root, "index.html"),
        settings: path.resolve(root, "settings.html"),
      },
    },
  },
  resolve: {
    alias: {
      "@xmldom/xmldom": xmldomStub,
    },
  },
  optimizeDeps: {
    exclude: ["@xmldom/xmldom"],
    esbuildOptions: {
      alias: {
        "@xmldom/xmldom": xmldomStub,
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    headers: {
      "Content-Security-Policy": DEV_CSP,
    },
    hmr: isTauriDev
      ? false
      : host
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
