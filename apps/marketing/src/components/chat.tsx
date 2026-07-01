// Chat: the web copy of the wolli chat. It renders the replayed transcript blocks from
// useSession, mirroring wolli's component + tool-renderer structure (chat-view.ts,
// components/*, tool-renderers/*):
//   - user messages render in a subtle bubble,
//   - assistant bubbles render TEXT/THINKING only (toolCall blocks are skipped, exactly
//     like AssistantMessageComponent),
//   - each toolCall renders as a separate tool block AFTER the assistant text, filled by
//     its matching toolResult; the block styling follows tool state.
// The composer at the bottom copies wolli's Editor look (Editor.render draws a horizontal
// rule above and below the text, with left padding and a reverse-video block cursor) and
// shows the message being "typed" before it is sent. Styling is entirely Tailwind utilities
// on the eve.dev (Vercel Geist) light palette (color tokens live in styles.css @theme);
// Streamdown styles its own markdown and we don't override it.

import { type ReactNode, useEffect, useRef, useState } from "react";
import { codeToHtml } from "shiki";
import { Streamdown } from "streamdown";

import type { ToolBlock, TranscriptBlock } from "@/hooks/use-session";
import type { AssistantMessage } from "@/lib/session";

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

// render-utils.ts `str`: string -> string, null/undefined -> "", anything else -> null.
function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
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

function ToolTitle({ name, args }: { name: string; args: Record<string, unknown> }) {
	const path = str(args.file_path ?? args.path);
	const pathNode =
		path === null ? (
			<span className="text-chat-error">[invalid arg]</span>
		) : (
			<span className="text-chat-accent">{path || "."}</span>
		);

	switch (name) {
		case "write":
			return (
				<>
					<b>write</b> {pathNode}
				</>
			);
		case "read":
			return (
				<>
					<b>read</b> {pathNode}
					{readLineRange(args as { offset?: number; limit?: number })}
				</>
			);
		case "edit":
			return (
				<>
					<b>edit</b> {pathNode}
				</>
			);
		case "ls":
			return (
				<>
					<b>ls</b> {pathNode}
				</>
			);
		case "bash": {
			const command = str(args.command);
			return (
				<b>
					{"$ "}
					{command === null ? "[invalid arg]" : command || "..."}
				</b>
			);
		}
		case "grep":
		case "find": {
			const pattern = str(args.pattern);
			const inPath = str(args.path);
			return (
				<>
					<b>{name}</b>{" "}
					<span className="text-chat-accent">{name === "grep" ? `/${pattern ?? ""}/` : (pattern ?? "")}</span>
					<span className="text-chat-muted"> in {inPath || "."}</span>
				</>
			);
		}
		default:
			return <b>{name}</b>;
	}
}

function OutputText({ text, maxLines }: { text: string; maxLines: number }) {
	const trimmed = text.trim();
	if (!trimmed) return null;
	const lines = trimmed.split("\n");
	const display = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	return (
		<pre className={PRE_CLASS}>
			{display.join("\n")}
			{remaining > 0 ? `\n... (${remaining} more lines)` : ""}
		</pre>
	);
}

function WriteBody({ args }: { args: Record<string, unknown> }) {
	const path = str(args.file_path ?? args.path);
	const content = str(args.content);
	if (!content) return null;
	const lang = path ? getLanguageFromPath(path) : undefined;
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

	if (block.name === "write") return <WriteBody args={args} />;

	if (block.name === "read") {
		// Collapsed read (the default in wolli) shows only the title; surface errors.
		if (state === "error" && output) return <div className="mt-1.5 text-chat-error">{output}</div>;
		return null;
	}

	if (block.name === "edit") return null; // diff lives in result.details, not shown in the demo

	if (state === "error" && output) return <div className="mt-1.5 text-chat-error">{output}</div>;

	// bash/ls/grep/find/generic: show the (truncated) text output.
	const maxLines = block.name === "bash" ? 10 : block.name === "grep" ? 15 : 20;
	return (
		<div className="mt-1.5">
			<OutputText text={output} maxLines={maxLines} />
		</div>
	);
}

// ---------------------------------------------------------------------------
// Block components
// ---------------------------------------------------------------------------

function UserMessage({ text }: { text: string }) {
	return (
		<div className="rounded-[10px] bg-chat-subtle px-3 py-2 text-chat-text">
			<Streamdown controls={false} lineNumbers={false} shikiTheme={[SHIKI_THEME, SHIKI_THEME]}>
				{text}
			</Streamdown>
		</div>
	);
}

// Mirrors AssistantMessageComponent.updateContent: renders text/thinking in order,
// skipping toolCall blocks (they render as separate tool blocks).
function AssistantMessageView({ message }: { message: AssistantMessage }) {
	const parts: Array<{ key: string; node: ReactNode }> = [];
	message.content.forEach((content, index) => {
		if (content.type === "text" && content.text.trim()) {
			parts.push({
				key: `t${index}`,
				node: (
					<Streamdown controls={false} lineNumbers={false} shikiTheme={[SHIKI_THEME, SHIKI_THEME]}>
						{content.text.trim()}
					</Streamdown>
				),
			});
		} else if (content.type === "thinking" && content.thinking.trim()) {
			parts.push({
				key: `k${index}`,
				node: (
					<div className="italic text-chat-muted">
						<Streamdown controls={false} lineNumbers={false}>
							{content.thinking.trim()}
						</Streamdown>
					</div>
				),
			});
		}
	});
	if (parts.length === 0) return null;
	return (
		<div className="flex flex-col gap-2">
			{parts.map((part) => (
				<div key={part.key}>{part.node}</div>
			))}
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
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Composer — a web copy of wolli's Editor: a rule above and below the input (a full-width
// horizontal line each, like Editor.render), left padding, and a reverse-video block cursor.
// ---------------------------------------------------------------------------

function Composer({ input }: { input: string }) {
	return (
		<div className="flex-none bg-chat-bg px-[18px] pb-3">
			<div className="border-y border-chat-border py-1.5 pr-[1ch] pl-[1ch] break-words whitespace-pre-wrap text-chat-text">
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
	}, [blocks, input, busy]);

	return (
		<div
			className={`flex h-[560px] flex-col overflow-hidden rounded-[14px] border border-chat-border bg-chat-bg text-left font-mono text-[13px] leading-[1.6] text-chat-text shadow-[0_16px_40px_-24px_rgba(0,0,0,0.25)]${
				className ? ` ${className}` : ""
			}`}
		>
			<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-[18px] pt-[18px] pb-3" ref={scrollRef}>
				{blocks.map((block) => (
					<Block key={block.key} block={block} />
				))}
			</div>
			<Composer input={input} />
		</div>
	);
}
