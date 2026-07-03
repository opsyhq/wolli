import { createFileRoute, redirect } from "@tanstack/react-router";

// Only reachable in dev: in production the marketing worker owns every path
// outside /docs/*.
export const Route = createFileRoute("/")({
	beforeLoad: () => {
		throw redirect({ href: "/docs" });
	},
});
