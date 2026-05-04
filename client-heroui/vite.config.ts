import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [react()],
	build: {
		chunkSizeWarningLimit: 1500,
	},
	server: {
		port: 3011,
		allowedHosts: true,
	},
	test: {
		exclude: [...configDefaults.exclude, "e2e/**"],
	},
});
