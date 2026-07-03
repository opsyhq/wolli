import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const config = defineConfig({
	resolve: { tsconfigPaths: true },
	plugins: [
		// Cloudflare's plugin is incompatible with Vitest's SSR env, so skip it under test.
		...(process.env.VITEST ? [] : [cloudflare({ viteEnvironment: { name: "ssr" } })]),
		devtools(),
		tailwindcss(),
		tanstackStart({
			// Built at prerender time from the crawled pages; /robots.txt points
			// here and at the docs worker's /docs/sitemap.xml.
			sitemap: { host: "https://wolli.dev" },
			// The crawler records the header's cross-worker Docs link before the
			// prerender filter runs; this entry wins the dedup (exact href match)
			// and keeps it out of the sitemap — it belongs to /docs/sitemap.xml.
			pages: [{ path: "/docs/getting-started/", sitemap: { exclude: true }, prerender: { enabled: false } }],
			prerender: {
				enabled: true,
				crawlLinks: true,
				// The header's Docs link points at the wolli-docs worker; there is
				// no /docs route here for the crawler to prerender.
				filter: (page) => !page.path.startsWith("/docs"),
			},
		}),
		viteReact(),
	],
});

export default config;
