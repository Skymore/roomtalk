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

					if (normalizedId.includes("/node_modules/elkjs/")) {
						return "vendor-elk";
					}

					if (normalizedId.includes("/node_modules/d3-")) {
						return "vendor-d3";
					}

					if (includesAny(normalizedId, [
						"/node_modules/dagre",
						"/node_modules/cytoscape",
					])) {
						return "vendor-graph";
					}

					if (normalizedId.includes("/node_modules/mermaid/")) {
						return "vendor-mermaid";
					}

					if (includesAny(normalizedId, [
						"/node_modules/react-markdown/",
						"/node_modules/remark-",
						"/node_modules/rehype-",
						"/node_modules/unified/",
						"/node_modules/unist-util-",
						"/node_modules/mdast-util-",
						"/node_modules/hast-util-",
						"/node_modules/micromark",
						"/node_modules/vfile",
						"/node_modules/katex/",
						"/node_modules/react-syntax-highlighter/",
						"/node_modules/highlight.js/",
					])) {
						return "vendor-markdown";
					}

					if (includesAny(normalizedId, [
						"/node_modules/socket.io-client/",
						"/node_modules/@socket.io/",
						"/node_modules/engine.io-client/",
					])) {
						return "vendor-socket";
					}

					return "vendor";
				},
			},
		},
	},
	server: {
		allowedHosts: true,
	},
});
