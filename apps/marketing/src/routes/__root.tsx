import { TanStackDevtools } from "@tanstack/react-devtools";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { Menu, X } from "lucide-react";
import { useState } from "react";

import appCss from "../styles.css?url";

const NAV_LINKS = [
	{ href: "/", label: "Docs" },
	{ href: "/", label: "Examples" },
	{ href: "/", label: "Plugins" },
];

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
				title: "TanStack Start Starter",
			},
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
		],
	}),
	shellComponent: RootDocument,
});

// The GitHub mark, inlined (lucide's brand icons are deprecated).
function GitHubIcon({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
			<path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
		</svg>
	);
}

// Apple-style site header: thin, sticky, translucent, with generous side padding.
// On phones the text links collapse behind a hamburger that opens a full-screen
// panel (eve.dev-style): the page disappears behind big full-width rows.
function SiteHeader() {
	const [menuOpen, setMenuOpen] = useState(false);

	return (
		<>
			<header className="sticky top-0 z-50 border-b border-black/5 bg-background/80 backdrop-blur-xl backdrop-saturate-150">
				<div className="mx-auto flex h-14 w-full items-center px-6 md:px-32 lg:px-48">
					<a href="/" className="text-lg font-bold tracking-tight text-foreground">
						Wolli
					</a>
					<nav className="ml-10 hidden items-center gap-8 text-sm text-muted-foreground md:flex">
						{NAV_LINKS.map((link) => (
							<a key={link.label} href={link.href} className="transition-colors hover:text-foreground">
								{link.label}
							</a>
						))}
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
					<button
						type="button"
						aria-label={menuOpen ? "Close menu" : "Open menu"}
						aria-expanded={menuOpen}
						onClick={() => setMenuOpen((open) => !open)}
						className="ml-1 flex size-8 items-center justify-center rounded-full text-foreground transition-colors hover:bg-black/5 md:hidden"
					>
						{menuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
					</button>
				</div>
			</header>
			{/* Outside the header: its backdrop-filter would otherwise become the fixed
			    panel's containing block and collapse it to the header's height. */}
			{menuOpen ? (
				<nav className="fixed inset-x-0 top-14 bottom-0 z-50 overflow-y-auto overscroll-contain bg-background md:hidden">
					<div className="flex flex-col px-6 py-2">
						{NAV_LINKS.map((link) => (
							<a
								key={link.label}
								href={link.href}
								onClick={() => setMenuOpen(false)}
								className="py-4 text-base text-foreground"
							>
								{link.label}
							</a>
						))}
					</div>
				</nav>
			) : null}
		</>
	);
}

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				<SiteHeader />
				{children}
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
