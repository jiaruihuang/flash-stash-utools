import { defineConfig } from "vite";

export default defineConfig({
  // 相对路径，保证产物可直接被 uTools 以 file:// 方式加载
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome110"
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  }
});
