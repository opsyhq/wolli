/**
 * Interactive TUI chat mode.
 *
 * Mirrors `@opsyhq/coding-agent`'s `InteractiveMode` class shape (`constructor(host,
 * options)`, `run()`, `stop()`) but stays minimal: it bridges the `AgentHarness`
 * event stream onto a small retained-mode component tree (a chat log `Container`, a
 * status `Container` holding a `Loader`, and an `Editor`). Streaming assistant text
 * mutates a single `Markdown` component in place so the prefix cache and the renderer
 * both stay warm.
 *
 * Subscribe handlers must stay fast and non-throwing — a throw inside one surfaces as
 * an `AgentHarnessError("hook")` and would abort the turn.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type AgentHarness, AgentHarnessError, type AgentHarnessEvent, type AgentMessage } from "@opsyhq/agent";
import {
	Container,
	Editor,
	Loader,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	ProcessTerminal,
	Spacer,
	Text,
	TUI,
} from "@opsyhq/tui";
import { commissionAgent, isCommissioned } from "../../core/agent-config.ts";
import type { SessionHost } from "../../core/session-host.ts";
import { collectText, isFailureMessage } from "../message.ts";
import { getEditorTheme, getMarkdownTheme, style } from "./theme.ts";

/** Window (ms) within which a second Ctrl+C quits instead of clearing the editor. */
const CTRL_C_EXIT_WINDOW_MS = 500;

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return (message as { role?: string }).role === "assistant";
}

export class InteractiveMode {
	private readonly sessionHost: SessionHost;
	private readonly ui: TUI;
	private readonly chatContainer: Container;
	private readonly statusContainer: Container;
	private readonly editorContainer: Container;
	private readonly editor: Editor;
	private readonly loader: Loader;
	private readonly markdownTheme: MarkdownTheme;

	private unsubscribe?: () => void;
	private removeInputListener?: () => void;
	private resolveExit?: () => void;
	private busy = false;
	private streamingMarkdown?: Markdown;
	private lastSigintTime = 0;
	private stopped = false;

	constructor(host: SessionHost) {
		this.sessionHost = host;
		this.ui = new TUI(new ProcessTerminal());
		this.chatContainer = new Container();
		this.statusContainer = new Container();
		this.editorContainer = new Container();
		this.markdownTheme = getMarkdownTheme();
		this.editor = new Editor(this.ui, getEditorTheme(), { paddingX: 1 });
		this.loader = new Loader(this.ui, style.cyan, style.dim, "Thinking...");
		// The Loader starts its animation timer on construction; halt it until busy.
		this.loader.stop();
	}

	/** The live harness, sourced from the session host (swapped on commission). */
	private get harness(): AgentHarness {
		return this.sessionHost.harness;
	}

	run(): Promise<void> {
		this.editor.onSubmit = (text) => {
			void this.handleSubmit(text);
		};
		this.subscribeToHost();
		this.removeInputListener = this.ui.addInputListener((data) => this.handleGlobalInput(data));

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.statusContainer);
		this.ui.addChild(this.editorContainer);
		this.editorContainer.addChild(this.editor);

		this.appendHeader();

		this.ui.setFocus(this.editor);
		this.ui.start();

		return new Promise<void>((resolve) => {
			this.resolveExit = resolve;
		});
	}

	/** (Re)subscribe to the current harness's event stream. */
	private subscribeToHost(): void {
		this.unsubscribe = this.harness.subscribe((event) => {
			this.handleEvent(event);
		});
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.loader.stop();
		this.unsubscribe?.();
		this.removeInputListener?.();
		this.ui.stop();
		this.resolveExit?.();
	}

	private appendHeader(): void {
		const config = this.sessionHost.config;
		const lines = [style.bold(config.name)];
		const trimmedPurpose = config.purpose.trim();
		if (trimmedPurpose) {
			lines.push(style.dim(trimmedPurpose));
		}
		if (!isCommissioned(config)) {
			lines.push(style.dim("Forming — it will ask to be commissioned; type /commission to finalize manually."));
		}
		lines.push(style.dim("Ctrl+C to exit."));
		this.chatContainer.addChild(new Text(lines.join("\n"), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
	}

	private async handleSubmit(text: string): Promise<void> {
		const trimmed = text.trim();
		if (trimmed.length === 0 || this.busy) return;

		// Slash commands are intercepted before reaching the model.
		if (trimmed === "/commission" || trimmed === "/finalize") {
			this.editor.setText("");
			await this.handleCommission();
			return;
		}

		this.editor.setText("");
		this.statusContainer.clear();
		this.appendUserMessage(trimmed);
		this.ui.requestRender();
		try {
			await this.harness.prompt(trimmed);
		} catch (error) {
			if (error instanceof AgentHarnessError && error.code === "busy") return;
			this.appendErrorLine(error instanceof Error ? error.message : String(error));
			this.ui.requestRender();
		}
	}

	/**
	 * `/commission` — flip the human-held latch, then swap to a fresh session in
	 * place via the session host (like coding-agent's `/new` →
	 * `runtimeHost.newSession()`): unsubscribe from the old harness, have the host
	 * build a new one whose frozen prompt no longer carries the birth instruction,
	 * and re-subscribe. The TUI is never torn down.
	 */
	private async handleCommission(): Promise<void> {
		if (isCommissioned(this.sessionHost.config)) {
			this.appendErrorLine("Already commissioned.");
			this.ui.requestRender();
			return;
		}

		commissionAgent(this.sessionHost.config.name);
		this.unsubscribe?.();
		try {
			// On success the host swaps in the new harness; on failure it keeps the old.
			await this.sessionHost.newSession();
		} catch (error) {
			this.subscribeToHost();
			this.appendErrorLine(error instanceof Error ? error.message : String(error));
			this.ui.requestRender();
			return;
		}
		this.subscribeToHost();

		// Reset transient per-session UI state.
		this.streamingMarkdown = undefined;
		this.setBusy(false);
		this.appendToolLine("✓ Commissioned — fresh session started.");
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	private handleEvent(event: AgentHarnessEvent): void {
		switch (event.type) {
			case "agent_start":
				this.setBusy(true);
				break;
			case "message_start":
				// Failure messages are surfaced at message_end; don't open a bubble for them.
				if (isAssistantMessage(event.message) && !isFailureMessage(event.message)) this.beginAssistantMessage();
				break;
			case "message_update":
				if (isAssistantMessage(event.message) && !isFailureMessage(event.message))
					this.updateAssistantMessage(event.message);
				break;
			case "message_end":
				if (isAssistantMessage(event.message)) this.finalizeAssistantMessage(event.message);
				break;
			case "tool_execution_start":
				this.appendToolLine(event.toolName);
				break;
			case "agent_end":
				this.setBusy(false);
				break;
			default:
				return;
		}
		this.ui.requestRender();
	}

	private appendUserMessage(text: string): void {
		this.chatContainer.addChild(new Text(`${style.cyan("›")} ${text}`, 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.streamingMarkdown = undefined;
	}

	private beginAssistantMessage(): void {
		this.streamingMarkdown = new Markdown("", 1, 0, this.markdownTheme);
		this.chatContainer.addChild(this.streamingMarkdown);
	}

	private updateAssistantMessage(message: AssistantMessage): void {
		if (!this.streamingMarkdown) this.beginAssistantMessage();
		this.streamingMarkdown?.setText(collectText(message));
	}

	private finalizeAssistantMessage(message: AssistantMessage): void {
		if (isFailureMessage(message)) {
			// Drop any partial bubble and show the error/abort detail instead.
			if (this.streamingMarkdown) {
				this.chatContainer.removeChild(this.streamingMarkdown);
				this.streamingMarkdown = undefined;
			}
			if (message.stopReason === "aborted") {
				this.chatContainer.addChild(new Text(style.dim("Aborted."), 1, 0));
				this.chatContainer.addChild(new Spacer(1));
			} else {
				this.appendErrorLine(message.errorMessage ?? "Unknown error.");
			}
			return;
		}
		if (!this.streamingMarkdown) this.beginAssistantMessage();
		this.streamingMarkdown?.setText(collectText(message));
		this.chatContainer.addChild(new Spacer(1));
		this.streamingMarkdown = undefined;
	}

	private appendToolLine(toolName: string): void {
		this.chatContainer.addChild(new Text(style.dim(`• ${toolName}`), 1, 0));
	}

	private appendErrorLine(message: string): void {
		this.chatContainer.addChild(new Text(style.yellow(`! ${message}`), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
	}

	private setBusy(busy: boolean): void {
		if (this.busy === busy) return;
		this.busy = busy;
		if (busy) {
			this.statusContainer.clear();
			this.statusContainer.addChild(this.loader);
			this.loader.start();
		} else {
			this.loader.stop();
			this.statusContainer.clear();
			this.ui.setFocus(this.editor);
		}
	}

	private handleGlobalInput(data: string): { consume?: boolean } | undefined {
		if (matchesKey(data, "ctrl+c")) {
			void this.handleCtrlC();
			return { consume: true };
		}
		return undefined;
	}

	private async handleCtrlC(): Promise<void> {
		if (this.busy) {
			try {
				await this.harness.abort();
			} catch {
				// Abort races are non-fatal; the agent_end event still settles busy state.
			}
			return;
		}
		const now = Date.now();
		if (now - this.lastSigintTime < CTRL_C_EXIT_WINDOW_MS) {
			this.stop();
			return;
		}
		this.lastSigintTime = now;
		this.editor.setText("");
		this.statusContainer.clear();
		this.statusContainer.addChild(new Text(style.dim("Press Ctrl+C again to exit."), 1, 0));
		this.ui.requestRender();
	}
}
