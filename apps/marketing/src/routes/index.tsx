import { createFileRoute } from "@tanstack/react-router";
import { Blocks, BookOpen, Check, Copy, GitBranch, type LucideIcon, Plug, Shield, Target } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Chat } from "@/components/chat";
import { FileTree } from "@/components/file-tree";
import { Button, buttonVariants } from "@/components/ui/button";
import { activeWriteFile, SessionPlayer, type SessionSnapshot, writtenFiles } from "@/lib/session-player";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({ component: Home });

const INSTALL_COMMAND = "npm i -g wolli";
const agentName = "scout";

// Seeded empty at birth by createAgent. SOUL.md is too, but the demo holds it back
// so the write visibly creates it.
const SEED_FILES = ["MEMORY.md", "USER.md"];

// One entry per rail section, in scroll order: the session the card plays plus the
// header copy beside it. `continues` marks a session that extends the previous
// section's transcript — the shared prefix folds instantly and playback picks up there.
const RAIL_SECTIONS: Array<{ url: string; continues?: boolean; title: string; copy: string }> = [
	{
		url: "/sessions/forming.jsonl",
		title: "Give each agent a purpose",
		copy: "A wolli agent is born empty. Tell it what it's for and it writes who it is into its SOUL.md.",
	},
	{
		url: "/sessions/extending.jsonl",
		continues: true,
		title: "Watch it extend itself",
		copy: "Scout needs issues delivered the moment they open, so it writes its own GitHub integration, the workflow that wakes it, and the tool to talk back.",
	},
	{
		url: "/sessions/triggered.jsonl",
		title: "It wakes up on events",
		copy: "An issue opens and the workflow wakes scout in a fresh session. It triages, flags what matters, and reports back.",
	},
	{
		url: "/sessions/skill.jsonl",
		continues: true,
		title: "Experience becomes skill",
		copy: "Routines the agent repeats get written down as skills, authored by the agent itself.",
	},
];

const RAIL_HINT = "scroll to watch scout form";

// Brand-orange balls that drift across the whole page and bounce off the walls
// and each other. Just the look here (size + gradient); the motion is a physics
// loop in Home (positions/velocities/collisions), because bouncing needs real
// state, not keyframes. Sizes vary so the collisions read as heavier vs lighter.
const GLOW_BALLS: Array<{ size: number; opacity: number }> = [
	{ size: 1200, opacity: 0.22 },
	{ size: 880, opacity: 0.18 },
	{ size: 1080, opacity: 0.23 },
	{ size: 960, opacity: 0.19 },
	{ size: 1040, opacity: 0.21 },
	{ size: 900, opacity: 0.2 },
	{ size: 1140, opacity: 0.19 },
];

const ballBackground = (opacity: number) =>
	`radial-gradient(closest-side, rgba(232, 77, 53, ${opacity}), rgba(232, 77, 53, ${(opacity * 0.5).toFixed(3)}) 40%, rgba(232, 77, 53, ${(opacity * 0.17).toFixed(3)}) 68%, transparent 90%)`;

// The core (where balls actually collide) is a fraction of the visible radius,
// so the soft halos can overlap while the dense centers bounce apart.
const BALL_CORE = 0.42;
// Base drift speed in px/s. Elastic collisions conserve it, so the field keeps
// moving indefinitely.
const BALL_SPEED = 220;
// Walls give a little kick (>1) so bounces feel springy; MAX_SPEED caps the
// added energy so it never runs away.
const WALL_BOUNCE = 1.07;
const MAX_SPEED = BALL_SPEED * 1.7;

// The secondary-features grid below the rail.
const FEATURES: Array<{ icon: LucideIcon; title: string; description: string }> = [
	{
		icon: Target,
		title: "Purpose-built",
		description:
			"The agent works out its purpose with you in its first conversation and writes it as the first line of its SOUL.md.",
	},
	{
		icon: Blocks,
		title: "Self-extending",
		description:
			"The agent authors and installs its own skills, tools, and integrations. It grows more capable at its job instead of staying a fixed tool.",
	},
	{
		icon: GitBranch,
		title: "Persistent",
		description:
			"Sessions are an append-only JSONL tree, the agent's lifetime memory. Nothing is rewritten; the latest leaf resumes by default.",
	},
	{
		icon: BookOpen,
		title: "Curated memory",
		description:
			"SOUL.md, MEMORY.md, and USER.md are frozen into the system prompt each session, maintained by the agent itself.",
	},
	{
		icon: Shield,
		title: "Sandboxed",
		description:
			"Runs sandboxed by default: Apple Seatbelt, bubblewrap, or Docker. Your real machine is an approval-gated escalation away.",
	},
	{
		icon: Plug,
		title: "Any model",
		description: "Multi-provider via OAuth login: Anthropic, OpenAI, and others.",
	},
];

const LOCK_AT = 0.5; // fraction of the pin distance the slide takes
const FOCAL_LINE = 0.5; // fraction of viewport height headers focus around
const FOCUS_HOLD = 0.18; // headers stay fully bold within this range of the focal line
const FOCUS_FALLOFF = 0.2; // then fade out over this much more viewport

// useLayoutEffect warns during SSR; the scroll driver only matters in the browser.
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function DemoCard({
	view,
	hint,
	files,
	currentFile,
	className,
}: {
	view: SessionSnapshot | undefined;
	hint: string;
	files: string[];
	currentFile?: string;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"w-full overflow-hidden rounded-[12px] border border-chat-border bg-chat-bg shadow-[0_8px_24px_-16px_rgba(0,0,0,0.12)]",
				className,
			)}
		>
			{/* Split header: name over the chat, path over the tree; divider carried through to align the body. */}
			<div className="grid grid-cols-[1fr_auto] border-b border-chat-border md:grid-cols-[1fr_200px]">
				<div className="min-w-0 px-4 py-3 font-mono text-[13px] font-medium text-chat-text">{agentName}</div>
				<div className="truncate px-4 py-3 font-mono text-[13px] text-chat-muted md:border-l md:border-chat-border">
					~/.wolli/agents/{agentName}
				</div>
			</div>
			<div className="flex flex-col md:grid md:h-[520px] md:grid-cols-[1fr_200px]">
				{/* min-w-0 lets the chat shrink so wide code scrolls inside instead of shoving the tree off-screen. */}
				<div className="h-[440px] min-h-0 min-w-0 overflow-hidden md:h-full">
					<Chat blocks={view?.blocks ?? []} busy={view?.busy ?? false} input={view?.input ?? ""} hint={hint} />
				</div>
				{/* The tree is desktop-only; on mobile the card is just the chat. */}
				<FileTree
					files={files}
					currentFile={currentFile}
					className="hidden md:block md:border-l md:border-chat-border"
				/>
			</div>
		</div>
	);
}

function Home() {
	const [copied, setCopied] = useState(false);
	const railRef = useRef<HTMLElement | null>(null);
	const glowLayerRef = useRef<HTMLDivElement | null>(null);

	// The glow balls' physics. The layer is fixed to the viewport, but the balls
	// live in a taller "background space" (the page height) and are drawn offset
	// by the scroll, so they travel the whole page as you scroll. The catch: while
	// the demo rail pins its card, the page scrolls but the demo stays on the
	// spot — so there the offset is frozen and the background holds still too.
	// Positions are written straight to each element's transform (never React
	// state); layout effect so the first frame lands before paint.
	useBrowserLayoutEffect(() => {
		const layer = glowLayerRef.current;
		if (!layer) return;
		const els = Array.from(layer.querySelectorAll<HTMLElement>(".hero-glow"));
		if (els.length === 0) return;

		let viewportW = layer.clientWidth;
		let viewportH = layer.clientHeight;
		// The demo card is pinned over a stretch of scroll on desktop; there the
		// background offset must freeze. freeze() measures that stretch from the
		// rail's geometry and the sticky top (mirrors the card's sticky offset:
		// max(1rem, (100svh - 32rem) / 2) in routes/index.tsx). bgHeight is the
		// page minus the frozen stretch — the distance the background scrolls.
		let freezeStart = Number.POSITIVE_INFINITY;
		let freezeLength = 0;
		let bgHeight = viewportH;
		// On mobile the balls stay a still, viewport-bound backdrop: the field is
		// not coupled to scroll, so it never fights the address-bar show/hide that
		// resizes the viewport mid-scroll (which otherwise re-measured against the
		// page height and jerked the balls). Desktop keeps the full-page parallax.
		let parallax = false;
		const measure = () => {
			viewportW = layer.clientWidth;
			viewportH = layer.clientHeight;
			parallax = window.matchMedia("(min-width: 48rem)").matches;
			const rail = document.getElementById("demo-rail");
			const pinned = rail && parallax;
			if (pinned) {
				const railTop = rail.getBoundingClientRect().top + window.scrollY;
				const stickyTop = Math.max(16, (viewportH - 512) / 2);
				freezeStart = railTop - stickyTop;
				freezeLength = Math.max(0, rail.offsetHeight - viewportH + stickyTop);
			} else {
				freezeStart = Number.POSITIVE_INFINITY;
				freezeLength = 0;
			}
			// Parallax spans the page; the still mobile field is bound to the viewport.
			bgHeight = parallax ? Math.max(viewportH, document.documentElement.scrollHeight - freezeLength) : viewportH;
		};
		measure();

		// Scroll position with the frozen stretch removed — continuous, so the
		// background never jumps as the demo pins and releases. Mobile isn't
		// scroll-coupled (parallax off), so the offset stays a flat 0 there.
		const offset = () => {
			if (!parallax) return 0;
			const s = window.scrollY;
			return s - Math.max(0, Math.min(s - freezeStart, freezeLength));
		};

		const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

		const balls = els.map((el, i) => {
			const visualRadius = el.offsetWidth / 2;
			const radius = visualRadius * BALL_CORE;
			const angle = Math.random() * Math.PI * 2;
			const margin = radius + 8;
			// Spread the balls down the whole background space so no stretch of the
			// page is empty; random x, with margins keeping them off the walls.
			return {
				el,
				visualRadius,
				radius,
				mass: radius * radius,
				x: margin + Math.random() * Math.max(1, viewportW - 2 * margin),
				y: ((i + 0.5) / els.length) * bgHeight + (Math.random() - 0.5) * bgHeight * 0.04,
				vx: Math.cos(angle) * BALL_SPEED,
				vy: Math.sin(angle) * BALL_SPEED,
			};
		});

		const draw = (b: (typeof balls)[number], off: number) => {
			b.el.style.transform = `translate3d(${b.x - b.visualRadius}px, ${b.y - off - b.visualRadius}px, 0)`;
		};
		for (const b of balls) {
			b.y = Math.max(b.radius, Math.min(bgHeight - b.radius, b.y));
			draw(b, offset());
		}

		if (reduce) return;

		let raf = 0;
		let last = performance.now();
		const step = (now: number) => {
			// Clamp dt so a backgrounded tab doesn't teleport everything on return.
			const dt = Math.min((now - last) / 1000, 0.05);
			last = now;

			for (const b of balls) {
				b.x += b.vx * dt;
				b.y += b.vy * dt;
				// Walls: clamp to the edge and send the velocity back inward, with a
				// springy kick.
				if (b.x < b.radius) {
					b.x = b.radius;
					b.vx = Math.abs(b.vx) * WALL_BOUNCE;
				} else if (b.x > viewportW - b.radius) {
					b.x = viewportW - b.radius;
					b.vx = -Math.abs(b.vx) * WALL_BOUNCE;
				}
				if (b.y < b.radius) {
					b.y = b.radius;
					b.vy = Math.abs(b.vy) * WALL_BOUNCE;
				} else if (b.y > bgHeight - b.radius) {
					b.y = bgHeight - b.radius;
					b.vy = -Math.abs(b.vy) * WALL_BOUNCE;
				}
			}

			// Pairwise elastic collisions on the cores (mass ~ area).
			for (let i = 0; i < balls.length; i++) {
				for (let j = i + 1; j < balls.length; j++) {
					const a = balls[i]!;
					const b = balls[j]!;
					const dx = b.x - a.x;
					const dy = b.y - a.y;
					const minDist = a.radius + b.radius;
					const dist2 = dx * dx + dy * dy;
					if (dist2 === 0 || dist2 >= minDist * minDist) continue;
					const dist = Math.sqrt(dist2);
					const nx = dx / dist;
					const ny = dy / dist;
					// Push the pair apart so they don't sink into each other.
					const overlap = minDist - dist;
					const total = a.mass + b.mass;
					a.x -= nx * overlap * (b.mass / total);
					a.y -= ny * overlap * (b.mass / total);
					b.x += nx * overlap * (a.mass / total);
					b.y += ny * overlap * (a.mass / total);
					// Exchange the velocity component along the collision normal.
					const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
					if (vn >= 0) continue;
					const impulse = (-2 * vn) / total;
					a.vx -= impulse * b.mass * nx;
					a.vy -= impulse * b.mass * ny;
					b.vx += impulse * a.mass * nx;
					b.vy += impulse * a.mass * ny;
				}
			}

			// Cap the springy energy the walls add so nothing accelerates forever.
			for (const b of balls) {
				const speed = Math.hypot(b.vx, b.vy);
				if (speed > MAX_SPEED) {
					const k = MAX_SPEED / speed;
					b.vx *= k;
					b.vy *= k;
				}
			}

			const off = offset();
			for (const b of balls) draw(b, off);
			raf = requestAnimationFrame(step);
		};
		raf = requestAnimationFrame(step);

		// Remeasure when the viewport or page height changes, and keep the balls
		// inside the new bounds.
		const observer = new ResizeObserver(() => {
			measure();
			for (const b of balls) {
				b.x = Math.max(b.radius, Math.min(viewportW - b.radius, b.x));
				b.y = Math.max(b.radius, Math.min(bgHeight - b.radius, b.y));
			}
		});
		observer.observe(layer);
		observer.observe(document.body);

		return () => {
			cancelAnimationFrame(raf);
			observer.disconnect();
		};
	}, []);

	// One player per section, created once; activate() drives them from the scroll
	// position. A continuing section gets its predecessor's player to fold from.
	const playersRef = useRef<SessionPlayer[] | null>(null);
	playersRef.current ??= RAIL_SECTIONS.reduce<SessionPlayer[]>((list, section) => {
		list.push(new SessionPlayer(section.url, section.continues ? list.at(-1) : undefined));
		return list;
	}, []);
	const players = playersRef.current;

	const [sections, setSections] = useState<SessionSnapshot[]>(() => players.map((player) => player.snapshot));
	const [activeIndex, setActiveIndex] = useState(-1);

	// Prefetch every session on mount so folding a skipped section is effectively synchronous.
	useEffect(() => {
		for (const player of players) player.load().catch((error) => console.error(error));
	}, [players]);

	useEffect(
		() => () => {
			for (const player of players) player.stop();
		},
		[players],
	);

	// Players emit fresh snapshot objects; re-collecting them is enough for React to see
	// the change (unchanged players keep their snapshot identity).
	const sync = useCallback(() => setSections(players.map((player) => player.snapshot)), [players]);

	const activate = useCallback(
		(index: number, previous: number) => {
			// Whatever was running stops when its section loses focus; the section taking
			// focus always (re)plays from its start — walkbacks included.
			if (previous >= 0) players[previous]?.stop();
			setActiveIndex(index);
			if (index < 0) return;
			// Every section above the active one must be settled — skipped or stopped
			// mid-run, fold it so its files (and transcript) are whole before this plays.
			for (let i = 0; i < index; i++) {
				const predecessor = players[i]!;
				if (predecessor.status !== "done") void predecessor.fold(sync);
			}
			void players[index]!.play(sync);
		},
		[players, sync],
	);

	// One passive listener drives header focus and section activation. The card slide
	// itself is a CSS scroll-driven animation (styles.css); JS only mirrors the same
	// slide value to gate activation. Direct DOM writes are safe: the rail's className
	// is static. Layout effect so focus values land before paint on load.
	useBrowserLayoutEffect(() => {
		const rail = railRef.current;
		if (!rail) return;
		const anchors = Array.from(rail.querySelectorAll<HTMLElement>("[data-rail-section]"));
		let lastIndex = -1;

		const onScroll = () => {
			const progress = Math.min(Math.max(1 - rail.getBoundingClientRect().top / window.innerHeight, 0), 1);
			const slide = Math.min(progress / LOCK_AT, 1);

			// Each header's focus comes from its distance to the focal line: fully bold
			// within FOCUS_HOLD of it, fading to 0 over the next FOCUS_FALLOFF;
			// styles.css maps it to opacity. The closest header is the active
			// section — but nothing activates before the card locks in.
			const line = window.innerHeight * FOCAL_LINE;
			const hold = window.innerHeight * FOCUS_HOLD;
			const falloff = window.innerHeight * FOCUS_FALLOFF;
			let index = -1;
			let best = Infinity;
			for (let i = 0; i < anchors.length; i++) {
				const anchor = anchors[i]!;
				const rect = anchor.getBoundingClientRect();
				const offset = rect.top + rect.height / 2 - line;
				// The last header never fades back out upward — it stays bold as the rail
				// runs out.
				const distance = i === anchors.length - 1 ? Math.max(offset, 0) : Math.abs(offset);
				const focus = Math.min(Math.max(1 - (distance - hold) / falloff, 0), 1);
				anchor.style.setProperty("--focus", focus.toFixed(3));
				if (slide >= 1 && distance < best) {
					best = distance;
					index = i;
				}
			}
			if (index !== lastIndex) {
				activate(index, lastIndex);
				lastIndex = index;
			}
		};

		onScroll();
		window.addEventListener("scroll", onScroll, { passive: true });
		window.addEventListener("resize", onScroll);
		return () => {
			window.removeEventListener("scroll", onScroll);
			window.removeEventListener("resize", onScroll);
		};
	}, [activate]);

	const active = activeIndex >= 0 ? sections[activeIndex] : undefined;
	// The active section's last write stays highlighted while the section is active (the
	// cue to what it added) and clears when another section takes over. A continuing
	// section's transcript starts with its predecessor's blocks; writes in that shared
	// prefix belong to the previous section, so the scan skips them.
	const prefixBlocks =
		activeIndex >= 0 && RAIL_SECTIONS[activeIndex]?.continues ? (sections[activeIndex - 1]?.blocks.length ?? 0) : 0;
	const currentFile = active ? activeWriteFile(active.blocks.slice(prefixBlocks)) : undefined;

	// Seed files plus what the sections up to the active one wrote — scrolling back
	// out of a section takes its files with it. The in-flight write appears immediately.
	const files = useMemo<string[]>(() => {
		const paths = new Set<string>(SEED_FILES);
		for (const section of sections.slice(0, activeIndex + 1)) {
			for (const path of writtenFiles(section.blocks)) paths.add(path);
		}
		if (currentFile) paths.add(currentFile);
		return [...paths];
	}, [sections, activeIndex, currentFile]);

	function copyInstall() {
		navigator.clipboard.writeText(INSTALL_COMMAND).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	}

	return (
		<>
			{/* Viewport-fixed ambient field: brand balls that drift and bounce off the
			    viewport walls and each other (physics loop above). Fixed, so it's a still
			    backdrop — page scroll never moves it; content just scrolls over it. */}
			<div ref={glowLayerRef} aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
				{GLOW_BALLS.map((ball) => (
					<div
						key={ball.size}
						className="hero-glow"
						style={{ width: ball.size, height: ball.size, background: ballBackground(ball.opacity) }}
					/>
				))}
			</div>
			{/* Short hero (81svh) so the card below peeks under the fold, hinting there's more. */}
			<main className="flex min-h-[81svh] flex-col items-center justify-center px-6">
				<div className="mx-auto flex max-w-3xl flex-col items-center text-center">
					<h1 className="font-heading text-[2.125rem]/[1.15] font-normal tracking-[-0.005em] text-balance [word-spacing:0.06em] sm:text-[2.75rem]/[1.1] md:text-[3.25rem]/[1.1]">
						Create agents that grow around a purpose
					</h1>
					<p className="mt-3 max-w-xl text-[13px] text-muted-foreground sm:text-[15px]">
						Each agent remembers across sessions, runs on schedules,{" "}
						<span className="sm:whitespace-nowrap">reacts to events, and extends itself over time.</span>
					</p>
					<div className="group mt-14 flex items-center gap-1 rounded-full bg-background py-1.5 pr-2.5 pl-4 shadow-[0_2px_8px_rgba(0,0,0,0.06)] ring-1 ring-black/[0.06]">
						<span className="pr-1 font-mono text-base text-muted-foreground select-none">$</span>
						<span className="font-mono text-sm text-foreground">{INSTALL_COMMAND}</span>
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={copyInstall}
							aria-label="Copy install command"
							className="ml-1 cursor-pointer rounded-full"
						>
							{copied ? <Check /> : <Copy />}
							<span className="sr-only" aria-live="polite">
								{copied ? "Copied" : ""}
							</span>
						</Button>
					</div>
				</div>
			</main>
			<section
				ref={railRef}
				id="demo-rail"
				className="relative mx-auto w-full max-w-[88rem] px-6 pb-32 md:grid md:grid-cols-[minmax(280px,340px)_minmax(0,1fr)] md:gap-12"
			>
				{/* Tail padding lets the last header travel all the way to the focal line
				    while the card is still pinned. */}
				<div className="md:pb-[30svh]">
					{RAIL_SECTIONS.map((section, index) => (
						<div
							key={section.url}
							data-rail-section
							className="py-16 md:flex md:min-h-[60svh] md:flex-col md:justify-center md:py-0"
						>
							<h2 className="text-3xl font-heading font-normal tracking-[-0.005em] text-balance sm:text-4xl">
								{section.title}
							</h2>
							<p className="mt-4 max-w-md text-lg text-muted-foreground">{section.copy}</p>
							<div className="mt-8 md:hidden">
								<DemoCard
									view={sections[index]!}
									hint={RAIL_HINT}
									files={files}
									currentFile={activeIndex === index ? currentFile : undefined}
								/>
							</div>
						</div>
					))}
				</div>
				<div className="hidden md:block">
					<div className="sticky top-[max(1rem,calc((100svh-32rem)/2))]">
						<DemoCard
							className="rail-card"
							view={active}
							hint={RAIL_HINT}
							files={files}
							currentFile={currentFile}
						/>
					</div>
				</div>
			</section>
			<section className="mx-auto w-full max-w-6xl px-6 py-24 md:py-32">
				<div className="mx-auto max-w-2xl text-center">
					<h2 className="font-heading text-[2rem]/[1.15] font-light tracking-[-0.005em] text-balance sm:text-[2.375rem]/[1.05] md:text-[2.75rem]/[1.05]">
						Everything an agent needs to grow
					</h2>
					<p className="mt-5 text-lg text-balance text-muted-foreground">
						Memory, autonomy, sandboxing, and scheduling are built into every agent. Focus on its purpose.
					</p>
				</div>
				<div className="mt-16 grid gap-x-12 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
					{FEATURES.map((feature) => (
						<div key={feature.title}>
							<div className="flex items-center gap-2.5">
								<feature.icon className="size-4.5" aria-hidden />
								<h3 className="font-normal">{feature.title}</h3>
							</div>
							<p className="mt-3 leading-relaxed text-muted-foreground">{feature.description}</p>
						</div>
					))}
				</div>
			</section>
			{/* Closing call to action. */}
			<section className="mx-auto flex min-h-[calc(100svh-7rem)] w-full max-w-6xl flex-col items-center justify-center px-6 text-center">
				<h2 className="font-heading text-[2rem]/[1.15] font-light tracking-[-0.005em] text-balance sm:text-[2.375rem]/[1.05] md:text-[2.75rem]/[1.05]">
					Create your own agent today
				</h2>
				<div className="mt-10">
					{/* Cross-worker link to the docs app, same as the header's Docs. */}
					<a
						href="/docs/getting-started/"
						className={cn(
							buttonVariants({ size: "lg" }),
							"h-12 rounded-full bg-[#E84D35] px-7 text-base text-white hover:bg-[#E84D35]/90",
						)}
					>
						Get started
					</a>
				</div>
			</section>
			{/* Single-bar footer mirroring the header's container dimensions.
			    IMPORTANT: the docs app carries a copy of this footer
			    (apps/docs/src/routes/__root.tsx); changes here must be applied
			    there too. */}
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
		</>
	);
}
