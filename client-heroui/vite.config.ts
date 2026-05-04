import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const includesAny = (id: string, packages: string[]) => packages.some(pkg => id.includes(pkg));

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [react()],
	build: {
		chunkSizeWarningLimit: 1500,
		rollupOptions: {
			output: {
				manualChunks(id) {
					const normalizedId = id.replace(/\\/g, "/");
					if (!normalizedId.includes("/node_modules/")) return undefined;

					if (includesAny(normalizedId, [
						"/node_modules/react/",
						"/node_modules/react-dom/",
						"/node_modules/react-router-dom/",
						"/node_modules/scheduler/",
					])) {
						return "vendor-react";
					}

					if (includesAny(normalizedId, [
						"/node_modules/@heroui/",
						"/node_modules/@react-aria/",
						"/node_modules/@react-stately/",
						"/node_modules/@react-types/",
						"/node_modules/framer-motion/",
					])) {
						return "vendor-ui";
					}

					if (includesAny(normalizedId, [
						"/node_modules/@iconify/",
						"/node_modules/@heroicons/",
						"/node_modules/@tabler/icons-react/",
						"/node_modules/heroicons/",
					])) {
						return "vendor-icons";
					}

						return "vendor";
				},
			},
		},
	},
	server: {
		port: 3011,
		allowedHosts: true,
	},
});
