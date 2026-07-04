import { TanStackDevtools } from "@tanstack/react-devtools";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { RootProvider } from "fumadocs-ui/provider/tanstack";

import appCss from "../styles.css?url";

const SITE_URL = "https://wolli.dev";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				title: "Wolli Docs",
			},
			{ name: "description", content: "Documentation for Wolli, the agent that grows around a purpose." },
			{ name: "theme-color", content: "#fafafa" },
			{ property: "og:type", content: "website" },
			{ property: "og:site_name", content: "Wolli" },
			// PLACEHOLDER social card (apps/marketing/public/og.png, served at the
			// site root by the marketing worker): replace with the real brand asset.
			{ property: "og:image", content: `${SITE_URL}/og.png` },
			{ property: "og:image:width", content: "1200" },
			{ property: "og:image:height", content: "630" },
			{ name: "twitter:card", content: "summary_large_image" },
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
			// PLACEHOLDER icons: replace with the real Wolli mark. In production
			// the marketing worker serves these root paths; the copies in this
			// app's public/ only cover local dev.
			{ rel: "icon", href: "/favicon.ico", sizes: "32x32" },
			{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
			{ rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
		],
	}),
	notFoundComponent: NotFound,
	shellComponent: RootDocument,
});

function NotFound() {
	return (
		<main className="flex min-h-[70vh] flex-col items-center justify-center gap-3 px-6 text-center">
			<p className="text-sm font-medium text-muted-foreground">404</p>
			<h1 className="text-2xl font-bold tracking-tight text-foreground">Page not found</h1>
			<a
				href="/docs/getting-started/"
				className="text-sm text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
			>
				Back to the docs
			</a>
		</main>
	);
}

// The GitHub mark, inlined (lucide's brand icons are deprecated).
function GitHubIcon({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
			<path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
		</svg>
	);
}

// Apple-style site header copied from apps/marketing/src/routes/__root.tsx.
// IMPORTANT: header changes must be cross-applied between the two apps by
// hand; the only intended difference here is the always-active Docs link.
// Brand and nav links go back to the marketing worker, so they are plain
// <a> tags on purpose.
function SiteHeader() {
	return (
		<header className="sticky top-0 z-50 border-b border-black/5 bg-background/80 backdrop-blur-xl backdrop-saturate-150">
			{/* h-14 is mirrored by --fd-docs-row-1 in routes/docs/$.tsx. */}
			<div className="mx-auto flex h-14 w-full items-center px-6 md:px-24 lg:px-40">
				<a href="/" className="text-lg font-bold tracking-tight text-[#E84D35]">
					Wolli
				</a>
				<nav className="ml-6 flex items-center gap-5 text-sm text-muted-foreground md:ml-10 md:gap-8">
					{/* Everything under this header is the docs section, so the
					    Docs link always renders active. */}
					<a href="/docs/getting-started/" className="text-foreground">
						Docs
					</a>
					<a
						href="https://github.com/opsyhq/wolli/tree/main/packages/wolli/built-in/plugins"
						target="_blank"
						rel="noreferrer"
						className="transition-colors hover:text-foreground"
					>
						Plugins
					</a>
				</nav>
				<a
					href="https://github.com/opsyhq/wolli"
					target="_blank"
					rel="noreferrer"
					aria-label="Wolli on GitHub"
					className="ml-auto flex size-8 items-center justify-center rounded-full text-foreground transition-colors hover:bg-black/5"
				>
					<GitHubIcon className="size-5" />
				</a>
			</div>
		</header>
	);
}

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
				{/* Mirror of the marketing shell's rule: prerender the way back to
				    the marketing worker as soon as the page loads, so the
				    cross-worker transition feels instant in Chromium. */}
				<script
					type="speculationrules"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON, no user input
					dangerouslySetInnerHTML={{
						__html: JSON.stringify({
							prerender: [{ where: { href_matches: "/" }, eagerness: "eager" }],
						}),
					}}
				/>
			</head>
			<body>
				{/* The default search client posts to /api/search, which would hit
				    the marketing worker; the site is light-only, so next-themes
				    stays off. Header sits inside the provider for the search
				    dialog context. */}
				<RootProvider search={{ options: { api: "/docs/api/search" } }} theme={{ enabled: false }}>
					<SiteHeader />
					{children}
					{/* Single-bar footer copied from apps/marketing/src/routes/index.tsx.
					    IMPORTANT: footer changes must be cross-applied between the two
					    apps by hand. */}
					<footer className="border-t border-border bg-muted/50">
						<div className="mx-auto flex h-14 w-full items-center justify-between px-6 text-sm text-muted-foreground md:px-24 lg:px-40">
							<p>© 2026 Opsy, Inc.</p>
							<a
								href="https://github.com/opsyhq/wolli"
								target="_blank"
								rel="noreferrer"
								className="transition-colors hover:text-foreground"
							>
								GitHub
							</a>
						</div>
					</footer>
				</RootProvider>
				<TanStackDevtools
					config={{
						position: "bottom-right",
					}}
					plugins={[
						{
							name: "Tanstack Router",
							render: <TanStackRouterDevtoolsPanel />,
						},
					]}
				/>
				<Scripts />
			</body>
		</html>
	);
}
