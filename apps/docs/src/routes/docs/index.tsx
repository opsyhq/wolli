import { createFileRoute, redirect } from "@tanstack/react-router";

// The docs root has no page of its own; it 308s to the first page. Excluded
// from the prerender output (vite.config.ts) so the redirect actually runs.
export const Route = createFileRoute("/docs/")({
	beforeLoad: () => {
		throw redirect({ href: "/docs/introduction", statusCode: 308 });
	},
});
