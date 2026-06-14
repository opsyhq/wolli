/**
 * Interactive TUI chat mode.
 *
 * Mirrors `@opsyhq/coding-agent`'s `InteractiveMode` class shape (`constructor(host,
 * options)`, `run()`, `stop()`) but stays minimal: it bridges the `AgentHarness`
 * event stream onto a small retained-mode component tree (a chat log `Container`, a
 * status `Container` holding a `Loader`, and an `Editor`). Streaming assistant text
 * is routed through an `AssistantMessageComponent` (vendored from
 * `@opsyhq/coding-agent`), whose `updateContent(message)` is called in place on each
 * delta so the prefix cache and the renderer both stay warm — and so thinking blocks
 * render in order rather than being dropped.
 *
 * Subscribe handlers must stay fast and non-throwing — a throw inside one surfaces as
 * an `AgentHarnessError("hook")` and would abort the turn.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type AgentHarness, AgentHarnessError, type AgentHarnessEvent, type AgentMessage } from "@opsyhq/agent";
import {
	Container,
	Editor,
	getKeybindings,
	Loader,
	type MarkdownTheme,
	matchesKey,
	ProcessTerminal,
	Spacer,
	setKeybindings,
	Text,
	TUI,
} from "@opsyhq/tui";
import { commissionAgent, isCommissioned } from "../../core/agent-config.ts";
import { executeBashWithOperations } from "../../core/bash-executor.ts";
import { KeybindingsManager } from "../../core/keybindings.ts";
import type { SessionHost } from "../../core/session-host.ts";
import { createLocalBashOperations } from "../../core/tools/bash.ts";
import type { TruncationResult } from "../../core/tools/truncate.ts";
import { isFailureMessage } from "../message.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { rawKeyHint } from "./components/keybinding-hints.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { getEditorTheme, getMarkdownTheme, initTheme, theme } from "./theme/theme.ts";

/** Window (ms) within which a second Ctrl+C quits instead of clearing the editor. */
const CTRL_C_EXIT_WINDOW_MS = 500;

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return (message as { role?: string }).role === "assistant";
}

/** Interface for components that can be expanded/collapsed */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
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
	private streamingComponent?: AssistantMessageComponent;
	private lastSigintTime = 0;
	private stopped = false;
	// Live tool components keyed by toolCallId, mirroring pi's InteractiveMode. A
	// component is created when its tool call first appears (streaming args or
	// execution start), updated as output streams, and dropped from the map once
	// the tool ends (it stays in the chat log for display).
	private readonly pendingTools = new Map<string, ToolExecutionComponent>();
	private toolOutputExpanded = false;
	// User-typed shell (`!cmd` / `!!cmd`), mirroring pi's InteractiveMode. `isBashMode`
	// tracks the editor `!`-prefix for border coloring; `bashComponent` is the live
	// panel; `bashAbortController` lets Ctrl+C cancel the running command.
	private isBashMode = false;
	private bashComponent?: BashExecutionComponent;
	private bashAbortController?: AbortController;

	constructor(host: SessionHost) {
		this.sessionHost = host;
		// The theme proxy and keybinding hints used by the vendored tool renderers
		// throw unless initialized first; do it before any styling runs.
		initTheme();
		setKeybindings(KeybindingsManager.create());
		this.ui = new TUI(new ProcessTerminal());
		this.chatContainer = new Container();
		this.statusContainer = new Container();
		this.editorContainer = new Container();
		this.markdownTheme = getMarkdownTheme();
		this.editor = new Editor(this.ui, getEditorTheme(), { paddingX: 1 });
		this.loader = new Loader(
			this.ui,
			(text) => theme.fg("accent", text),
			(text) => theme.fg("muted", text),
			// Mirrors `@opsyhq/coding-agent`'s `defaultWorkingMessage` ("Working...").
			"Working...",
		);
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
		// Mirrors pi's `defaultEditor.onChange`: recolor the editor border the moment
		// the `!` bash-mode prefix is typed or removed.
		this.editor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			this.isBashMode = text.trimStart().startsWith("!");
			if (wasBashMode !== this.isBashMode) {
				this.updateEditorBorderColor();
			}
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
		const lines = [theme.bold(config.name)];
		const trimmedPurpose = config.purpose.trim();
		if (trimmedPurpose) {
			lines.push(theme.fg("dim", trimmedPurpose));
		}
		if (!isCommissioned(config)) {
			lines.push(
				theme.fg("dim", "Forming — it will ask to be commissioned; type /commission to finalize manually."),
			);
		}
		// pi's `rawKeyHint("!", "to run bash")` / `rawKeyHint("!!", "to run bash (no
		// context)")` (interactive-mode.ts:657-658), joined with pi's compact " · "
		// separator. Deviation: pi carries these in its `ExpandableText` startup header;
		// steward's header is a reduced plain-text form, so the hints live here instead.
		lines.push(
			[rawKeyHint("!", "to run bash"), rawKeyHint("!!", "to run bash (no context)")].join(theme.fg("muted", " · ")),
		);
		lines.push(theme.fg("dim", "Ctrl+C to exit."));
		this.chatContainer.addChild(new Text(lines.join("\n"), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
	}

	private async handleSubmit(text: string): Promise<void> {
		const trimmed = text.trim();
		if (trimmed.length === 0 || this.busy) return;

		// Slash commands are intercepted before reaching the model.
		if (trimmed === "/commission" || trimmed === "/finalize") {
			this.editor.setText("");
			await this.handleCommissionCommand();
			return;
		}

		// Handle bash command (! for normal, !! for excluded from context)
		if (text.startsWith("!")) {
			const isExcluded = text.startsWith("!!");
			const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
			if (command) {
				// Deviation from `@opsyhq/coding-agent`: pi guards with `session.isBashRunning`
				// (and defers to a `pendingMessagesContainer` while streaming) and warns via
				// `showWarning`. Steward has neither, so it guards on the live AbortController
				// and warns via `appendErrorLine`; the hint names Ctrl+C (steward's interrupt).
				if (this.bashAbortController) {
					this.appendErrorLine("A bash command is already running. Press Ctrl+C to cancel it first.");
					this.editor.setText(text);
					this.ui.requestRender();
					return;
				}
				// Deviation: pi's editor auto-clears on submit; steward's does not, so clear it.
				this.editor.setText("");
				this.editor.addToHistory?.(text);
				await this.handleBashCommand(command, isExcluded);
				this.isBashMode = false;
				this.updateEditorBorderColor();
				return;
			}
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
	private async handleCommissionCommand(): Promise<void> {
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
		this.streamingComponent = undefined;
		this.pendingTools.clear();
		this.bashAbortController?.abort();
		this.bashAbortController = undefined;
		this.bashComponent = undefined;
		this.setBusy(false);
		this.chatContainer.addChild(new Text(theme.fg("dim", "✓ Commissioned — fresh session started."), 1, 0));
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Run a user-typed shell command (`!cmd` / `!!cmd`). Mirrors pi's
	 * `handleBashCommand` (interactive-mode.ts ~5613).
	 *
	 * Deviation from `@opsyhq/coding-agent`: pi routes through `session.executeBash`,
	 * which adds extension `user_bash` interception, `recordBashResult` (the command +
	 * output enters the LLM context as a `bashExecution` message), and a streaming
	 * `pendingMessagesContainer`. Steward has none of those abstractions, so it calls
	 * `executeBashWithOperations` with pi's default local shell ops directly (pi's
	 * `executeBash` does the same internally), owns the AbortController itself (pi's
	 * session owns it), and surfaces failures via `appendErrorLine` (pi uses
	 * `showError`). The result is NOT recorded into the agent's context — so `!` vs `!!`
	 * differ only by the panel's border color, which is the visible rendering pi produces.
	 */
	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
		this.chatContainer.addChild(this.bashComponent);
		this.ui.requestRender();

		this.bashAbortController = new AbortController();
		try {
			const result = await executeBashWithOperations(
				command,
				this.sessionHost.getCwd(),
				createLocalBashOperations(),
				{
					onChunk: (chunk) => {
						if (this.bashComponent) {
							this.bashComponent.appendOutput(chunk);
							this.ui.requestRender();
						}
					},
					signal: this.bashAbortController.signal,
				},
			);
			if (this.bashComponent) {
				this.bashComponent.setComplete(
					result.exitCode,
					result.cancelled,
					result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
					result.fullOutputPath,
				);
			}
		} catch (error) {
			if (this.bashComponent) {
				this.bashComponent.setComplete(undefined, false);
			}
			this.appendErrorLine(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.bashAbortController = undefined;
		this.bashComponent = undefined;
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
			case "tool_execution_start": {
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					component = new ToolExecutionComponent(
						event.toolName,
						event.toolCallId,
						event.args,
						// Deviation from `@opsyhq/coding-agent`: pi reads showImages /
						// imageWidthCells from its `settingsManager`. Steward has no
						// settings manager, so pass `{}` and take the component defaults.
						{},
						this.getRegisteredToolDefinition(event.toolName),
						this.ui,
						this.sessionHost.getCwd(),
					);
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
					this.pendingTools.set(event.toolCallId, component);
				}
				component.markExecutionStarted();
				break;
			}
			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
				}
				break;
			}
			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					this.pendingTools.delete(event.toolCallId);
				}
				break;
			}
			case "agent_end":
				this.setBusy(false);
				this.pendingTools.clear();
				break;
			default:
				return;
		}
		this.ui.requestRender();
	}

	/**
	 * Get a registered tool definition by name (for custom rendering). Mirrors
	 * `@opsyhq/coding-agent`'s `getRegisteredToolDefinition`, which returns the
	 * session's per-extension tool definition.
	 *
	 * Deviation from `@opsyhq/coding-agent`: steward has no extension tool
	 * registry — every tool is built-in, and `ToolExecutionComponent`
	 * reconstructs the built-in renderer from `cwd` itself. So there is never an
	 * override to return; this is always `undefined`.
	 */
	private getRegisteredToolDefinition(_toolName: string): undefined {
		return undefined;
	}

	private appendUserMessage(text: string): void {
		// Mirrors `@opsyhq/coding-agent`'s `UserMessageComponent` (vendored): the
		// prompt renders as a `userMessageBg` bubble with a Markdown body in
		// `userMessageText`, replacing steward's earlier plain `› text` line.
		// Deviation: pi adds a *leading* Spacer(1) before the bubble (only when the
		// chat is non-empty) and no trailing one; steward keeps its trailing Spacer(1)
		// convention so the assistant/error/aborted paths' spacing stays consistent.
		this.chatContainer.addChild(new UserMessageComponent(text, this.markdownTheme));
		this.chatContainer.addChild(new Spacer(1));
		this.streamingComponent = undefined;
	}

	private beginAssistantMessage(): void {
		this.streamingComponent = new AssistantMessageComponent(undefined, false, this.markdownTheme);
		this.chatContainer.addChild(this.streamingComponent);
	}

	private updateAssistantMessage(message: AssistantMessage): void {
		if (!this.streamingComponent) this.beginAssistantMessage();
		this.streamingComponent?.updateContent(message);

		for (const content of message.content) {
			if (content.type === "toolCall") {
				if (!this.pendingTools.has(content.id)) {
					const component = new ToolExecutionComponent(
						content.name,
						content.id,
						content.arguments,
						// Deviation from `@opsyhq/coding-agent`: no settings manager (see
						// `tool_execution_start`); pass `{}` for the component defaults.
						{},
						this.getRegisteredToolDefinition(content.name),
						this.ui,
						this.sessionHost.getCwd(),
					);
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
					this.pendingTools.set(content.id, component);
				} else {
					const component = this.pendingTools.get(content.id);
					if (component) {
						component.updateArgs(content.arguments);
					}
				}
			}
		}
	}

	private finalizeAssistantMessage(message: AssistantMessage): void {
		if (isFailureMessage(message)) {
			// Drop any partial bubble and show the error/abort detail instead.
			// Deviation from `@opsyhq/coding-agent`: pi lets `AssistantMessageComponent`
			// render its own aborted/error stop reasons. Steward keeps its dedicated
			// failure path here (and never opens a component for failure messages — see
			// the `message_start` guard), so the component's abort/error branches stay
			// unused and there is no double-rendering.
			if (this.streamingComponent) {
				this.chatContainer.removeChild(this.streamingComponent);
				this.streamingComponent = undefined;
			}
			// Mirror pi's message_end: settle any still-pending tool components with
			// the error so they stop showing as in-flight, then drop them.
			const errorMessage =
				message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error");
			for (const [, component] of this.pendingTools.entries()) {
				component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
			}
			this.pendingTools.clear();
			if (message.stopReason === "aborted") {
				this.chatContainer.addChild(new Text(theme.fg("dim", "Aborted."), 1, 0));
				this.chatContainer.addChild(new Spacer(1));
			} else {
				this.appendErrorLine(message.errorMessage ?? "Unknown error.");
			}
			return;
		}
		if (!this.streamingComponent) this.beginAssistantMessage();
		this.streamingComponent?.updateContent(message);
		// Args are now complete - trigger diff computation for edit tools (pi parity).
		for (const [, component] of this.pendingTools.entries()) {
			component.setArgsComplete();
		}
		this.chatContainer.addChild(new Spacer(1));
		this.streamingComponent = undefined;
	}

	private appendErrorLine(message: string): void {
		this.chatContainer.addChild(new Text(theme.fg("warning", `! ${message}`), 1, 0));
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

	/**
	 * Recolor the editor border for bash mode. Mirrors pi's `updateEditorBorderColor`
	 * (interactive-mode.ts:3549).
	 *
	 * Deviation from `@opsyhq/coding-agent`: pi's non-bash branch uses
	 * `theme.getThinkingBorderColor(this.session.thinkingLevel)`. Steward freezes the
	 * thinking level in the SessionHost and tracks no per-keystroke thinking state, so it
	 * restores the editor's constructed default border (`getEditorTheme().borderColor`).
	 */
	private updateEditorBorderColor(): void {
		this.editor.borderColor = this.isBashMode ? theme.getBashModeBorderColor() : getEditorTheme().borderColor;
		this.ui.requestRender();
	}

	private toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	private setToolsExpanded(expanded: boolean): void {
		this.toolOutputExpanded = expanded;
		// Deviation from `@opsyhq/coding-agent`: pi also expands its active header
		// (customHeader ?? builtInHeader); steward has no header component.
		for (const child of this.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
		this.ui.requestRender();
	}

	private handleGlobalInput(data: string): { consume?: boolean } | undefined {
		if (matchesKey(data, "ctrl+c")) {
			void this.handleCtrlC();
			return { consume: true };
		}
		// Deviation from `@opsyhq/coding-agent`: pi binds this via
		// `defaultEditor.onAction("app.tools.expand", ...)`. Steward's `Editor` has
		// no `onAction`, so resolve the configured key here against the global
		// keybindings (seeded with `app.tools.expand` by `KeybindingsManager`).
		if (getKeybindings().matches(data, "app.tools.expand")) {
			this.toggleToolOutputExpansion();
			return { consume: true };
		}
		return undefined;
	}

	private async handleCtrlC(): Promise<void> {
		// A running user-bash command takes Ctrl+C first. Mirrors pi's `abortBash()`
		// (`this._bashAbortController?.abort()`), which Esc/Ctrl+C trigger while a `!`
		// command is in flight.
		if (this.bashAbortController) {
			this.bashAbortController.abort();
			return;
		}
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
		this.statusContainer.addChild(new Text(theme.fg("dim", "Press Ctrl+C again to exit."), 1, 0));
		this.ui.requestRender();
	}
}
