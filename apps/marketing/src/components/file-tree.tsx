// The directory pane of the card: root-level files first, then wolli's native folders with their
// files nested. Static/prop-driven for now; rows fade in on add and the `currentFile` row highlights.

import { cn } from "@/lib/utils";

// A path relative to the agent home; no "/" means a root file (e.g. "USER.md"). Mirrors WriteToolInput.
export interface FileNode {
	path: string;
}

export interface FileTreeProps {
	files: FileNode[];
	currentFile?: string;
	className?: string;
}

const NATIVE_FOLDERS = ["skills", "integrations", "extensions"] as const;

const ROW =
	"cursor-pointer rounded-md px-2 py-2.5 font-mono text-[13px] text-chat-muted transition-colors hover:bg-chat-subtle";

// Keyed by path so only newly-added files animate in; `nested` adds the folder indent.
function FileRow({ label, active, nested }: { label: string; active: boolean; nested?: boolean }) {
	return (
		<div
			className={cn(
				ROW,
				"animate-in fade-in motion-reduce:animate-none",
				nested && "pl-6",
				active && "bg-chat-subtle font-medium text-chat-text",
			)}
		>
			{label}
		</div>
	);
}

export function FileTree({ files, currentFile, className }: FileTreeProps) {
	const rootFiles = files.filter((file) => !file.path.includes("/"));
	return (
		<div className={cn("h-full overflow-y-auto p-2", className)}>
			{rootFiles.map((file) => (
				<FileRow key={file.path} label={file.path} active={file.path === currentFile} />
			))}
			{NATIVE_FOLDERS.map((folder) => {
				const prefix = `${folder}/`;
				const children = files.filter((file) => file.path.startsWith(prefix));
				// Birth creates no native folders; one appears when a session first writes into it.
				if (children.length === 0) return null;
				return (
					<div key={folder}>
						<div className={ROW}>{prefix}</div>
						{children.map((file) => (
							<FileRow
								key={file.path}
								label={file.path.slice(prefix.length)}
								active={file.path === currentFile}
								nested
							/>
						))}
					</div>
				);
			})}
		</div>
	);
}
