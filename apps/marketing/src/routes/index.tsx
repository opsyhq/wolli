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
			{/* Short hero (72svh) so the card below peeks well under the fold, hinting there's more. */}
			<main className="flex min-h-[72svh] flex-col items-center justify-center px-6">
				<div className="mx-auto flex max-w-3xl flex-col items-center text-center">
					<h1 className="text-5xl font-semibold tracking-tight text-balance sm:text-6xl md:text-7xl">
						Create agents that grow around a purpose
					</h1>
					<p className="mt-6 max-w-xl text-lg text-balance text-muted-foreground sm:text-xl">
						Each agent remembers across sessions, runs on schedules, reacts to events, and extends itself over
						time.
					</p>
					<div className="group mt-10 flex items-center gap-1 rounded-full bg-background py-2.5 pr-3 pl-5 shadow-[0_2px_8px_rgba(0,0,0,0.06)] ring-1 ring-black/[0.06]">
						<span className="pr-1 font-mono text-base text-muted-foreground select-none">$</span>
						<span className="font-mono text-sm text-foreground">{INSTALL_COMMAND}</span>
						<Button
							variant="ghost"
							size="icon"
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
							<h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{section.title}</h2>
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
					<div className="sticky top-[max(1rem,calc((100svh-36rem)/2))]">
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
					<h2 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
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
								<h3 className="font-medium">{feature.title}</h3>
							</div>
							<p className="mt-3 leading-relaxed text-muted-foreground">{feature.description}</p>
						</div>
					))}
				</div>
			</section>
			{/* Closing call to action. */}
			<section className="mx-auto w-full max-w-6xl px-6 py-32 text-center md:py-48">
				<h2 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
					Create your own agent today
				</h2>
				<div className="mt-10">
					{/* Cross-worker link to the docs app, same as the header's Docs. */}
					<a href="/docs/" className={cn(buttonVariants({ size: "lg" }), "h-12 rounded-full px-7 text-base")}>
						Get started
					</a>
				</div>
			</section>
			{/* Single-bar footer mirroring the header's container dimensions.
			    IMPORTANT: the docs app carries a copy of this footer
			    (apps/docs/src/routes/__root.tsx); changes here must be applied
			    there too. */}
			<footer className="border-t border-border bg-muted/50">
				<div className="mx-auto flex h-14 w-full items-center justify-between px-6 text-sm text-muted-foreground md:px-32 lg:px-48">
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
