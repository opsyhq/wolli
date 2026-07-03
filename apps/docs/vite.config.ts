import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import mdx from "fumadocs-mdx/vite";
import { defineConfig } from "vite";

const config = defineConfig({
	resolve: { tsconfigPaths: true },
	// Everything this worker serves must live under /docs/* (zone-route split
	// with the marketing worker); this puts assets there so URL == file path.
	build: { assetsDir: "docs/assets" },
	plugins: [
		cloudflare({ viteEnvironment: { name: "ssr" } }),
		devtools(),
		mdx(),
		tailwindcss(),
		tanstackStart({
			prerender: { enabled: true, crawlLinks: true },
			pages: [{ path: "/docs" }],
			// Server functions must live under /docs/* too, or the zone route
			// would send their requests to the marketing worker.
			serverFns: { base: "/docs/_serverFn" },
		}),
		viteReact(),
	],
});

export default config;
