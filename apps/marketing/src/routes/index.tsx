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

// Seeded empty at birth by createAgent. SOUL.md is too, but the demo holds it back
// so the write visibly creates it.
const SEED_FILES = ["MEMORY.md", "USER.md"];

// One url per [data-rail-section] block below, in DOM order.
const SESSION_URLS = ["/sessions/forming.jsonl"];

const RAIL_HINT = "scroll to watch scout form";

const LOCK_AT = 0.5; // fraction of the pin distance the slide takes
const ACTIVATION_LINE = 0.7; // fraction of viewport height

type PlaylistSection = { status: SessionPlayerStatus } & SessionSnapshot;

function project(player: SessionPlayer): PlaylistSection {
	return { status: player.status, ...player.snapshot };
}

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

	// One player per url, created once; activate() enforces the frontier rules on them.
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

	useEffect(() => () => controllerRef.current?.abort(), []);

	// Players mutate in place; re-project them all into fresh section objects so React re-renders.
	const sync = useCallback(() => setSections(players.map(project)), [players]);

	const activate = useCallback(
		(index: number) => {
			const frontier = frontierRef.current;
			const playing = frontier >= 0 ? players[frontier] : undefined;
			// Out of view: pause and show the hint again; re-entry resumes the transcript.
			if (index < 0 || index >= players.length) {
				playing?.pause();
				setActiveIndex(-1);
				return;
			}
			// At or behind the frontier: never rewind; the frontier runs only while in view.
			if (index <= frontier) {
				if (index === frontier) playing?.resume();
				else playing?.pause();
				setActiveIndex(index);
				return;
			}
			controllerRef.current?.abort();
			// Skipped sections fold: their files must exist before a later section plays.
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

	// One passive listener drives the card slide (--rail-progress) and section activation.
	// Direct DOM writes are safe: the rail's className is static.
	useEffect(() => {
		const rail = railRef.current;
		if (!rail) return;
		const anchors = Array.from(rail.querySelectorAll<HTMLElement>("[data-rail-section]"));
		let lastIndex = -1;
		let lastProgress = "";

		const onScroll = () => {
			const progress = Math.min(Math.max(1 - rail.getBoundingClientRect().top / window.innerHeight, 0), 1);
			const slide = Math.min(progress / LOCK_AT, 1);
			// Skip the write when unchanged so scrolling below the rail stays free.
			const next = slide.toFixed(4);
			if (next !== lastProgress) {
				lastProgress = next;
				rail.style.setProperty("--rail-progress", next);
			}

			// The last anchor above the line wins; nothing activates before the card locks in.
			let index = -1;
			if (slide >= 1) {
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
	// The active section's write stays highlighted for as long as the section is active —
	// the cue to what it added — and clears only when another section takes over.
	const currentFile = active ? activeWriteFile(active.blocks) : undefined;

	// Seed files plus everything transcripts write; the in-flight write appears immediately.
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
			<section
				ref={railRef}
				className="relative mx-auto w-full max-w-[88rem] px-6 pb-32 md:grid md:grid-cols-[minmax(280px,340px)_minmax(0,1fr)] md:gap-12"
			>
				<div>
					{/* Section 0: forming. Each future section is its own block with
					    data-rail-section + a SESSION_URLS entry. */}
					<div data-rail-section className="py-16 md:min-h-svh md:py-0 md:pt-[30svh]">
						<h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
							Give each agent a purpose
						</h2>
						<p className="mt-4 max-w-md text-lg text-muted-foreground">
							A wolli agent is born empty. Tell it what it's for and it writes who it is into its SOUL.md.
						</p>
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
		</>
	);
}
