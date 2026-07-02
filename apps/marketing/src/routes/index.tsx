import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Chat } from "@/components/chat";
import { type FileNode, FileTree } from "@/components/file-tree";
import { Button } from "@/components/ui/button";
import {
	activeWriteFile,
	SessionPlayer,
	type SessionPlayerStatus,
	type SessionSnapshot,
	writtenFiles,
} from "@/lib/session-player";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({ component: Home });

const INSTALL_COMMAND = "npm i -g wolli";
const agentName = "scout";

// In the tree from the start (createAgent seeds them empty at birth). SOUL.md is also
// born empty, but the demo holds it back so the write visibly creates it.
const SEED_FILES = ["MEMORY.md", "USER.md"];

// One url per [data-rail-section] block below, in DOM order — section i plays
// SESSION_URLS[i] when its block crosses the activation line.
const SESSION_URLS = ["/sessions/forming.jsonl"];

// Shown in the empty chat before the first section activates.
const RAIL_HINT = "scroll to watch scout form";

// The rail effect writes `--rail-progress` onto the rail element (raw linear, so the
// card tracks the scroll 1:1 and freezes when it stops). Activation is held off below
// SETTLE_AT — ungated, section 1 would start playing mid-slide at ~0.3 progress.
const SETTLE_AT = 0.8; // activation gate
const ACTIVATION_LINE = 0.7; // fraction of viewport height

// ---------------------------------------------------------------------------
// Playlist orchestration (inline: this page is its only consumer)
// ---------------------------------------------------------------------------

// What the card renders for one session slot.
type PlaylistSection = { status: SessionPlayerStatus } & SessionSnapshot;

// The immutable React-state view of a (mutable) player.
function project(player: SessionPlayer): PlaylistSection {
	return { status: player.status, ...player.snapshot };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

// The demo card: split header (name over the chat, path over the tree) and Chat/FileTree
// body. `view` is the active playlist slot; undefined before the first activation renders
// the empty chat with the hint.
function DemoCard({
	view,
	hint,
	files,
	currentFile,
	className,
}: {
	view: PlaylistSection | undefined;
	hint: string;
	files: FileNode[];
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
				<FileTree
					files={files}
					currentFile={currentFile}
					className="border-t border-chat-border md:border-t-0 md:border-l"
				/>
			</div>
		</div>
	);
}

function Home() {
	const [copied, setCopied] = useState(false);
	const railRef = useRef<HTMLElement | null>(null);

	// One SessionPlayer per session url, created once. The rail effect below drives them
	// through activate(): play once around a frontier (never rewind), fold anything a fast
	// scroll skipped, and pause/resume the playing session as it leaves/enters view.
	const playersRef = useRef<SessionPlayer[] | null>(null);
	playersRef.current ??= SESSION_URLS.map((url) => new SessionPlayer(url));
	const players = playersRef.current;

	const [sections, setSections] = useState<PlaylistSection[]>(() => players.map(project));
	const [activeIndex, setActiveIndex] = useState(-1);
	const frontierRef = useRef(-1);
	const controllerRef = useRef<AbortController | null>(null);

	// Prefetch every session on mount so folding a skipped section is effectively synchronous.
	useEffect(() => {
		for (const player of players) player.load().catch((error) => console.error(error));
	}, [players]);

	// Unmount aborts whatever driver is running.
	useEffect(() => () => controllerRef.current?.abort(), []);

	// Players mutate in place; re-project them all into fresh section objects so React re-renders.
	const sync = useCallback(() => setSections(players.map(project)), [players]);

	const activate = useCallback(
		(index: number) => {
			const frontier = frontierRef.current;
			const playing = frontier >= 0 ? players[frontier] : undefined;
			// Nothing in view (above the rail): freeze the running session; content stays shown.
			if (index < 0 || index >= players.length) {
				playing?.pause();
				return;
			}
			// At or behind the frontier: never rewind or replay — the frontier only runs
			// while it is the section in view.
			if (index <= frontier) {
				if (index === frontier) playing?.resume();
				else playing?.pause();
				setActiveIndex(index);
				return;
			}
			controllerRef.current?.abort();
			// Fold every not-done section below the new frontier to its full transcript
			// (prior chapters: their files must exist by the time a later section plays).
			for (let i = Math.max(frontier, 0); i < index; i++) {
				const player = players[i]!;
				if (player.status !== "done") void player.fold(sync);
			}
			frontierRef.current = index;
			setActiveIndex(index);
			const controller = new AbortController();
			controllerRef.current = controller;
			void players[index]!.play(sync, controller.signal);
		},
		[players, sync],
	);

	// The rail scroll effect: one passive scroll listener writes normalized progress into
	// `--rail-progress` (CSS maps it to the card slide) and reports the section under the
	// activation line to activate() — including -1 when none is, which pauses playback.
	// Direct DOM writes are safe: the rail's className is a static string React never
	// rewrites. Mount-only; anchors are static.
	useEffect(() => {
		const rail = railRef.current;
		if (!rail) return;
		const anchors = Array.from(rail.querySelectorAll<HTMLElement>("[data-rail-section]"));
		let lastIndex = -1;
		let lastProgress = "";

		const onScroll = () => {
			const progress = Math.min(Math.max(1 - rail.getBoundingClientRect().top / window.innerHeight, 0), 1);
			// Skip the style write once the value settles (pinned at 1 for most of the page)
			// so scrolling below the rail doesn't invalidate its subtree every frame.
			const next = progress.toFixed(4);
			if (next !== lastProgress) {
				lastProgress = next;
				rail.style.setProperty("--rail-progress", next);
			}

			// Activation, gated on the intro settling: the last anchor above the line wins.
			let index = -1;
			if (progress >= SETTLE_AT) {
				const line = window.innerHeight * ACTIVATION_LINE;
				for (let i = 0; i < anchors.length; i++) {
					if (anchors[i]!.getBoundingClientRect().top <= line) index = i;
				}
			}
			if (index !== lastIndex) {
				lastIndex = index;
				activate(index);
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
	const currentFile = active?.status === "playing" ? activeWriteFile(active.blocks) : undefined;

	// The tree is stateful: the seed files plus a row the moment a transcript writes it —
	// the active section's in-flight write pops in (highlighted via `currentFile`),
	// completed writes accumulate across sections.
	const files = useMemo<FileNode[]>(() => {
		const paths = new Set<string>(SEED_FILES);
		for (const section of sections) for (const path of writtenFiles(section.blocks)) paths.add(path);
		if (currentFile) paths.add(currentFile);
		return [...paths].map((path) => ({ path }));
	}, [sections, currentFile]);

	function copyInstall() {
		navigator.clipboard.writeText(INSTALL_COMMAND).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	}

	return (
		<>
			{/* Short hero (88svh) so the card below peeks under the fold, hinting there's more. */}
			<main className="flex min-h-[88svh] flex-col items-center justify-center px-6">
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
			{/* The demo rail: story copy sits in normal document flow on the left (no reveal —
			    it scrolls into view like any text) while the card on the right floats (sticky)
			    and plays each section's session. Slide styling lives in styles.css. */}
			<section
				ref={railRef}
				className="relative mx-auto w-full max-w-[88rem] px-6 pb-32 md:grid md:grid-cols-[minmax(280px,340px)_minmax(0,1fr)] md:gap-12"
			>
				<div>
					{/* Section 0: forming. Future sections are their own hand-written blocks (each with
					    data-rail-section + a SESSION_URLS entry), free to diverge in styling and movement.
					    The copy starts ~50svh down the section so it enters the viewport well after the
					    card, instead of crowding in right behind the hero. */}
					<div data-rail-section className="py-16 md:min-h-svh md:py-0 md:pt-[50svh]">
						<h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
							Give each agent a purpose
						</h2>
						<p className="mt-4 max-w-md text-lg text-muted-foreground">
							A wolli agent is born empty. Tell it what it's for and it writes who it is into its SOUL.md.
						</p>
						{/* Mobile: the section carries its own static card; playback still activates on scroll. */}
						<div className="mt-8 md:hidden">
							<DemoCard
								view={sections[0]!}
								hint={RAIL_HINT}
								files={files}
								currentFile={activeIndex === 0 ? currentFile : undefined}
							/>
						</div>
					</div>
				</div>
				<div className="hidden md:block">
					<div className="sticky top-0 flex h-svh items-center">
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
		</>
	);
}
