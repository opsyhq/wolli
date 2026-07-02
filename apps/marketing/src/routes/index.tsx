import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Chat } from "@/components/chat";
import { type FileNode, FileTree } from "@/components/file-tree";
import { Button } from "@/components/ui/button";
import { type PlaylistSection, useSessionPlaylist } from "@/hooks/use-session-playlist";
import { activeWriteFile, writtenFiles } from "@/lib/session-player";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({ component: Home });

const INSTALL_COMMAND = "npm i -g wolli";
const agentName = "scout";

// What actually exists in ~/.wolli/agents/<name> at birth (AgentSettingsManager.createAgent):
// three curated files, created EMPTY — the agent fills them itself. agent.json / sessions/ /
// workspace/ are runtime plumbing, not the story.
const BIRTH_FILES = ["SOUL.md", "MEMORY.md", "USER.md"] as const;

// One url per [data-rail-section] block below, in DOM order — section i plays
// SESSION_URLS[i] when its block crosses the activation line.
const SESSION_URLS = ["/sessions/forming.jsonl"];

// Shown in the empty chat before the first section activates.
const RAIL_HINT = "scroll to watch scout form";

// The rail effect writes `--rail-progress` onto the rail element (raw linear, so the card
// tracks the scroll 1:1 and freezes when it stops); below SETTLE_AT the intro attribute
// hides the copy and activation is held off (ungated, section 1 would start playing
// mid-slide at ~0.3 progress).
const SETTLE_AT = 0.8; // copy reveal gate + activation gate
const ACTIVATION_LINE = 0.7; // fraction of viewport height

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
			<div className="grid grid-cols-[1fr_auto] border-b border-chat-border md:grid-cols-[1fr_260px]">
				<div className="min-w-0 px-4 py-3 font-mono text-[13px] font-medium text-chat-text">{agentName}</div>
				<div className="truncate px-4 py-3 font-mono text-[13px] text-chat-muted md:border-l md:border-chat-border">
					~/.wolli/agents/{agentName}
				</div>
			</div>
			<div className="flex flex-col md:grid md:h-[520px] md:grid-cols-[1fr_260px]">
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
	const { sections, activeIndex, activate } = useSessionPlaylist(SESSION_URLS);

	// The rail scroll effect: one passive scroll listener writes normalized progress into
	// `--rail-progress` (CSS maps it to the card slide), toggles `data-rail-intro` for the
	// copy reveal, and calls activate(i) when a section's anchor crosses the activation
	// line (play once, fold skipped, never rewind). Direct DOM writes are safe: the rail's
	// className is a static string React never rewrites. Mount-only; anchors are static.
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
				rail.toggleAttribute("data-rail-intro", progress < SETTLE_AT);
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
				if (index >= 0) activate(index);
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

	// The tree is disk truth: the birth files plus everything any section's transcript has
	// written so far — accumulated across sessions, never hardcoded.
	const files = useMemo<FileNode[]>(() => {
		const paths = new Set<string>(BIRTH_FILES);
		for (const section of sections) for (const path of writtenFiles(section.blocks)) paths.add(path);
		return [...paths].map((path) => ({ path }));
	}, [sections]);

	const active = activeIndex >= 0 ? sections[activeIndex] : undefined;
	const currentFile = active?.status === "playing" ? activeWriteFile(active.blocks) : undefined;

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
			{/* The demo rail: story sections scroll past on the left while the pinned card on the
			    right plays each section's session. Styling for the slide/reveal lives in styles.css
			    under "Demo rail". */}
			<section
				ref={railRef}
				className="relative mx-auto w-full max-w-6xl px-6 pb-32 md:grid md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:gap-12"
			>
				<div>
					{/* Section 0: forming. Future sections are their own hand-written blocks (each with
					    data-rail-section + a SESSION_URLS entry), free to diverge in styling and movement. */}
					<div data-rail-section className="rail-copy flex flex-col justify-center py-16 md:min-h-svh md:py-0">
						<h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
							Give each agent a purpose
						</h2>
						<p className="mt-4 max-w-md text-lg text-muted-foreground">
							A wolli agent is born empty — no memory, no habits, just a question. Tell it what it's for and it
							writes who it is into its own SOUL.md, kept for every session after.
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
