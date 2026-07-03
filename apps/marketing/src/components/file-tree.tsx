// The directory pane of the card: a real tree derived from the written paths — folders
// nest to any depth, everything in first-appearance order at each level. Rows fade in on
// add and the `currentFile` row highlights.

import { cn } from "@/lib/utils";

export interface FileTreeProps {
	/** Paths relative to the agent home; no "/" means a root file (e.g. "USER.md"). */
	files: string[];
	currentFile?: string;
	className?: string;
}

interface TreeRow {
	/** The rendered name: file basename, or folder name with a trailing "/". */
	label: string;
	/** Full path from the root — the row key, and what `currentFile` matches for files. */
	path: string;
	depth: number;
}

const ROW =
	"cursor-pointer rounded-md px-2 py-2.5 font-mono text-[13px] text-chat-muted transition-colors hover:bg-chat-subtle";

export function FileTree({ files, currentFile, className }: FileTreeProps) {
	// Flatten paths into indented rows, depth-first, keeping first-appearance order at
	// each level (which is write order, so the tree grows chronologically).
	const rows: TreeRow[] = [];
	const append = (paths: string[], base: string, depth: number): void => {
		const seen = new Set<string>();
		for (const path of paths) {
			const slash = path.indexOf("/");
			if (slash === -1) {
				rows.push({ label: path, path: base + path, depth });
				continue;
			}
			const dir = path.slice(0, slash);
			if (seen.has(dir)) continue;
			seen.add(dir);
			rows.push({ label: `${dir}/`, path: `${base}${dir}/`, depth });
			const children = paths.filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1));
			append(children, `${base}${dir}/`, depth + 1);
		}
	};
	append(files, "", 0);
	return (
		<div className={cn("h-full overflow-y-auto p-2", className)}>
			{rows.map((row) => (
				<div
					key={row.path}
					className={cn(
						ROW,
						"animate-in fade-in motion-reduce:animate-none",
						row.path === currentFile && "bg-chat-subtle font-medium text-chat-text",
					)}
					style={row.depth > 0 ? { paddingLeft: `${8 + row.depth * 16}px` } : undefined}
				>
					{row.label}
				</div>
			))}
		</div>
	);
}
