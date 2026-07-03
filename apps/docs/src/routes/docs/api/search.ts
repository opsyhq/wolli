import { createFileRoute } from "@tanstack/react-router";
import { createFromSource } from "fumadocs-core/search/server";

import { source } from "#/lib/source";

// Lives under /docs/api (not /api) so the request reaches this worker.
const server = createFromSource(source);

export const Route = createFileRoute("/docs/api/search")({
	server: {
		handlers: {
			GET: ({ request }) => server.GET(request),
		},
	},
});
