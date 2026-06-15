/**
 * Interactive TUI chat mode.
 *
 * Bridges the `AgentHarness` event stream onto a small retained-mode component tree (a
 * chat log `Container`, a status `Container` holding a `Loader`, and an `Editor`).
 * Streaming assistant text is routed through an `AssistantMessageComponent`, whose
 * `updateContent(message)` is called in place on each delta so the prefix cache and the
 * renderer both stay warm — and so thinking blocks render in order rather than being
 * dropped.
 *
 * Subscribe handlers must stay fast and non-throwing — a throw inside one surfaces as
 * an `AgentHarnessError("hook")` and would abort the turn.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type AgentHarness, AgentHarnessError, type AgentHarnessEvent, type AgentMessage } from "@opsyhq/agent";
import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	Container,
	Editor,
	getKeybindings,
	Loader,
	type MarkdownTheme,
	matchesKey,
	ProcessTerminal,
	type SlashCommand,
	Spacer,
	setKeybindings,
	Text,
	TUI,
} from "@opsyhq/tui";
import { deployAgent, isDeployed } from "../../core/agent-config.ts";
import { executeBashWithOperations } from "../../core/bash-executor.ts";
import type { AutocompleteProviderFactory } from "../../core/extensions/index.ts";
import { KeybindingsManager } from "../../core/keybindings.ts";
import type { SessionHost } from "../../core/session-host.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import { createLocalBashOperations } from "../../core/tools/bash.ts";
import type { TruncationResult } from "../../core/tools/truncate.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import { isFailureMessage } from "../message.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { rawKeyHint } from "./components/keybinding-hints.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { getEditorTheme, getMarkdownTheme, initTheme, theme } from "./theme/theme.ts";

/** Window (ms) within which a second Ctrl+C quits instead of clearing the editor. */
const CTRL_C_EXIT_WINDOW_MS = 500;

/**
 * Sent to the agent when the human types `/deploy` — it nudges the agent to call the
 * deploy tool with its distilled purpose + final SOUL.md. The tool runs, then the
 * human confirms via the Yes/No dialog before the latch flips; `/deploy` is just the
 * nudge, not the consent (so there is one path: tool → confirm → deploy).
 */
const DEPLOY_INSTRUCTION =
	"Your human asked you to deploy. If you're ready, call the deploy tool now with your distilled purpose and final SOUL.md.";

/**
 * Constructor opts decided by the CLI/main layer and read in the startup method.
 * Whereas pi's `initialMessage` seeds a *user* prompt and runs a turn, a newly born
 * agent opens the chat itself, so `initialAssistantMessage` is seeded as an *assistant*
 * turn with no model round-trip. The text is decided at the top (`main.ts`), not here.
 */
export interface InteractiveModeOptions {
	/**
	 * Seed an assistant message into the session on startup and render it, with no
	 * model turn. `main.ts` sets it to the birth opener for a freshly created agent.
	 */
	initialAssistantMessage?: string;
}

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
	private readonly options: InteractiveModeOptions;
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
	// Live tool components keyed by toolCallId. A component is created when its tool
	// call first appears (streaming args or execution start), updated as output
	// streams, and dropped from the map once the tool ends (it stays in the chat log
	// for display).
	private readonly pendingTools = new Map<string, ToolExecutionComponent>();
	private toolOutputExpanded = false;
	// User-typed shell (`!cmd` / `!!cmd`). `isBashMode` tracks the editor `!`-prefix
	// for border coloring; `bashComponent` is the live panel; `bashAbortController`
	// lets Ctrl+C cancel the running command.
	private isBashMode = false;
	private bashComponent?: BashExecutionComponent;
	private bashAbortController?: AbortController;
	// Deploy flow state. The deploy tool (forming-only) writes the agent's purpose +
	// SOUL.md but does NOT flip the latch — the human confirms here, symmetric with
	// SOUL being written-but-unconfirmed. `extensionSelector` is the Yes/No dialog
	// (see showExtensionConfirm). `deployToolCallId`/`deployToolErrored` track the
	// in-flight deploy tool call so agent_end knows it ran and whether it succeeded.
	private extensionSelector?: ExtensionSelectorComponent;
	private deployToolCallId?: string;
	private deployToolErrored = false;
	// Editor autocomplete (the slash-command menu). The engine —
	// `CombinedAutocompleteProvider` plus the SelectList dropdown — lives in
	// `@opsyhq/tui`; this layer only builds the provider from the live command set and
	// pushes it into the editor. `autocompleteProviderWrappers` is the extension-stacking
	// hook: always empty in steward, which has no interactive `ExtensionUIContext` bridge
	// yet (extensions get the runner's noOpUIContext, so `ctx.addAutocompleteProvider` can
	// never fire). `fdPath` is resolved lazily (initAutocompleteFd) and only powers
	// `@`-fuzzy file search; slash-command and directory (readdir) completion work without
	// it. (Divergence: pi also retains the composed provider in a field to re-push onto
	// editors it swaps in at runtime; steward has one fixed editor and never swaps, so
	// there is no reader and nothing to retain.)
	private readonly autocompleteProviderWrappers: AutocompleteProviderFactory[] = [];
	private fdPath: string | null = null;

	constructor(host: SessionHost, options: InteractiveModeOptions = {}) {
		this.sessionHost = host;
		this.options = options;
		// The theme proxy and keybinding hints used by the tool renderers throw
		// unless initialized first; do it before any styling runs.
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
			"Working...",
		);
		// The Loader starts its animation timer on construction; halt it until busy.
		this.loader.stop();
	}

	/** The live harness, sourced from the session host (swapped on deploy). */
	private get harness(): AgentHarness {
		return this.sessionHost.harness;
	}

	run(): Promise<void> {
		this.editor.onSubmit = (text) => {
			void this.handleSubmit(text);
		};
		// Recolor the editor border the moment the `!` bash-mode prefix is typed or
		// removed.
		this.editor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			this.isBashMode = text.trimStart().startsWith("!");
			if (wasBashMode !== this.isBashMode) {
				this.updateEditorBorderColor();
			}
		};
		// Wire the slash-command autocomplete menu; the `fd` binary (for `@`-fuzzy file
		// search) is resolved in the background and the provider rebuilt when it lands.
		this.setupAutocompleteProvider();
		void this.initAutocompleteFd();
		this.subscribeToHost();
		this.removeInputListener = this.ui.addInputListener((data) => this.handleGlobalInput(data));

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.statusContainer);
		this.ui.addChild(this.editorContainer);
		this.editorContainer.addChild(this.editor);

		this.appendHeader();

		this.ui.setFocus(this.editor);
		this.ui.start();

		// Seed an assistant opener instead of running a user turn: a newly born agent
		// opens the chat itself. Fire-and-forget — run() returns the exit promise.
		if (this.options.initialAssistantMessage) {
			void this.seedInitialAssistantMessage(this.options.initialAssistantMessage);
		}

		return new Promise<void>((resolve) => {
			this.resolveExit = resolve;
		});
	}

	/**
	 * Build the base autocomplete provider from the live command set. Substrate
	 * divergences:
	 *   - pi reads three separate session accessors (promptTemplates, extension commands,
	 *     skills); steward's harness session is private, but `SessionHost.getCommands()`
	 *     already merges exactly those three into `SlashCommandInfo[]`, so pi's three
	 *     branches collapse into one loop here.
	 *   - pi attaches a dynamic `getArgumentCompletions` to the `model` builtin; steward has
	 *     no `/model` interactive command, so there is nothing to attach it to.
	 */
	private createBaseAutocompleteProvider(): AutocompleteProvider {
		const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
			name: command.name,
			description: command.description,
		}));

		const builtinCommandNames = new Set(slashCommands.map((command) => command.name));
		const dynamicCommands: SlashCommand[] = this.sessionHost
			.getCommands()
			.filter((command) => !builtinCommandNames.has(command.name))
			.map((command) => ({
				name: command.name,
				description: this.prefixAutocompleteDescription(command.description, command.sourceInfo),
			}));

		return new CombinedAutocompleteProvider(
			[...slashCommands, ...dynamicCommands],
			this.sessionHost.getCwd(),
			this.fdPath,
		);
	}

	/**
	 * Compose the base provider with any extension wrapper factories and push it into the
	 * editor. Collapsed to steward's single editor (pi sets the provider on both
	 * `defaultEditor` and a swappable `editor`). The wrapper loop never runs, since
	 * `autocompleteProviderWrappers` is always empty in steward (no interactive
	 * `ExtensionUIContext` bridge — see the field comment).
	 */
	private setupAutocompleteProvider(): void {
		let provider = this.createBaseAutocompleteProvider();
		const triggerCharacters: string[] = [];
		for (const wrapProvider of this.autocompleteProviderWrappers) {
			provider = wrapProvider(provider);
			triggerCharacters.push(...(provider.triggerCharacters ?? []));
		}
		if (triggerCharacters.length > 0) {
			provider.triggerCharacters = [...new Set(triggerCharacters)];
		}

		this.editor.setAutocompleteProvider(provider);
	}

	/**
	 * Resolve the `fd` binary in the background, then rebuild the provider so `@`-fuzzy file
	 * search lights up. Substrate divergence: pi resolves `fd` in an async startup method
	 * before its first `setupAutocompleteProvider`; steward builds the editor and calls setup
	 * synchronously in `run()` (slash-command and directory completion need no fd), then
	 * rebuilds the provider here once fd lands.
	 */
	private async initAutocompleteFd(): Promise<void> {
		try {
			this.fdPath = await ensureTool("fd", true);
		} catch {
			// fd is optional; slash-command and readdir-based path completion already work.
			return;
		}
		this.setupAutocompleteProvider();
	}

	/**
	 * Build the `[source]` tag prefixed onto extension/prompt/skill command descriptions in
	 * the autocomplete menu. Omits pi's git-URL branch: pi formats git sources via
	 * `parseGitUrl` (utils/git.ts), which steward does not vendor — so git sources fall
	 * through to the bare scope prefix, exactly pi's own behavior when `parseGitUrl` returns
	 * null.
	 */
	private getAutocompleteSourceTag(sourceInfo?: SourceInfo): string | undefined {
		if (!sourceInfo) {
			return undefined;
		}

		const scopePrefix = sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";
		const source = sourceInfo.source.trim();

		if (source === "auto" || source === "local" || source === "cli") {
			return scopePrefix;
		}

		if (source.startsWith("npm:")) {
			return `${scopePrefix}:${source}`;
		}

		return scopePrefix;
	}

	private prefixAutocompleteDescription(description: string | undefined, sourceInfo?: SourceInfo): string | undefined {
		const sourceTag = this.getAutocompleteSourceTag(sourceInfo);
		if (!sourceTag) {
			return description;
		}
		return description ? `[${sourceTag}] ${description}` : `[${sourceTag}]`;
	}

	/**
	 * Persist + render the agent's opening assistant message (the birth opener). The
	 * message is appended to the session via the host so it survives resume, then
	 * rendered through the same `AssistantMessageComponent` the stream uses. Only the
	 * birth path passes `initialAssistantMessage`, so resumes never re-seed it.
	 */
	private async seedInitialAssistantMessage(text: string): Promise<void> {
		try {
			const message = await this.sessionHost.seedAssistantMessage(text);
			const component = new AssistantMessageComponent(undefined, false, this.markdownTheme);
			component.updateContent(message);
			this.chatContainer.addChild(component);
			this.chatContainer.addChild(new Spacer(1));
		} catch (error) {
			this.appendErrorLine(error instanceof Error ? error.message : String(error));
		}
		this.ui.requestRender();
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
		if (!isDeployed(config)) {
			lines.push(theme.fg("dim", "Forming — it'll ask to deploy when ready, or type /deploy."));
		}
		// Bash key hints, joined with a compact " · " separator. Deviation: pi carries
		// these in its `ExpandableText` startup header; steward's header is a reduced
		// plain-text form, so the hints live here instead.
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

		// Built-in slash commands are intercepted before reaching the model via a
		// hardcoded dispatch in onSubmit. `/deploy` is the human's go-ahead to deploy
		// (no args — the agent authors its own purpose).
		if (trimmed === "/deploy") {
			this.editor.setText("");
			await this.handleDeployCommand();
			return;
		}
		// `/new` — start a fresh session and clear the chat.
		if (trimmed === "/new") {
			this.editor.setText("");
			await this.handleNewCommand();
			return;
		}
		// `/compact [instructions]` — compact the session history.
		if (trimmed === "/compact" || trimmed.startsWith("/compact ")) {
			const customInstructions = trimmed.startsWith("/compact ") ? trimmed.slice(9).trim() || undefined : undefined;
			this.editor.setText("");
			await this.handleCompactCommand(customInstructions);
			return;
		}
		// `/quit` — exit. `stop()` is the native equivalent of pi's `shutdown()`
		// (resolveExit + main.cleanup own the rest). See its divergences.
		if (trimmed === "/quit") {
			this.editor.setText("");
			this.stop();
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
	 * `/deploy` — the human's nudge to deploy. It cannot deploy on its own: it prompts
	 * the agent to author its purpose + final SOUL.md via the deploy tool, and the
	 * post-tool Yes/No confirm (finalizeDeploy) is what actually flips the latch. One
	 * path only — `/deploy` always nudges, the tool runs, the human confirms, deploy.
	 */
	private async handleDeployCommand(): Promise<void> {
		if (isDeployed(this.sessionHost.config)) {
			this.appendErrorLine("Already deployed.");
			this.ui.requestRender();
			return;
		}
		// Nudge the agent to author its purpose + SOUL.md via the deploy tool. When the
		// tool finishes (agent_end), finalizeDeploy asks the human to confirm.
		this.appendUserMessage("/deploy");
		this.statusContainer.clear();
		this.ui.requestRender();
		try {
			await this.harness.prompt(DEPLOY_INSTRUCTION);
		} catch (error) {
			if (error instanceof AgentHarnessError && error.code === "busy") return;
			this.appendErrorLine(error instanceof Error ? error.message : String(error));
			this.ui.requestRender();
		}
	}

	/**
	 * Called at agent_end when the deploy tool ran successfully. Always confirm with a
	 * Yes/No dialog before deploying — symmetric with how `@opsyhq/coding-agent` confirms
	 * any extension action: the tool finishes, the UI asks, the human decides.
	 */
	private async finalizeDeploy(): Promise<void> {
		this.deployToolCallId = undefined;
		const confirmed = await this.showExtensionConfirm(
			`Deploy "${this.sessionHost.config.name}"?`,
			"Its purpose and SOUL.md are written. Deploying starts a fresh session.",
		);
		if (!confirmed) {
			this.chatContainer.addChild(
				new Text(theme.fg("dim", "Deploy cancelled — keep forming, or /deploy when ready."), 1, 0),
			);
			this.ui.requestRender();
			return;
		}
		await this.doDeploy();
	}

	/**
	 * Swap the live harness for a fresh session in place (the shared core of `/new` and
	 * deploy). steward's `sessionHost.newSession()` only swaps the harness, so the dance
	 * around it lives here: unsubscribe from the old harness, have the host build a new one
	 * (whose frozen prompt reflects the current config), re-subscribe, and reset the
	 * transient per-session UI state. The TUI is never torn down.
	 *
	 * Transcript-neutral — callers decide whether to clear the chat log (deploy keeps it,
	 * `/new` clears it). Returns `false` (after surfacing the error and keeping the old
	 * harness live) if the swap failed.
	 */
	private async swapToNewSession(): Promise<boolean> {
		this.unsubscribe?.();
		try {
			// On success the host swaps in the new harness; on failure it keeps the old.
			await this.sessionHost.newSession();
		} catch (error) {
			this.subscribeToHost();
			this.appendErrorLine(error instanceof Error ? error.message : String(error));
			this.ui.requestRender();
			return false;
		}
		this.subscribeToHost();

		// Reset transient per-session UI state.
		this.streamingComponent = undefined;
		this.pendingTools.clear();
		this.bashAbortController?.abort();
		this.bashAbortController = undefined;
		this.bashComponent = undefined;
		this.deployToolCallId = undefined;
		this.deployToolErrored = false;
		this.setBusy(false);
		return true;
	}

	/**
	 * Flip the human-held latch, then swap to a fresh session in place (see
	 * swapToNewSession). The new harness's frozen prompt no longer carries the birth
	 * instruction. The deploy transcript is kept on screen — only `/new` clears the chat.
	 */
	private async doDeploy(): Promise<void> {
		const name = this.sessionHost.config.name;
		deployAgent(name);
		if (!(await this.swapToNewSession())) return;
		this.chatContainer.addChild(new Text(theme.fg("dim", "✓ Deployed — fresh session started."), 1, 0));
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * `/new` — start a fresh session. Substrate-forced divergences from pi:
	 *  - pi's `runtimeHost.newSession()` owns the harness + subscription swap; steward's
	 *    only swaps the harness, so this reuses `swapToNewSession()` (the same dance
	 *    deploy uses) rather than pi's one-liner.
	 *  - pi's `result.cancelled` (newSession can prompt-to-save) has no steward analog —
	 *    steward's `newSession()` never cancels.
	 *  - pi's `renderCurrentSessionState()` rebuilds the view from the now-empty session;
	 *    steward has no such method, so it clears the chat log and re-renders the header.
	 *  - pi's `handleFatalRuntimeError` is `swapToNewSession`'s `appendErrorLine` path.
	 */
	private async handleNewCommand(): Promise<void> {
		if (!(await this.swapToNewSession())) return;
		this.chatContainer.clear();
		this.appendHeader();
		this.chatContainer.addChild(new Text(theme.fg("dim", "✓ New session started."), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * `/compact [instructions]` — compact the session history. Substrate-forced
	 * divergences from pi:
	 *  - pi reads `sessionManager.getEntries()` directly; steward's harness keeps its
	 *    session private, so the host exposes the live entries (`sessionHost.getEntries()`).
	 *  - pi's `showWarning` has no steward analog — its warning surface is `appendErrorLine`.
	 *  - pi calls `this.session.compact()` and swallows the error (compaction failures
	 *    surface as session events); steward calls `harness.compact()` directly and that
	 *    THROWS, so failures are surfaced here instead.
	 */
	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		const messageCount = this.sessionHost.getEntries().filter((e) => e.type === "message").length;
		if (messageCount < 2) {
			this.appendErrorLine("Nothing to compact (no messages yet).");
			this.ui.requestRender();
			return;
		}
		this.statusContainer.clear();
		try {
			await this.harness.compact(customInstructions);
		} catch (error) {
			if (error instanceof AgentHarnessError && error.code === "busy") return;
			this.appendErrorLine(error instanceof Error ? error.message : String(error));
		}
		this.ui.requestRender();
	}

	/**
	 * Show the Yes/No selector dialog: swap the editor for the selector in
	 * `editorContainer`, focus it (the TUI then routes input to it), and resolve when
	 * the user picks or cancels. No signal/timeout — steward drives this only for the
	 * deploy confirm, which neither aborts nor times out.
	 */
	private showExtensionSelector(title: string, options: string[]): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					this.hideExtensionSelector();
					resolve(option);
				},
				() => {
					this.hideExtensionSelector();
					resolve(undefined);
				},
				{ tui: this.ui, onToggleToolsExpanded: () => this.toggleToolOutputExpansion() },
			);
			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionSelector);
			this.ui.setFocus(this.extensionSelector);
			this.ui.requestRender();
		});
	}

	/** Hide the selector and restore the editor. */
	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionSelector = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/** Yes/No confirm built on the selector. */
	private async showExtensionConfirm(title: string, message: string): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"]);
		return result === "Yes";
	}

	/**
	 * Run a user-typed shell command (`!cmd` / `!!cmd`).
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
				// Track the deploy tool so agent_end knows it ran (the tool writes the
				// agent's purpose + SOUL.md; the human-held latch is flipped here, not there).
				if (event.toolName === "deploy") {
					this.deployToolCallId = event.toolCallId;
					this.deployToolErrored = false;
				}
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
				if (event.toolCallId === this.deployToolCallId) {
					this.deployToolErrored = event.isError;
				}
				break;
			}
			case "agent_end":
				this.setBusy(false);
				this.pendingTools.clear();
				// If the deploy tool ran and succeeded this turn, confirm + deploy now
				// that the turn has settled. Detached: finalizeDeploy awaits a UI dialog.
				if (this.deployToolCallId && !this.deployToolErrored) {
					void this.finalizeDeploy();
				}
				break;
			default:
				return;
		}
		this.ui.requestRender();
	}

	/**
	 * Get a registered tool definition by name (for custom rendering). In pi this returns
	 * the session's per-extension tool definition.
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
		// The prompt renders as a `userMessageBg` bubble with a Markdown body in
		// `userMessageText`. It keeps steward's trailing Spacer(1) convention so the
		// assistant/error/aborted paths' spacing stays consistent.
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
			// Settle any still-pending tool components with the error so they stop
			// showing as in-flight, then drop them.
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
		// Args are now complete - trigger diff computation for edit tools.
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
	 * Recolor the editor border for bash mode.
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
		// A running user-bash command takes Ctrl+C first (aborts the in-flight `!`
		// command).
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
