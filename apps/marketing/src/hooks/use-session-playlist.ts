// Orchestration across the demo rail's sessions. The rail scroll effect in
// routes/index.tsx calls activate(j) as the viewer scrolls; this hook enforces
// play-once/never-rewind semantics around an internal frontier (the highest index ever
// activated), commanding one SessionPlayer per url (lib/session-player.ts) and
// projecting their snapshots into React state. Invariant: below the frontier every
// section is done; the frontier is playing or done; above it everything is idle.
//   - j <= frontier: only activeIndex moves — a done section shows its folded transcript,
//     and a still-playing frontier keeps playing (scrolling back never aborts it).
//   - j > frontier: the current driver is aborted, every not-done section in [frontier, j)
//     folds to its complete transcript, and j starts playing.
// `urls` is treated as immutable (a module constant in the route).

import { useCallback, useEffect, useRef, useState } from "react";

import { SessionPlayer, type SessionPlayerStatus, type TranscriptBlock } from "@/lib/session-player";

export type SectionStatus = SessionPlayerStatus;

export interface PlaylistSection {
	status: SectionStatus;
	/** Empty while idle; live while playing; the folded full transcript when done. */
	blocks: TranscriptBlock[];
	busy: boolean;
	input: string;
}

export interface UseSessionPlaylistResult {
	/** One slot per url, in playlist order. */
	sections: PlaylistSection[];
	/** The section the viewer sees; -1 before the first activation. */
	activeIndex: number;
	/** Idempotent; safe to call straight from a scroll handler. */
	activate: (index: number) => void;
}

// The immutable React-state view of a (mutable) player.
function project(player: SessionPlayer): PlaylistSection {
	return { status: player.status, ...player.snapshot };
}

export function useSessionPlaylist(urls: string[]): UseSessionPlaylistResult {
	// One player per url, created once (urls are immutable).
	const playersRef = useRef<SessionPlayer[] | null>(null);
	playersRef.current ??= urls.map((url) => new SessionPlayer(url));
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
			if (index < 0 || index >= players.length) return;
			// At or behind the frontier: just move the viewer; never rewind or replay.
			if (index <= frontierRef.current) {
				setActiveIndex(index);
				return;
			}
			controllerRef.current?.abort();
			// Fold every not-done section below the new frontier to its full transcript.
			for (let i = Math.max(frontierRef.current, 0); i < index; i++) {
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

	return { sections, activeIndex, activate };
}
