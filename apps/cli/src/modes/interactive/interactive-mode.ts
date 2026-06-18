/**
 * Interactive TUI chat mode — a daemon client.
 *
 * Drives a `DaemonSession` (the one `fetch`/SSE seam) instead of an in-process `SessionHost`:
 * actions are control-command round-trips and the event stream arrives over SSE, byte-identical to
 * the in-process harness events this consumed before. Those events are bridged onto a small
 * retained-mode component tree (a chat log `Container`, a status `Container` holding a `Loader`, and
 * an `Editor`). Streaming assistant text is routed through an `AssistantMessageComponent`, whose
 * `updateContent(message)` is called in place on each delta so the prefix cache and the renderer
 * both stay warm — and so thinking blocks render in order rather than being dropped.
 *
 * Subscribe handlers must stay fast and non-throwing.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AgentHarnessError, type AgentHarnessEvent, type AgentMessage, type SessionContext } from "@opsyhq/agent";
import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	type Component,
	Container,
	Editor,
	type EditorComponent,
	getKeybindings,
	Loader,
	type MarkdownTheme,
	matchesKey,
	type OverlayHandle,
	type OverlayOptions,
	ProcessTerminal,
	type SlashCommand,
	Spacer,
	setKeybindings,
	Text,
	TruncatedText,
	TUI,
} from "@opsyhq/tui";
import {
	type AutocompleteProviderFactory,
	BUILTIN_SLASH_COMMANDS,
	createBashExecutionMessage,
	createLocalBashOperations,
	type EditorFactory,
	ensureTool,
	executeBashWithOperations,
	type ExtensionCommandContextActions,
	ExtensionInputComponent,
	ExtensionSelectorComponent,
	type ExtensionShortcut,
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionWidgetOptions,
	FooterDataProvider,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getMarkdownTheme,
	getThemeByName,
	initTheme,
	isDeployed,
	KeybindingsManager,
	keyDisplayText,
	type KeyId,
	parseSkillBlock,
	rawKeyHint,
	type ReadonlyFooterDataProvider,
	type ResourceDiagnostic,
	setTheme,
	setThemeInstance,
	type SourceInfo,
	type TerminalInputHandler,
	Theme,
	theme,
	type TruncationResult,
	type WorkingIndicatorOptions,
} from "@opsyhq/steward";
import { DaemonSession, type DaemonUiRequest } from "../../daemon-session.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.ts";
import { CustomMessageComponent } from "./components/custom-message.ts";
import { ExtensionEditorComponent } from "./components/extension-editor.ts";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { UserMessageComponent } from "./components/user-message.ts";

/** Window (ms) within which a second Ctrl+C quits instead of clearing the editor. */
const CTRL_C_EXIT_WINDOW_MS = 500;

/** Default streaming loader message, restored when an extension clears its override. */
const DEFAULT_WORKING_MESSAGE = "Working...";

/** Default label for collapsed thinking blocks, restored when an extension clears its override. */
const DEFAULT_HIDDEN_THINKING_LABEL = "Thinking...";

/** Cap on total widget lines so an extension widget can't push the editor off-screen. */
const MAX_WIDGET_LINES = 10;

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
 * A newly born agent opens the chat itself, so `initialAssistantMessage` is seeded as
 * an *assistant* turn with no model round-trip. The text is decided at the top
 * (`main.ts`), not here.
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
	private readonly session: DaemonSession;
	private readonly options: InteractiveModeOptions;
	private readonly ui: TUI;
	private readonly chatContainer: Container;
	// Dim "Steering:/Follow-up:" lines for messages queued while a turn is streaming,
	// rendered between the chat log and the status line.
	private readonly pendingMessagesContainer: Container;
	private readonly statusContainer: Container;
	private readonly editorContainer: Container;
	private readonly keybindings: KeybindingsManager;
	// The active input editor. Defaults to `defaultEditor` and is swapped when an extension
	// supplies one via `ctx.ui.setEditorComponent` (restored to the default on undefined).
	private editor: EditorComponent;
	private readonly defaultEditor: Editor;
	private readonly loader: Loader;
	private readonly markdownTheme: MarkdownTheme;
	// Extension UI chrome. The header/footer containers hold extension-supplied components
	// (empty otherwise — steward has no built-in header/footer rows); the widget containers
	// frame the editor above and below. `footerDataProvider` backs custom footers and the
	// `setStatus`/git-branch data they read.
	private readonly headerContainer: Container;
	private readonly widgetContainerAbove: Container;
	private readonly widgetContainerBelow: Container;
	private readonly footerContainer: Container;
	private readonly footerDataProvider: FooterDataProvider;
	// Extension dialogs swapped into editorContainer (like the deploy selector), the widgets
	// rendered around the editor, and the custom header/footer currently installed.
	private extensionInput?: ExtensionInputComponent;
	private extensionEditor?: ExtensionEditorComponent;
	private readonly extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	private readonly extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	private customFooter?: Component & { dispose?(): void };
	private customHeader?: Component & { dispose?(): void };
	// Extension keyboard shortcuts, matched in handleGlobalInput; terminal-input listeners,
	// tracked so reload can drop them; the custom editor factory and last composed provider.
	private extensionShortcuts = new Map<KeyId, ExtensionShortcut>();
	private readonly extensionTerminalInputUnsubscribers = new Set<() => void>();
	private editorComponentFactory?: EditorFactory;
	private autocompleteProvider?: AutocompleteProvider;
	// Streaming working-indicator state, configurable by extensions via ctx.ui.
	private workingMessage?: string;
	private workingVisible = true;
	private workingIndicatorOptions?: WorkingIndicatorOptions;
	private hiddenThinkingLabel = DEFAULT_HIDDEN_THINKING_LABEL;
	// The last status line + its leading spacer, reused so repeated `showStatus` calls
	// update in place instead of stacking identical lines.
	private lastStatusText?: Text;
	private lastStatusSpacer?: Spacer;

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
	// pushes it into the editor. `autocompleteProviderWrappers` holds extension-supplied
	// wrappers (via `ctx.ui.addAutocompleteProvider`), stacked over the base provider.
	// `fdPath` is resolved lazily (initAutocompleteFd) and only powers `@`-fuzzy file
	// search; slash-command and directory (readdir) completion work without it.
	private autocompleteProviderWrappers: AutocompleteProviderFactory[] = [];
	private fdPath: string | undefined;

	constructor(session: DaemonSession, options: InteractiveModeOptions = {}) {
		this.session = session;
		this.options = options;
		// The theme proxy and keybinding hints used by the tool renderers throw
		// unless initialized first; do it before any styling runs.
		initTheme();
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		this.ui = new TUI(new ProcessTerminal());
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.editorContainer = new Container();
		this.headerContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.footerContainer = new Container();
		this.footerDataProvider = new FooterDataProvider(this.session.getCwd());
		this.markdownTheme = getMarkdownTheme();
		this.defaultEditor = new Editor(this.ui, getEditorTheme(), { paddingX: 1 });
		this.editor = this.defaultEditor;
		this.loader = new Loader(
			this.ui,
			(text) => theme.fg("accent", text),
			(text) => theme.fg("muted", text),
			"Working...",
		);
		// The Loader starts its animation timer on construction; halt it until busy.
		this.loader.stop();
	}

	async run(): Promise<void> {
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
		// The extension runner lives server-side now, so its UI requests arrive over the wire:
		// route the daemon's extension_ui_request stream to the client dialogs (Slice 4 / Item 5).
		this.session.onUiRequest = (req) => this.dispatchUiRequest(req);
		this.setupExtensionShortcuts();
		this.removeInputListener = this.ui.addInputListener((data) => this.handleGlobalInput(data));

		this.ui.addChild(this.headerContainer);
		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.widgetContainerAbove);
		this.ui.addChild(this.statusContainer);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.widgetContainerBelow);
		this.ui.addChild(this.footerContainer);
		this.editorContainer.addChild(this.editor);

		this.appendHeader();
		this.showResourceSummary();

		this.ui.setFocus(this.editor);
		this.ui.start();

		// Paint the resumed transcript (the persisted opener + any prior turns). On
		// birth the session is empty, so this renders nothing and the seed below paints
		// the opener once.
		await this.renderInitialMessages();

		// Seed an assistant opener instead of running a user turn: a newly born agent
		// opens the chat itself. Fire-and-forget — run() returns the exit promise.
		// Gated on `!hasMessageEntries` so the seed is strictly idempotent: if a `message`
		// entry already exists (resume, or a `new` run against a populated session) the
		// opener was already rendered by `renderInitialMessages` and is not re-seeded.
		const hasMessageEntries = (await this.session.getEntries()).some((e) => e.type === "message");
		if (this.options.initialAssistantMessage && !hasMessageEntries) {
			void this.seedInitialAssistantMessage(this.options.initialAssistantMessage);
		}

		await new Promise<void>((resolve) => {
			this.resolveExit = resolve;
		});
	}

	/**
	 * Build the base autocomplete provider from the live command set. The daemon merges prompt
	 * templates, extension commands, and skills into one `SlashCommandInfo[]` (cached client-side),
	 * so a single loop here covers all of them.
	 */
	private createBaseAutocompleteProvider(): AutocompleteProvider {
		const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
			name: command.name,
			description: command.description,
		}));

		const builtinCommandNames = new Set(slashCommands.map((command) => command.name));
		const dynamicCommands: SlashCommand[] = this.session
			.getCommands()
			.filter((command) => !builtinCommandNames.has(command.name))
			.map((command) => ({
				name: command.name,
				description: this.prefixAutocompleteDescription(command.description, command.sourceInfo),
			}));

		return new CombinedAutocompleteProvider(
			[...slashCommands, ...dynamicCommands],
			this.session.getCwd(),
			this.fdPath,
		);
	}

	/**
	 * Compose the base provider with any extension wrapper factories and push it into the
	 * active editor. The composed provider is retained so a custom editor swapped in later
	 * (via `setEditorComponent`) can be seeded with it.
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

		this.autocompleteProvider = provider;
		this.editor.setAutocompleteProvider?.(provider);
	}

	/**
	 * Resolve the `fd` binary in the background, then rebuild the provider so `@`-fuzzy file
	 * search lights up. The editor is built and the provider set up synchronously in `run()`
	 * (slash-command and directory completion need no fd); this rebuilds the provider once
	 * fd lands.
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
	 * the autocomplete menu. There is no git-URL formatting, so git sources fall through to
	 * the bare scope prefix.
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
	 * Persist + render the agent's opening assistant message (the birth opener). The daemon
	 * appends it to the session (so it survives resume), then it renders through the same
	 * `AssistantMessageComponent` the stream uses. Only the birth path passes
	 * `initialAssistantMessage`, so resumes never re-seed it.
	 */
	private async seedInitialAssistantMessage(text: string): Promise<void> {
		try {
			const message = await this.session.seedAssistantMessage(text);
			const component = new AssistantMessageComponent(
				undefined,
				false,
				this.markdownTheme,
				this.hiddenThinkingLabel,
			);
			component.updateContent(message);
			this.chatContainer.addChild(component);
			this.chatContainer.addChild(new Spacer(1));
		} catch (error) {
			this.appendErrorLine(error instanceof Error ? error.message : String(error));
		}
		this.ui.requestRender();
	}

	/** (Re)subscribe to the daemon's SSE event stream. */
	private subscribeToHost(): void {
		this.unsubscribe = this.session.subscribe((event) => {
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
		const config = this.session.config;
		const lines = [theme.bold(config.name)];
		const trimmedPurpose = config.purpose.trim();
		if (trimmedPurpose) {
			lines.push(theme.fg("dim", trimmedPurpose));
		}
		if (!isDeployed(config)) {
			lines.push(theme.fg("dim", "Forming — it'll ask to deploy when ready, or type /deploy."));
		}
		// Bash key hints, joined with a compact " · " separator. The header is a reduced
		// plain-text form, so the hints live here.
		lines.push(
			[rawKeyHint("!", "to run bash"), rawKeyHint("!!", "to run bash (no context)")].join(theme.fg("muted", " · ")),
		);
		lines.push(theme.fg("dim", "Ctrl+C to exit."));
		this.chatContainer.addChild(new Text(lines.join("\n"), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
	}

	/** Print the loaded-resource count line plus any load/collision diagnostics. */
	private showResourceSummary(): void {
		const summary = this.session.getResourceSummary();
		const parts: string[] = [];
		if (summary.extensions > 0) parts.push(`${summary.extensions} extension${summary.extensions === 1 ? "" : "s"}`);
		if (summary.skills > 0) parts.push(`${summary.skills} skill${summary.skills === 1 ? "" : "s"}`);
		if (summary.prompts > 0) parts.push(`${summary.prompts} prompt${summary.prompts === 1 ? "" : "s"}`);
		if (summary.commands > 0) parts.push(`${summary.commands} command${summary.commands === 1 ? "" : "s"}`);
		if (parts.length > 0) {
			this.chatContainer.addChild(new Text(theme.fg("dim", `Loaded ${parts.join(", ")}.`), 1, 0));
			this.chatContainer.addChild(new Spacer(1));
		}
		this.appendResourceDiagnostics(summary.diagnostics);
	}

	private appendResourceDiagnostics(diagnostics: ResourceDiagnostic[]): void {
		if (diagnostics.length === 0) return;
		for (const diagnostic of diagnostics) {
			const label = diagnostic.type === "error" ? "error" : diagnostic.type === "collision" ? "conflict" : "warning";
			const where = diagnostic.path ? theme.fg("muted", ` (${diagnostic.path})`) : "";
			this.chatContainer.addChild(
				new Text(`${theme.fg("warning", `! [${label}] ${diagnostic.message}`)}${where}`, 1, 0),
			);
		}
		this.chatContainer.addChild(new Spacer(1));
		this.ui.requestRender();
	}

	private async handleSubmit(text: string): Promise<void> {
		const trimmed = text.trim();
		if (trimmed.length === 0) return;

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
		// `/reload` — rebuild extensions, skills, prompts, and keybindings in place.
		if (trimmed === "/reload") {
			this.editor.setText("");
			await this.handleReloadCommand();
			return;
		}
		// `/quit` — exit. `stop()` triggers graceful shutdown (resolveExit + main.cleanup
		// own the rest).
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
				// Guard on the live AbortController so only one bash command runs at a time,
				// and warn via `appendErrorLine`; the hint names Ctrl+C (the interrupt key).
				if (this.bashAbortController) {
					this.appendErrorLine("A bash command is already running. Press Ctrl+C to cancel it first.");
					this.editor.setText(text);
					this.ui.requestRender();
					return;
				}
				// The editor does not auto-clear on submit, so clear it.
				this.editor.setText("");
				this.editor.addToHistory?.(text);
				await this.handleBashCommand(command, isExcluded);
				this.isBashMode = false;
				this.updateEditorBorderColor();
				return;
			}
		}

		// While a turn is streaming, a typed message steers (queues) it instead of starting a
		// new turn: it shows in the pending area, then promotes to a bubble when drained.
		if (this.busy) {
			this.editor.addToHistory?.(trimmed);
			this.editor.setText("");
			await this.session.prompt(trimmed, { streamingBehavior: "steer" });
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
			return;
		}

		// Idle: start a new turn. The bubble is drawn from the resulting `message_start`
		// event (no optimistic echo), so a message injected outside the editor renders the
		// same way.
		this.editor.setText("");
		this.statusContainer.clear();
		this.ui.requestRender();
		try {
			await this.session.prompt(trimmed);
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
		if (isDeployed(this.session.config)) {
			this.appendErrorLine("Already deployed.");
			this.ui.requestRender();
			return;
		}
		// Nudge the agent to author its purpose + SOUL.md via the deploy tool. When the tool
		// finishes (agent_end), finalizeDeploy asks the human to confirm. The nudge is a
		// command, not a user turn, so no `/deploy` bubble is rendered (its DEPLOY_INSTRUCTION
		// is suppressed in handleEvent's user message_start branch).
		this.statusContainer.clear();
		this.ui.requestRender();
		try {
			await this.session.prompt(DEPLOY_INSTRUCTION);
		} catch (error) {
			if (error instanceof AgentHarnessError && error.code === "busy") return;
			this.appendErrorLine(error instanceof Error ? error.message : String(error));
			this.ui.requestRender();
		}
	}

	/**
	 * Called at agent_end when the deploy tool ran successfully. Always confirm with a
	 * Yes/No dialog before deploying: the tool finishes, the UI asks, the human decides.
	 */
	private async finalizeDeploy(): Promise<void> {
		this.deployToolCallId = undefined;
		const confirmed = await this.showExtensionConfirm(
			`Deploy "${this.session.config.name}"?`,
			"Its purpose and SOUL.md are written. It will start now as a persistent background service (and relaunch on login/boot), in a fresh session.",
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
	 * Swap to a fresh session in place (the shared core of `/new` and deploy). The daemon's
	 * `new_session` verb rebuilds the server-side session; the client drops its event handler for
	 * the round-trip, re-subscribes, and resets the transient per-session UI state. The TUI is
	 * never torn down.
	 *
	 * Transcript-neutral — callers decide whether to clear the chat log (deploy keeps it,
	 * `/new` clears it). Returns `false` (error surfaced) if the swap failed.
	 *
	 * `reason` records the caller's intent: the daemon refuses a `"new"` swap while the agent is
	 * still forming (the birth-session invariant). A thrown swap degrades gracefully here.
	 */
	private async swapToNewSession(reason: "deploy" | "new"): Promise<boolean> {
		return this.swapSession(() => this.session.newSession({ reason }));
	}

	/**
	 * Run a server-side session swap (`new_session` or `deploy`) with the shared client-side
	 * teardown/rebuild: drop the event handler for the round-trip, re-subscribe, and reset the
	 * transient per-session UI state. The TUI is never torn down; the transcript is left to the
	 * caller (deploy keeps it, `/new` clears it). Returns `false` (error surfaced) if the swap threw.
	 */
	private async swapSession(swap: () => Promise<void>): Promise<boolean> {
		this.unsubscribe?.();
		// Tear down the old session's extension chrome before the swap so the fresh session paints
		// onto a clean surface.
		this.resetExtensionUI();
		try {
			await swap();
		} catch (error) {
			this.subscribeToHost();
			this.setupExtensionShortcuts();
			this.appendErrorLine(error instanceof Error ? error.message : String(error));
			this.ui.requestRender();
			return false;
		}
		this.subscribeToHost();
		// Re-snapshot extension shortcuts (inert until the extension-UI round-trip lands, Slice 4).
		this.setupExtensionShortcuts();

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
	 * Commit the deploy. The daemon persists the deploy state (flip the latch + register the OS
	 * service unit); with the `none` backend it also swaps to a fresh session in place. Runs through
	 * the shared `swapSession` teardown/rebuild so the client re-subscribes and repaints onto the
	 * deployed session without tearing down the TUI.
	 */
	private async doDeploy(): Promise<void> {
		if (!(await this.swapSession(() => this.session.deploy()))) return;
		await this.renderCurrentSessionState();
		this.chatContainer.addChild(new Text(theme.fg("dim", "✓ Deployed."), 1, 0));
		this.ui.requestRender();
	}

	/**
	 * `/new` — start a fresh session, reusing `swapToNewSession()` (the same dance deploy uses) and
	 * surfacing any failure via its `appendErrorLine` path.
	 *
	 * Forming guard: while the agent is undeployed it stays in its single birth session, so `/new` is
	 * refused here (the primary guard) and again by the daemon (the backstop — the birth-session
	 * invariant).
	 */
	private async handleNewCommand(): Promise<void> {
		if (!isDeployed(this.session.config)) {
			this.appendErrorLine(
				"This agent is still forming — it stays in its birth session until it deploys. Type /deploy when it's ready.",
			);
			this.ui.requestRender();
			return;
		}
		if (!(await this.swapToNewSession("new"))) return;
		// Single source of truth for the reset+repaint (header + transcript). On an empty
		// fresh session this reproduces today's header-only output.
		await this.renderCurrentSessionState();
		this.chatContainer.addChild(new Text(theme.fg("dim", "✓ New session started."), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * `/compact [instructions]` — compact the session history. The live entries come from the daemon
	 * (`getEntries`), warnings surface via `appendErrorLine`, and the `compact` verb throws on
	 * failure, so compaction errors are caught and surfaced here.
	 */
	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		const messageCount = (await this.session.getEntries()).filter((e) => e.type === "message").length;
		if (messageCount < 2) {
			this.appendErrorLine("Nothing to compact (no messages yet).");
			this.ui.requestRender();
			return;
		}
		this.statusContainer.clear();
		try {
			await this.session.compact(customInstructions);
		} catch (error) {
			if (error instanceof AgentHarnessError && error.code === "busy") return;
			this.appendErrorLine(error instanceof Error ? error.message : String(error));
		}
		this.ui.requestRender();
	}

	/**
	 * Show a selector dialog: swap the editor for the selector in `editorContainer`, focus
	 * it (the TUI then routes input to it), and resolve when the user picks or cancels. An
	 * optional signal/timeout dismisses it programmatically — the deploy confirm passes
	 * neither; extensions may.
	 */
	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionSelector();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(option);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout, onToggleToolsExpanded: () => this.toggleToolOutputExpansion() },
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
	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	/** Show a single-line text input dialog, swapped into `editorContainer` like the selector. */
	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionInput);
			this.ui.setFocus(this.extensionInput);
			this.ui.requestRender();
		});
	}

	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionInput = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/** Show a multi-line editor dialog (with Ctrl+G external-editor support). */
	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => {
					this.hideExtensionEditor();
					resolve(value);
				},
				() => {
					this.hideExtensionEditor();
					resolve(undefined);
				},
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionEditor);
			this.ui.setFocus(this.extensionEditor);
			this.ui.requestRender();
		});
	}

	private hideExtensionEditor(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionEditor = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Swap in an extension-supplied editor (or restore the default on undefined). The new
	 * editor inherits the default's submit/change callbacks, current text, and appearance,
	 * so `handleSubmit` and bash-mode coloring keep working against `this.editor`.
	 */
	private setCustomEditorComponent(factory: EditorFactory | undefined): void {
		this.editorComponentFactory = factory;
		const currentText = this.editor.getText();
		this.editorContainer.clear();

		if (factory) {
			const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;
			newEditor.setText(currentText);
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			newEditor.setPaddingX?.(this.defaultEditor.getPaddingX());
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}
			this.editor = newEditor;
		} else {
			this.defaultEditor.setText(currentText);
			this.editor = this.defaultEditor;
		}

		this.editorContainer.addChild(this.editor);
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/** Route an extension notification to the matching chat-log line. */
	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	/**
	 * Show a custom component with keyboard focus. Overlay mode renders on top of existing
	 * content; otherwise the component takes over `editorContainer` until `done` is called.
	 */
	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			thm: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const savedText = this.editor.getText();
		const isOverlay = options?.overlay ?? false;

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.editor.setText(savedText);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) this.ui.hideOverlay();
				else restoreEditor();
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					// Ignore dispose errors.
				}
			};

			Promise.resolve(factory(this.ui, theme, this.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								return typeof options.overlayOptions === "function"
									? options.overlayOptions()
									: options.overlayOptions;
							}
							const w = (component as { width?: number }).width;
							return w ? { width: w } : undefined;
						};
						const handle = this.ui.showOverlay(component, resolveOptions());
						options?.onHandle?.(handle);
					} else {
						this.editorContainer.clear();
						this.editorContainer.addChild(component);
						this.ui.setFocus(component);
						this.ui.requestRender();
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		});
	}

	/** Surface an extension error (message plus indented stack) in the chat log. */
	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		const errorMsg = `Extension "${extensionPath}" error: ${error}`;
		this.chatContainer.addChild(new Text(theme.fg("error", errorMsg), 1, 0));
		if (stack) {
			const stackLines = stack
				.split("\n")
				.slice(1)
				.map((line) => theme.fg("dim", `  ${line.trim()}`))
				.join("\n");
			if (stackLines) {
				this.chatContainer.addChild(new Text(stackLines, 1, 0));
			}
		}
		this.ui.requestRender();
	}

	/** Set extension status text in the footer data provider (read by custom footers). */
	private setExtensionStatus(key: string, text: string | undefined): void {
		this.footerDataProvider.setExtensionStatus(key, text);
		this.ui.requestRender();
	}

	/** Show the streaming loader with the current working message/indicator. */
	private showWorkingLoader(): void {
		this.statusContainer.clear();
		if (!this.workingVisible) return;
		this.loader.setMessage(this.workingMessage ?? DEFAULT_WORKING_MESSAGE);
		this.loader.setIndicator(this.workingIndicatorOptions);
		this.statusContainer.addChild(this.loader);
		this.loader.start();
	}

	private setWorkingVisible(visible: boolean): void {
		this.workingVisible = visible;
		if (!visible) {
			this.loader.stop();
			this.statusContainer.clear();
		} else if (this.busy) {
			this.showWorkingLoader();
		}
		this.ui.requestRender();
	}

	private setWorkingIndicator(options?: WorkingIndicatorOptions): void {
		this.workingIndicatorOptions = options;
		if (this.busy && this.workingVisible) {
			this.loader.setIndicator(options);
		}
		this.ui.requestRender();
	}

	private setHiddenThinkingLabel(label?: string): void {
		this.hiddenThinkingLabel = label ?? DEFAULT_HIDDEN_THINKING_LABEL;
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
			}
		}
		this.streamingComponent?.setHiddenThinkingLabel(this.hiddenThinkingLabel);
		this.ui.requestRender();
	}

	/** Set or clear an extension widget (string array or component factory), then re-render. */
	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		const placement = options?.placement ?? "aboveEditor";
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);

		if (content === undefined) {
			this.renderWidgets();
			return;
		}

		let component: Component & { dispose?(): void };
		if (Array.isArray(content)) {
			const container = new Container();
			for (const line of content.slice(0, MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			component = container;
		} else {
			component = content(this.ui, theme);
		}

		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		targetMap.set(key, component);
		this.renderWidgets();
	}

	private clearExtensionWidgets(): void {
		for (const widget of this.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	private renderWidgets(): void {
		this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true);
		this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false);
		this.ui.requestRender();
	}

	private renderWidgetContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		leadingSpacer: boolean,
	): void {
		container.clear();
		if (widgets.size === 0) return;
		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	/** Install a custom footer component, or clear it (steward has no built-in footer row). */
	private setExtensionFooter(
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}
		this.footerContainer.clear();
		if (factory) {
			this.customFooter = factory(this.ui, theme, this.footerDataProvider);
			this.footerContainer.addChild(this.customFooter);
		} else {
			this.customFooter = undefined;
		}
		this.ui.requestRender();
	}

	/** Install a custom header component, or clear it (steward's built-in header is in the chat log). */
	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}
		this.headerContainer.clear();
		if (factory) {
			this.customHeader = factory(this.ui, theme);
			if (isExpandable(this.customHeader)) {
				this.customHeader.setExpanded(this.toolOutputExpanded);
			}
			this.headerContainer.addChild(this.customHeader);
		} else {
			this.customHeader = undefined;
		}
		this.ui.requestRender();
	}

	private addExtensionTerminalInputListener(handler: TerminalInputHandler): () => void {
		const unsubscribe = this.ui.addInputListener(handler);
		this.extensionTerminalInputUnsubscribers.add(unsubscribe);
		return () => {
			unsubscribe();
			this.extensionTerminalInputUnsubscribers.delete(unsubscribe);
		};
	}

	private clearExtensionTerminalInputListeners(): void {
		for (const unsubscribe of this.extensionTerminalInputUnsubscribers) {
			unsubscribe();
		}
		this.extensionTerminalInputUnsubscribers.clear();
	}

	/**
	 * Snapshot the extension keyboard shortcuts; handleGlobalInput matches against them. The
	 * runner is server-side, so the shortcut descriptors ride the snapshot — inert until Slice 4.
	 */
	private setupExtensionShortcuts(): void {
		this.extensionShortcuts = this.session.getShortcuts();
	}

	/** Reset all extension-owned UI back to defaults (before a reload rebuilds it). */
	private resetExtensionUI(): void {
		if (this.extensionSelector) this.hideExtensionSelector();
		if (this.extensionInput) this.hideExtensionInput();
		if (this.extensionEditor) this.hideExtensionEditor();
		this.ui.hideOverlay();
		this.clearExtensionTerminalInputListeners();
		this.extensionShortcuts = new Map();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		this.clearExtensionWidgets();
		this.footerDataProvider.clearExtensionStatuses();
		this.autocompleteProviderWrappers = [];
		this.setCustomEditorComponent(undefined);
		this.setupAutocompleteProvider();
		this.workingMessage = undefined;
		this.workingVisible = true;
		this.setWorkingIndicator();
		this.setHiddenThinkingLabel();
	}

	/**
	 * Client half of the extension-UI round-trip (Item 5): a daemon `extension_ui_request` is
	 * dispatched to the matching local dialog, then answered via `this.session.respondUi`. The
	 * daemon-side bridge (`DaemonUIContext` + `POST /ui-response`) lands in Slice 4, so no request
	 * arrives until then; this stub keeps the wiring in place.
	 */
	private dispatchUiRequest(_req: DaemonUiRequest): void {
		// Slice 4 (Item 5) fleshes this out: switch on req.method → showExtensionSelector/Input/Editor
		// (and the fire-and-forget setStatus/setWidget/... family) → this.session.respondUi(id, answer).
	}

	/** The UI surface handed to extensions via `ctx.ui`. */
	private createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			notify: (message, type) => this.showExtensionNotify(message, type),
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			setWorkingMessage: (message) => {
				this.workingMessage = message;
				if (this.busy && this.workingVisible) {
					this.loader.setMessage(message ?? DEFAULT_WORKING_MESSAGE);
				}
			},
			setWorkingVisible: (visible) => this.setWorkingVisible(visible),
			setWorkingIndicator: (options) => this.setWorkingIndicator(options),
			setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			setTitle: (title) => this.ui.terminal.setTitle(title),
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.editor.setText(text),
			getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			addAutocompleteProvider: (factory) => {
				this.autocompleteProviderWrappers.push(factory);
				this.setupAutocompleteProvider();
			},
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			getEditorComponent: () => this.editorComponentFactory,
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeOrName) => {
				if (themeOrName instanceof Theme) {
					setThemeInstance(themeOrName);
					this.ui.requestRender();
					return { success: true };
				}
				const result = setTheme(themeOrName, true);
				if (result.success) {
					this.ui.requestRender();
				}
				return result;
			},
			getToolsExpanded: () => this.toolOutputExpanded,
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	/**
	 * Session-control actions for extension command handlers. `waitForIdle`/`newSession`/
	 * `reload` are wired to steward's host; the tree-navigation actions (fork/navigateTree/
	 * switchSession) are out of scope here and report cancelled.
	 */
	private createCommandContextActions(): ExtensionCommandContextActions {
		return {
			waitForIdle: () => this.session.waitForIdle(),
			newSession: async () => {
				if (!(await this.swapToNewSession("new"))) return { cancelled: true };
				await this.renderCurrentSessionState();
				this.ui.requestRender();
				return { cancelled: false };
			},
			fork: async () => ({ cancelled: true }),
			navigateTree: async () => ({ cancelled: true }),
			switchSession: async () => ({ cancelled: true }),
			reload: async () => {
				await this.handleReloadCommand();
			},
		};
	}

	/**
	 * Run a user-typed shell command (`!cmd` / `!!cmd`).
	 *
	 * Extensions may intercept via the `user_bash` event: returning a `result` short-circuits
	 * execution, and returning `operations` swaps the shell backend. The result is recorded
	 * into the agent's context unless `!!` was used (`excludeFromContext`).
	 */
	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const eventResult = await this.session.emitUserBash({
			type: "user_bash",
			command,
			excludeFromContext,
			cwd: this.session.getCwd(),
		});

		// An extension handled execution itself — display and record its result directly.
		if (eventResult?.result) {
			const result = eventResult.result;
			this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
			this.chatContainer.addChild(this.bashComponent);
			if (result.output) {
				this.bashComponent.appendOutput(result.output);
			}
			this.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);
			await this.session.appendMessage(createBashExecutionMessage(command, result, { excludeFromContext }));
			this.bashComponent = undefined;
			this.ui.requestRender();
			return;
		}

		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
		this.chatContainer.addChild(this.bashComponent);
		this.ui.requestRender();

		this.bashAbortController = new AbortController();
		try {
			const result = await executeBashWithOperations(
				command,
				this.session.getCwd(),
				eventResult?.operations ?? createLocalBashOperations(),
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
			await this.session.appendMessage(createBashExecutionMessage(command, result, { excludeFromContext }));
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
				if (event.message.role === "user") {
					// User-role turns (typed, or injected from an integration like Telegram)
					// render their bubble straight from the event. The `/deploy` nudge is a
					// command, not a user turn, so its injected instruction shows no bubble.
					if (this.getUserMessageText(event.message) === DEPLOY_INSTRUCTION) break;
					this.addMessageToChat(event.message);
					this.updatePendingMessagesDisplay();
				} else if (isAssistantMessage(event.message) && event.message.stopReason !== "error" && event.message.stopReason !== "aborted") {
					// Failure messages are surfaced at message_end; don't open a bubble for them.
					this.beginAssistantMessage();
				}
				break;
			case "message_update":
				if (isAssistantMessage(event.message) && event.message.stopReason !== "error" && event.message.stopReason !== "aborted")
					this.updateAssistantMessage(event.message);
				break;
			case "message_end":
				// The user bubble was drawn at message_start; nothing to finalize.
				if (event.message.role === "user") break;
				if (isAssistantMessage(event.message)) this.finalizeAssistantMessage(event.message);
				break;
			case "queue_update":
				this.updatePendingMessagesDisplay();
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
						// No settings manager (showImages / imageWidthCells), so pass `{}`
						// and take the component defaults.
						{},
						this.getRegisteredToolDefinition(event.toolName),
						this.ui,
						this.session.getCwd(),
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
	 * Get a registered tool definition by name (for custom rendering). There is no
	 * extension tool registry — every tool is built-in, and `ToolExecutionComponent`
	 * reconstructs the built-in renderer from `cwd` itself. So there is never an override
	 * to return; this is always `undefined`.
	 */
	private getRegisteredToolDefinition(_toolName: string): undefined {
		return undefined;
	}

	// =========================================================================
	// Resume-transcript render. Repaints a resumed session into the chat view:
	// `getUserMessageText`/`addMessageToChat`/`renderSessionContext`/
	// `renderInitialMessages`/`renderCurrentSessionState`. The data layer comes from the
	// daemon (`buildSessionContext`); this only owns the TUI paint, using `this.markdownTheme`
	// for markdown and the plain text form for the aborted-tool stamp.
	// =========================================================================

	/** Extract the plain-text portion of a user message (""  for any other role). */
	private getUserMessageText(message: AgentMessage): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return textBlocks.map((c) => (c as { text: string }).text).join("");
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				if (message.display) {
					const renderer = this.session.getMessageRenderer();
					const component = new CustomMessageComponent(message, renderer, this.markdownTheme);
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, this.markdownTheme);
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, this.markdownTheme);
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (textContent) {
					if (this.chatContainer.children.length > 0) {
						this.chatContainer.addChild(new Spacer(1));
					}
					const skillBlock = parseSkillBlock(textContent);
					if (skillBlock) {
						// Render skill block (collapsible)
						const component = new SkillInvocationMessageComponent(skillBlock, this.markdownTheme);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						// Render user message separately if present
						if (skillBlock.userMessage) {
							this.chatContainer.addChild(new Spacer(1));
							const userComponent = new UserMessageComponent(skillBlock.userMessage, this.markdownTheme);
							this.chatContainer.addChild(userComponent);
						}
					} else {
						const userComponent = new UserMessageComponent(textContent, this.markdownTheme);
						this.chatContainer.addChild(userComponent);
					}
					if (options?.populateHistory) {
						this.editor.addToHistory?.(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const assistantComponent = new AssistantMessageComponent(
					message,
					false,
					this.markdownTheme,
					this.hiddenThinkingLabel,
				);
				this.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				const _exhaustive: never = message;
			}
		}
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after compaction.
	 * @param sessionContext Session context to render
	 * @param options.populateHistory Add user messages to editor history
	 */
	private renderSessionContext(sessionContext: SessionContext, options: { populateHistory?: boolean } = {}): void {
		this.pendingTools.clear();
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();

		for (const message of sessionContext.messages) {
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				this.addMessageToChat(message);
				// Render tool call components
				for (const content of message.content) {
					if (content.type === "toolCall") {
						const component = new ToolExecutionComponent(
							content.name,
							content.id,
							content.arguments,
							// No settings manager, so pass `{}` and take the component defaults
							// (matches the live `tool_execution_start` path).
							{},
							this.getRegisteredToolDefinition(content.name),
							this.ui,
							this.session.getCwd(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);

						if (message.stopReason === "aborted" || message.stopReason === "error") {
							// A resumed branch has no live retry counter, so use the plain
							// aborted/error text.
							const errorMessage =
								message.stopReason === "aborted" ? "Operation aborted" : message.errorMessage || "Error";
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
						} else {
							renderedPendingTools.set(content.id, component);
						}
					}
				}
			} else if (message.role === "toolResult") {
				// Match tool results to pending tool components
				const component = renderedPendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					renderedPendingTools.delete(message.toolCallId);
				}
			} else {
				// All other messages use standard rendering
				this.addMessageToChat(message, options);
			}
		}

		// In-flight tools with no persisted result stay pending.
		for (const [toolCallId, component] of renderedPendingTools) {
			this.pendingTools.set(toolCallId, component);
		}
		this.ui.requestRender();
	}

	/**
	 * Paint the resumed transcript: the engine's flattened session context, then a
	 * compaction-count notice if the session was compacted. On birth the context is
	 * empty, so this renders nothing and the seeded opener is appended afterward.
	 */
	async renderInitialMessages(): Promise<void> {
		const context = await this.session.buildSessionContext();
		this.renderSessionContext(context, { populateHistory: true });

		// Show compaction info if session was compacted: append a dim line directly.
		const compactionCount = (await this.session.getEntries()).filter((e) => e.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.chatContainer.addChild(new Text(theme.fg("dim", `Session compacted ${times}`), 1, 0));
			this.chatContainer.addChild(new Spacer(1));
		}
	}

	/**
	 * Reset the view and repaint from the current session (header + transcript). The
	 * single source of truth for `/new`. Resets the transient per-session fields
	 * (streaming component, pending tools) before repainting.
	 */
	private async renderCurrentSessionState(): Promise<void> {
		this.chatContainer.clear();
		this.streamingComponent = undefined;
		this.pendingTools.clear();
		this.appendHeader();
		await this.renderInitialMessages();
	}

	/**
	 * Get all queued messages (read-only) from the daemon's queue snapshot (kept fresh by the
	 * `queue_update` event), flattening the steer/follow-up lists to text via `getUserMessageText`.
	 */
	private getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
		return {
			steering: this.session
				.getSteeringMessages()
				.map((m) => this.getUserMessageText(m))
				.filter((t) => t.length > 0),
			followUp: this.session
				.getFollowUpMessages()
				.map((m) => this.getUserMessageText(m))
				.filter((t) => t.length > 0),
		};
	}

	/** Clear all queued messages and return their contents (the `clear_queue` verb round-trips). */
	private async clearAllQueues(): Promise<{ steering: string[]; followUp: string[] }> {
		const { steering, followUp } = await this.session.clearQueue();
		return {
			steering: steering.map((m) => this.getUserMessageText(m)).filter((t) => t.length > 0),
			followUp: followUp.map((m) => this.getUserMessageText(m)).filter((t) => t.length > 0),
		};
	}

	private updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();
		const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
		if (steeringMessages.length > 0 || followUpMessages.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			for (const message of steeringMessages) {
				const text = theme.fg("dim", `Steering: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of followUpMessages) {
				const text = theme.fg("dim", `Follow-up: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			const dequeueHint = keyDisplayText("app.message.dequeue");
			const hintText = theme.fg("dim", `↳ ${dequeueHint} to edit all queued messages`);
			this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
	}

	private async handleFollowUp(): Promise<void> {
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		if (!text) return;

		// Alt+Enter queues a follow-up message (waits until agent finishes)
		if (this.busy) {
			this.editor.addToHistory?.(text);
			this.editor.setText("");
			await this.session.prompt(text, { streamingBehavior: "followUp" });
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
		}
		// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
		else if (this.editor.onSubmit) {
			this.editor.setText("");
			this.editor.onSubmit(text);
		}
	}

	private async handleDequeue(): Promise<void> {
		const restored = await this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.showStatus("No queued messages to restore");
		} else {
			this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	private async restoreQueuedMessagesToEditor(): Promise<number> {
		const { steering, followUp } = await this.clearAllQueues();
		const allQueued = [...steering, ...followUp];
		if (allQueued.length === 0) {
			this.updatePendingMessagesDisplay();
			return 0;
		}
		const queuedText = allQueued.join("\n\n");
		const currentText = this.editor.getText();
		const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
		this.editor.setText(combinedText);
		this.updatePendingMessagesDisplay();
		this.ui.requestRender();
		return allQueued.length;
	}

	private beginAssistantMessage(): void {
		this.streamingComponent = new AssistantMessageComponent(
			undefined,
			false,
			this.markdownTheme,
			this.hiddenThinkingLabel,
		);
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
						// No settings manager (see `tool_execution_start`); pass `{}` for the
						// component defaults.
						{},
						this.getRegisteredToolDefinition(content.name),
						this.ui,
						this.session.getCwd(),
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
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			// Drop any partial bubble and show the error/abort detail instead.
			// A dedicated failure path handles aborted/error stop reasons here, and no
			// component is ever opened for failure messages (see the `message_start`
			// guard), so there is no double-rendering.
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

	/**
	 * Append a dim status line, reusing the previous one when it is still the last child so
	 * a burst of status updates collapses to a single live line.
	 */
	private showStatus(message: string): void {
		const children = this.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			this.lastStatusText.setText(theme.fg("dim", message));
			this.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(theme.fg("dim", message), 1, 0);
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
		this.ui.requestRender();
	}

	private showError(errorMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.ui.requestRender();
	}

	private showWarning(warningMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		this.ui.requestRender();
	}

	/**
	 * `/reload` — the daemon rebuilds extensions, skills, prompts, and keybindings in place. Guards
	 * against running mid-stream, resets extension-owned UI, then re-wires autocomplete + shortcuts
	 * from the refreshed snapshot. The conversation is kept.
	 */
	private async handleReloadCommand(): Promise<void> {
		if (this.busy) {
			this.showWarning("Wait for the current response to finish before reloading.");
			return;
		}

		this.resetExtensionUI();
		try {
			await this.session.reload();
			this.keybindings.reload();
			this.setupAutocompleteProvider();
			this.setupExtensionShortcuts();
			const summary = this.session.getResourceSummary();
			this.showStatus(
				`Reloaded: ${summary.extensions} extensions, ${summary.skills} skills, ${summary.prompts} prompts, ${summary.commands} commands.`,
			);
			this.appendResourceDiagnostics(summary.diagnostics);
		} catch (error) {
			this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private setBusy(busy: boolean): void {
		if (this.busy === busy) return;
		this.busy = busy;
		if (busy) {
			this.showWorkingLoader();
		} else {
			this.loader.stop();
			this.statusContainer.clear();
			this.ui.setFocus(this.editor);
		}
	}

	/**
	 * Recolor the editor border for bash mode. There is no per-keystroke thinking state, so the
	 * non-bash branch restores the editor's constructed default border (`getEditorTheme().borderColor`).
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
		// The `Editor` has no `onAction`, so resolve the configured key here against the
		// global keybindings (seeded with `app.tools.expand` by `KeybindingsManager`).
		if (getKeybindings().matches(data, "app.tools.expand")) {
			this.toggleToolOutputExpansion();
			return { consume: true };
		}
		// Queue the editor text as a follow-up (alt+enter) or restore all queued messages to
		// the editor (alt+up). Resolved here because the Editor has no `onAction`; skipped
		// while a dialog owns the editor (it consumes its own keys).
		if (!this.extensionSelector && !this.extensionInput && !this.extensionEditor) {
			if (getKeybindings().matches(data, "app.message.followUp")) {
				void this.handleFollowUp();
				return { consume: true };
			}
			if (getKeybindings().matches(data, "app.message.dequeue")) {
				void this.handleDequeue();
				return { consume: true };
			}
		}
		// Extension-registered shortcuts. Skipped while a dialog owns the editor (it has
		// focus and consumes its own keys), matching the editor-focused dispatch elsewhere.
		if (
			this.extensionShortcuts.size > 0 &&
			!this.extensionSelector &&
			!this.extensionInput &&
			!this.extensionEditor
		) {
			for (const [shortcut, registered] of this.extensionShortcuts) {
				if (matchesKey(data, shortcut)) {
					Promise.resolve(registered.handler(this.session.createShortcutContext())).catch((err) => {
						this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
					});
					return { consume: true };
				}
			}
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
				await this.session.abort();
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
