import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxyTarget = env.AGENT_API_URL || "http://localhost:8787";
  const gatewayPassword = env.OPENCLAW_GATEWAY_PASSWORD;

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      proxy: {
        "/api": {
          target: proxyTarget,
          changeOrigin: true,
          ws: true,
          headers: gatewayPassword
            ? { "x-openclaw-gateway-password": gatewayPassword }
            : undefined,
        },
      },
    },
  };
});
