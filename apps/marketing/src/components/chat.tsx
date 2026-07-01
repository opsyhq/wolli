// Chat: the web copy of the wolli chat. It renders the replayed transcript blocks from
// useSession, mirroring wolli's component + tool-renderer structure (coding-agent's
// modes/interactive/interactive-mode.ts, modes/interactive/components/*, core/tools/*):
//   - user messages render in a subtle bubble,
//   - assistant bubbles render TEXT/THINKING only (toolCall blocks are skipped, exactly
//     like AssistantMessageComponent),
//   - each toolCall renders as a separate tool block AFTER the assistant text, filled by
//     its matching toolResult; the block styling follows tool state.
// While busy, a working indicator (the TUI Loader: accent braille spinner + muted message)
// sits between the transcript and the composer, where wolli's statusContainer lives.
// The composer at the bottom copies wolli's Editor look (Editor.render draws a horizontal
// rule above and below the text, with left padding and a reverse-video block cursor) and
// shows the message being "typed" before it is sent. Styling is entirely Tailwind utilities
// on the Vercel Geist light palette (color tokens live in styles.css @theme);
// Streamdown styles its own markdown and we don't override it.
// Deliberately not ported (TUI/interactive-only): ~-shortened paths and file hyperlinks,
// compact read classification (skill/docs/resource), expand-key hints, result.details
// truncation notices, and the JSON-args fallback for unknown tools.

import { type ReactNode, useEffect, useRef, useState } from "react";
import { codeToHtml } from "shiki";
import { Streamdown } from "streamdown";

import type { ToolBlock, TranscriptBlock } from "@/hooks/use-session";
import type { AssistantMessage } from "@/lib/session";
import { cn } from "@/lib/utils";

export interface ChatProps {
	blocks: TranscriptBlock[];
	busy?: boolean;
	input: string;
	className?: string;
}

const SHIKI_THEME = "github-light";

// ---------------------------------------------------------------------------
// Shared render helpers (ported/mirrored from tool-renderers/render-utils.ts)
// ---------------------------------------------------------------------------

// render-utils.ts `str`, minus its invalid-arg tri-state: demo transcripts are
// hand-authored, so non-string args cannot occur.
function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

// theme.ts getLanguageFromPath (compact subset) -> Shiki-compatible language id.
const EXT_TO_LANG: Record<string, string> = {
	ts: "typescript",
	tsx: "tsx",
	js: "javascript",
	jsx: "jsx",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	rb: "ruby",
	rs: "rust",
	go: "go",
	java: "java",
	c: "c",
	h: "c",
	cpp: "cpp",
	cs: "csharp",
	php: "php",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	sql: "sql",
	html: "html",
	css: "css",
	scss: "scss",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	xml: "xml",
	md: "markdown",
	markdown: "markdown",
	lua: "lua",
};

function getLanguageFromPath(filePath: string): string | undefined {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;
	return EXT_TO_LANG[ext];
}

function textFromResult(result: ToolBlock["result"]): string {
	if (!result) return "";
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => (c.text ?? "").replace(/\r/g, ""))
		.join("\n");
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end--;
	return lines.slice(0, end);
}

// A monospace <pre> for raw tool output / code fallbacks (shared utility set).
const PRE_CLASS = "m-0 whitespace-pre-wrap break-words font-mono text-[13px] text-chat-muted";

// Streamdown with the shared demo config (no controls, chat theme).
function Markdown({ children }: { children: string }) {
	return (
		<Streamdown controls={false} lineNumbers={false} shikiTheme={[SHIKI_THEME, SHIKI_THEME]}>
			{children}
		</Streamdown>
	);
}

// ---------------------------------------------------------------------------
// Shiki code block (inline highlight, mirrors the write/read tool renderers)
// ---------------------------------------------------------------------------

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
	const [html, setHtml] = useState<string | null>(null);

	useEffect(() => {
		if (!lang) {
			setHtml(null);
			return;
		}
		let alive = true;
		codeToHtml(code, { lang, theme: SHIKI_THEME })
			.then((result) => {
				if (alive) setHtml(result);
			})
			.catch(() => {
				if (alive) setHtml(null);
			});
		return () => {
			alive = false;
		};
	}, [code, lang]);

	if (html) {
		// biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki output, sitting on the tool bg.
		return <div dangerouslySetInnerHTML={{ __html: html }} />;
	}
	return <pre className={PRE_CLASS}>{code}</pre>;
}

// ---------------------------------------------------------------------------
// Tool block title + body (mirrors tool-renderers/*)
// ---------------------------------------------------------------------------

function readLineRange(args: { offset?: number; limit?: number } | undefined) {
	if (!args || (args.offset === undefined && args.limit === undefined)) return null;
	const start = args.offset ?? 1;
	const end = args.limit !== undefined ? start + args.limit - 1 : "";
	return <span className="text-chat-warning">{`:${start}${end ? `-${end}` : ""}`}</span>;
}

// renderToolPath: accent path, or a muted "..." when the arg is missing. Only ls passes
// an empty-path fallback (".") — read/write/edit show "..." like wolli.
function ToolPath({ path, fallback }: { path: string; fallback?: string }) {
	const value = path || fallback;
	if (!value) return <span className="text-chat-muted">...</span>;
	return <span className="text-chat-accent">{value}</span>;
}

function ToolTitle({ name, args }: { name: string; args: Record<string, unknown> }) {
	const path = str(args.file_path ?? args.path);
	const limit = typeof args.limit === "number" ? args.limit : undefined;

	switch (name) {
		case "write":
		case "edit":
			return (
				<>
					<b>{name}</b> <ToolPath path={path} />
				</>
			);
		case "read":
			return (
				<>
					<b>read</b> <ToolPath path={path} />
					{readLineRange(args as { offset?: number; limit?: number })}
				</>
			);
		case "ls":
			return (
				<>
					<b>ls</b> <ToolPath path={path} fallback="." />
					{limit !== undefined ? <span className="text-chat-muted"> (limit {limit})</span> : null}
				</>
			);
		case "bash": {
			const timeout = typeof args.timeout === "number" ? args.timeout : undefined;
			return (
				<>
					<b>
						{"$ "}
						{str(args.command) || "..."}
					</b>
					{timeout !== undefined ? <span className="text-chat-muted"> (timeout {timeout}s)</span> : null}
				</>
			);
		}
		case "grep":
		case "find": {
			const pattern = str(args.pattern);
			const glob = name === "grep" ? str(args.glob) : "";
			return (
				<>
					<b>{name}</b> <span className="text-chat-accent">{name === "grep" ? `/${pattern}/` : pattern}</span>
					<span className="text-chat-muted"> in {str(args.path) || "."}</span>
					{glob ? <span className="text-chat-muted"> ({glob})</span> : null}
					{limit !== undefined ? (
						<span className="text-chat-muted">{name === "grep" ? ` limit ${limit}` : ` (limit ${limit})`}</span>
					) : null}
				</>
			);
		}
		default:
			return <b>{name}</b>;
	}
}

// Truncated tool output. Head by default; bash previews the tail with the skipped-line
// count above, like rebuildBashResultRenderComponent.
function OutputText({ text, maxLines, tail = false }: { text: string; maxLines: number; tail?: boolean }) {
	const trimmed = text.trim();
	if (!trimmed) return null;
	const lines = trimmed.split("\n");
	const hidden = lines.length - maxLines;
	if (hidden <= 0) return <pre className={PRE_CLASS}>{trimmed}</pre>;
	if (tail) {
		return (
			<pre className={PRE_CLASS}>
				{`... (${hidden} earlier lines)\n`}
				{lines.slice(hidden).join("\n")}
			</pre>
		);
	}
	return (
		<pre className={PRE_CLASS}>
			{lines.slice(0, maxLines).join("\n")}
			{`\n... (${hidden} more lines)`}
		</pre>
	);
}

function WriteBody({ args }: { args: Record<string, unknown> }) {
	const content = str(args.content);
	if (!content) return null;
	const lang = getLanguageFromPath(str(args.file_path ?? args.path));
	const lines = trimTrailingEmptyLines(content.replace(/\r/g, "").split("\n"));
	const maxLines = 10;
	const shown = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	return (
		<div className="mt-1.5">
			<CodeBlock code={shown.join("\n")} lang={lang} />
			{remaining > 0 ? (
				<div className="text-chat-muted">{`... (${remaining} more lines, ${lines.length} total)`}</div>
			) : null}
		</div>
	);
}

function ToolBody({ block, state }: { block: ToolBlock; state: string }) {
	const args = (block.args ?? {}) as Record<string, unknown>;
	const output = textFromResult(block.result);
	const errorText = state === "error" && output ? <div className="mt-1.5 text-chat-error">{output}</div> : null;

	// write shows its content and, like formatWriteResult, error output only.
	if (block.name === "write") {
		return (
			<>
				<WriteBody args={args} />
				{errorText}
			</>
		);
	}

	// edit's success diff (result.details) is not shown in the demo; errors surface in red.
	if (block.name === "edit") return errorText;

	// Collapsed read (the default in wolli) shows output only when the call errored.
	if (block.name === "read") {
		if (state !== "error") return null;
		return (
			<div className="mt-1.5">
				<OutputText text={output} maxLines={10} />
			</div>
		);
	}

	// bash previews the tail of the output (BASH_PREVIEW_LINES = 5).
	if (block.name === "bash") {
		return (
			<div className="mt-1.5">
				<OutputText text={output} maxLines={5} tail />
			</div>
		);
	}

	// ls/find/generic show 20 lines, grep 15, errored or not — state colors carry the error.
	return (
		<div className="mt-1.5">
			<OutputText text={output} maxLines={block.name === "grep" ? 15 : 20} />
		</div>
	);
}

// ---------------------------------------------------------------------------
// Block components
// ---------------------------------------------------------------------------

function UserMessage({ text }: { text: string }) {
	return (
		<div className="rounded-[10px] bg-chat-subtle px-3 py-2 text-chat-text">
			<Markdown>{text}</Markdown>
		</div>
	);
}

// Mirrors AssistantMessageComponent.updateContent: renders text/thinking in order,
// skipping toolCall blocks (they render as separate tool blocks).
function AssistantMessageView({ message }: { message: AssistantMessage }) {
	// Content blocks only ever append while streaming, so the index is a stable key.
	const parts = message.content
		.map((content, index): ReactNode => {
			if (content.type === "text" && content.text.trim()) {
				// biome-ignore lint/suspicious/noArrayIndexKey: append-only content, index is stable.
				return <Markdown key={index}>{content.text.trim()}</Markdown>;
			}
			if (content.type === "thinking" && content.thinking.trim()) {
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: append-only content, index is stable.
					<div key={index} className="italic text-chat-muted">
						<Markdown>{content.thinking.trim()}</Markdown>
					</div>
				);
			}
			return null;
		})
		.filter(Boolean);

	// Error/abort notice after the partial content, but only when there are no tool calls
	// (the tool blocks show the error instead) — mirrors AssistantMessageComponent.
	let notice: ReactNode = null;
	if (!message.content.some((c) => c.type === "toolCall")) {
		if (message.stopReason === "aborted") {
			const text =
				message.errorMessage && message.errorMessage !== "Request was aborted"
					? message.errorMessage
					: "Operation aborted";
			notice = <div className="text-chat-error">{text}</div>;
		} else if (message.stopReason === "error") {
			notice = <div className="text-chat-error">Error: {message.errorMessage || "Unknown error"}</div>;
		}
	}

	if (parts.length === 0 && !notice) return null;
	return (
		<div className="flex flex-col gap-2">
			{parts}
			{notice}
		</div>
	);
}

function ToolExecution({ block }: { block: ToolBlock }) {
	const state = block.result && !block.isPartial ? (block.result.isError ? "error" : "success") : "pending";
	const args = (block.args ?? {}) as Record<string, unknown>;
	return (
		<div
			className="rounded-[10px] border border-chat-border bg-chat-surface px-3 py-2 data-[state=error]:border-[rgba(229,72,77,0.3)] data-[state=success]:border-[rgba(0,199,88,0.25)] data-[state=error]:bg-chat-tool-error data-[state=success]:bg-chat-tool-success"
			data-state={state}
		>
			<div className="text-chat-text [&_b]:font-semibold">
				<ToolTitle name={block.name} args={args} />
			</div>
			<ToolBody block={block} state={state} />
		</div>
	);
}

function Block({ block }: { block: TranscriptBlock }) {
	switch (block.kind) {
		case "user":
			return <UserMessage text={block.text} />;
		case "assistant":
			return <AssistantMessageView message={block.message} />;
		case "tool":
			return <ToolExecution block={block} />;
	}
}

// ---------------------------------------------------------------------------
// Working indicator — the TUI Loader (tui/components/loader.ts): braille spinner frames
// at 80ms, spinner in accent, message in muted. Added on agent_start and removed on
// agent_end, pinned between the chat and the editor (statusContainer).
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

function WorkingIndicator() {
	const [frame, setFrame] = useState(0);

	useEffect(() => {
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const id = setInterval(() => setFrame((current) => (current + 1) % SPINNER_FRAMES.length), SPINNER_INTERVAL_MS);
		return () => clearInterval(id);
	}, []);

	return (
		<div className="flex-none px-[18px] pb-2">
			<span className="text-chat-accent">{SPINNER_FRAMES[frame]}</span>
			<span className="text-chat-muted"> Working...</span>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Composer — a web copy of wolli's Editor: a rule above and below the input (a full-width
// horizontal line each, like Editor.render), left padding, and a reverse-video block cursor.
// ---------------------------------------------------------------------------

function Composer({ input }: { input: string }) {
	return (
		<div className="flex-none bg-chat-bg px-[18px] pb-3">
			<div className="border-y border-chat-border px-[1ch] py-1.5 break-words whitespace-pre-wrap text-chat-text">
				<span>{input}</span>
				<span
					aria-hidden
					className="ml-px inline-block h-[1.15em] w-[1ch] animate-blink bg-chat-text align-text-bottom motion-reduce:animate-none"
				/>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export function Chat({ blocks, busy = false, input, className }: ChatProps) {
	const scrollRef = useRef<HTMLDivElement>(null);

	// Keep the newest content in view as the transcript grows and the composer types.
	// biome-ignore lint/correctness/useExhaustiveDependencies: deps are intentional triggers — re-scroll on any transcript/composer change.
	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [blocks, input]);

	return (
		<div
			className={cn(
				"flex h-full flex-col overflow-hidden text-left font-mono text-[13px] leading-[1.6] text-chat-text",
				className,
			)}
		>
			<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-[18px] pt-[18px] pb-3" ref={scrollRef}>
				{blocks.map((block) => (
					<Block key={block.key} block={block} />
				))}
			</div>
			{busy ? <WorkingIndicator /> : null}
			<Composer input={input} />
		</div>
	);
}
