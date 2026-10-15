import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset URLs, so the build works from any subpath.
  base: "./",
  server: {
    port: Number(process.env.PORT) || 5274,
    open: !process.env.PORT,
  },
  build: { target: "es2020", outDir: "dist" },
  worker: { format: "es" },
});
