import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the React dev server and the game server are separate
// processes. The proxy makes them look like one origin to the browser, so we
// never have to deal with CORS or hardcode a backend URL in the client.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "ws://localhost:3100", ws: true },
      "/auth": "http://localhost:3100",
      "/config": "http://localhost:3100",
      "/stats": "http://localhost:3100",
      "/health": "http://localhost:3100",
      "/ready": "http://localhost:3100",
    },
  },
});
