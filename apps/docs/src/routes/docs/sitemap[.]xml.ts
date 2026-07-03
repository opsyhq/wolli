import { createFileRoute } from "@tanstack/react-router";

import { source } from "#/lib/source";

// Only covers the docs pages; the marketing worker serves the root
// /sitemap.xml, and /robots.txt points crawlers at both.
export const Route = createFileRoute("/docs/sitemap.xml")({
	server: {
		handlers: {
			GET: () => {
				const urls = source
					.getPages()
					.map((page) => `\t<url>\n\t\t<loc>https://wolli.dev${page.url}</loc>\n\t</url>`)
					.join("\n");
				const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
				return new Response(xml, { headers: { "Content-Type": "application/xml" } });
			},
		},
	},
});
