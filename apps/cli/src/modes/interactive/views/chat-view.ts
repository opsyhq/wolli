/**
 * Interactive TUI chat mode — a daemon client.
 *
 * Drives a `SessionHandle` (the one `fetch`/SSE seam) instead of an in-process `SessionHost`:
 * actions are control-command round-trips and the event stream arrives over SSE, byte-identical to
 * the in-process harness events this consumed before. Those events are bridged onto a small
 * retained-mode component tree (a chat log `Container`, a status `Container` holding a `Loader`, and
 * an `Editor`). Streaming assistant text is routed through an `AssistantMessageComponent`, whose
 * `updateContent(message)` is called in place on each delta so the prefix cache and the renderer
 * both stay warm — and so thinking blocks render in order rather than being dropped.
 *
 * Subscribe handlers must stay fast and non-throwing.
 */

import type { Api, AssistantMessage, Model, OAuthSelectOption } from "@earendil-works/pi-ai";
import {
	AgentHarnessError,
	type AgentHarnessEvent,
	type AgentMessage,
	type SessionContext,
	type ThinkingLevel,
} from "@opsyhq/agent";
import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	type Component,
	Container,
	type EditorComponent,
	Loader,
	type MarkdownTheme,
	matchesKey,
	type OverlayHandle,
	type OverlayOptions,
	type SlashCommand,
	Spacer,
	Text,
	TruncatedText,
	TUI,
} from "@opsyhq/tui";
import {
	type AuthSelectorProvider,
	type AutocompleteProviderFactory,
	BUILTIN_SLASH_COMMANDS,
	createBashExecutionMessage,
	createCompactionSummaryMessage,
	createHostEnvironment,
	type EditorFactory,
	ensureTool,
	executeBash,
	type ExtensionShortcut,
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionUIRequest,
	type ExtensionWidgetOptions,
	findExactModelReferenceMatch,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getMarkdownTheme,
	getThemeByName,
	isDeployed,
	isValidThinkingLevel,
	keyDisplayText,
	type KeyId,
	LoginDialogComponent,
	type LoginUIRequest,
	parseSkillBlock,
	rawKeyHint,
	type ReadonlyFooterDataProvider,
	type ResourceDiagnostic,
	type SessionHandle,
	setTheme,
	setThemeInstance,
	type SourceInfo,
	type TerminalInputHandler,
	Theme,
	theme,
	type TruncationResult,
	type WorkingIndicatorOptions,
} from "@opsyhq/voli";
import { FooterDataProvider } from "../../../footer-data-provider.ts";
import { KeybindingsManager } from "../../../keybindings-manager.ts";
import type { AppView, ViewContext } from "../app.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.ts";
import { CustomMessageComponent } from "./components/custom-message.ts";
import { ExtensionEditorComponent } from "./components/extension-editor.ts";
import { ExtensionInputComponent } from "./components/extension-input.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.ts";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.ts";
import { ThinkingSelectorComponent } from "./components/thinking-selector.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { UserMessageComponent } from "./components/user-message.ts";

/** Window (ms) within which a second Ctrl+C quits instead of clearing the editor. */
const CTRL_C_EXIT_WINDOW_MS = 500;

/** Window (ms) within which a second left-arrow (at the start of the input) navigates back. */
const BACK_ARROW_WINDOW_MS = 2000;

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
export interface ChatViewOptions {
	/**
	 * Seed an assistant message into the session on startup and render it, with no
	 * model turn. `main.ts` sets it to the birth opener for a freshly created agent.
	 */
	initialAssistantMessage?: string;
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return (message as { role?: string }).role === "assistant";
}

/** A message typed while a compaction was running, flushed once it ends. */
type CompactionQueuedMessage = { text: string; mode: "steer" | "followUp" };

/** Interface for components that can be expanded/collapsed */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

export class ChatView extends Container implements AppView {
	private readonly session: SessionHandle;
	private readonly options: ChatViewOptions;
	// The TUI, view context, editor, and loader are owned by `App` and wired in `onMount`.
	private ui!: TUI;
	private ctx!: ViewContext;
	private readonly chatContainer: Container;
	// Dim "Steering:/Follow-up:" lines for messages queued while a turn is streaming,
	// rendered between the chat log and the status line.
	private readonly pendingMessagesContainer: Container;
	private readonly statusContainer: Container;
	private readonly editorContainer: Container;
	private readonly statusContainerBelow: Container;
	private readonly keybindings: KeybindingsManager;
	// The active input editor. Defaults to `defaultEditor` and is swapped when an extension
	// supplies one via `ctx.ui.setEditorComponent` (restored to the default on undefined).
	private editor!: EditorComponent;
	private defaultEditor!: CustomEditor;
	private loader!: Loader;
	private readonly markdownTheme: MarkdownTheme;
	// Extension UI chrome. The header/footer containers hold extension-supplied components
	// (empty otherwise — voli has no built-in header/footer rows); the widget containers
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
	// Extension keyboard shortcuts, matched by the editor's onExtensionShortcut hook; terminal-input
	// listeners, tracked so reload can drop them; the custom editor factory and last composed provider.
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
	private busy = false;
	// Compaction UI state. `autoCompactionLoader` is the status-line spinner shown while a compaction
	// runs; `autoCompactionEscapeHandler` saves the editor's prior Escape handler so it can be restored
	// after compaction (Escape cancels the compaction meanwhile); `compactionQueuedMessages` holds input
	// typed during a compaction, flushed when it ends.
	private autoCompactionLoader?: Loader;
	private autoCompactionEscapeHandler?: () => void;
	private compactionQueuedMessages: CompactionQueuedMessage[] = [];
	private streamingComponent?: AssistantMessageComponent;
	private lastSigintTime = 0;
	private lastBackArrowTime = 0;
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

	constructor(session: SessionHandle, options: ChatViewOptions = {}, keybindings: KeybindingsManager) {
		super();
		this.session = session;
		this.options = options;
		// `App` owns the TUI and global init; the keybindings handle is threaded in for extensions.
		this.keybindings = keybindings;
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.editorContainer = new Container();
		this.statusContainerBelow = new Container();
		this.headerContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.footerContainer = new Container();
		this.footerDataProvider = new FooterDataProvider(this.session.getCwd());
		this.markdownTheme = getMarkdownTheme();
	}

	/**
	 * Mount the chat onto `App`'s terminal: build the editor + loader, wire the session/extension
	 * plumbing, mount the region containers, then paint the transcript and seed the opener. `App` owns
	 * `tui.start()` and focus.
	 */
	async onMount(ctx: ViewContext): Promise<void> {
		this.ui = ctx.tui;
		this.ctx = ctx;
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, { paddingX: 1 });
		this.editor = this.defaultEditor;
		this.loader = new Loader(
			this.ui,
			(text) => theme.fg("accent", text),
			(text) => theme.fg("muted", text),
			"Working...",
		);
		// The Loader starts its animation timer on construction; halt it until busy.
		this.loader.stop();

		// App keybindings dispatch from the editor (the release-filtered focused path), not a raw input
		// listener. On defaultEditor so a swapped-in extension editor inherits them.
		this.defaultEditor.onAction("app.clear", () => void this.handleCtrlC());
		this.defaultEditor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion());
		this.defaultEditor.onAction("app.model.select", () => void this.showModelSelector());
		this.defaultEditor.onAction("app.message.followUp", () => void this.handleFollowUp());
		this.defaultEditor.onAction("app.message.dequeue", () => void this.handleDequeue());
		this.defaultEditor.onLeftAtStart = () => this.handleBackArrow();
		this.defaultEditor.onExtensionShortcut = (data) => this.handleExtensionShortcut(data);

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
		// The extension runner lives server-side, so its UI requests arrive over the wire: route
		// the daemon's extension_ui_request stream to the client dialogs.
		this.session.onUiRequest = (req) => void this.dispatchUiRequest(req);
		this.setupExtensionShortcuts();

		// Mount the region containers onto this view (itself a Container on `App`'s root).
		this.addChild(this.headerContainer);
		this.addChild(this.chatContainer);
		this.addChild(this.pendingMessagesContainer);
		this.addChild(this.widgetContainerAbove);
		this.addChild(this.statusContainer);
		this.addChild(this.editorContainer);
		this.addChild(this.statusContainerBelow);
		this.addChild(this.widgetContainerBelow);
		this.addChild(this.footerContainer);
		this.editorContainer.addChild(this.editor);

		this.appendHeader();
		this.showResourceSummary();

		// Paint the resumed transcript (the persisted opener + any prior turns). On
		// birth the session is empty, so this renders nothing and the seed below paints
		// the opener once.
		await this.renderInitialMessages();

		// Seed an assistant opener instead of running a user turn: a newly born agent
		// opens the chat itself. Fire-and-forget.
		// Gated on `!hasMessageEntries` so the seed is strictly idempotent: if a `message`
		// entry already exists (resume, or a `new` run against a populated session) the
		// opener was already rendered by `renderInitialMessages` and is not re-seeded.
		const hasMessageEntries = (await this.session.getEntries()).some((e) => e.type === "message");
		if (this.options.initialAssistantMessage && !hasMessageEntries) {
			void this.seedInitialAssistantMessage(this.options.initialAssistantMessage);
		}
	}

	focusTarget(): Component {
		return this.editor;
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

	/** Tear down on nav-away: stop the loader, drop the subscription, close the session (daemon lives). */
	onUnmount(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.loader.stop();
		this.unsubscribe?.();
		this.session.close();
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
		// `/new` — start a fresh session and switch to it.
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
		// `/quit` — exit voli (same as Ctrl+C).
		if (trimmed === "/quit") {
			this.editor.setText("");
			this.ctx.quit();
			return;
		}
		// `/scoped-models` — toggle/reorder the session model shortlist.
		if (trimmed === "/scoped-models") {
			this.editor.setText("");
			await this.showModelsSelector();
			return;
		}
		// `/model [search]` — switch the model (exact match switches immediately; else opens the selector).
		if (trimmed === "/model" || trimmed.startsWith("/model ")) {
			const searchTerm = trimmed.startsWith("/model ") ? trimmed.slice(7).trim() || undefined : undefined;
			this.editor.setText("");
			await this.handleModelCommand(searchTerm);
			return;
		}
		// `/thinking [level]` — set the thinking level (valid level applies immediately; else opens the selector).
		if (trimmed === "/thinking" || trimmed.startsWith("/thinking ")) {
			const level = trimmed.startsWith("/thinking ") ? trimmed.slice(10).trim() || undefined : undefined;
			this.editor.setText("");
			await this.handleThinkingCommand(level);
			return;
		}
		// `/login` — pick an auth method + provider, then run the login daemon-side.
		if (trimmed === "/login") {
			this.editor.setText("");
			await this.handleLoginCommand();
			return;
		}
		// `/logout` — pick a provider with stored credentials and remove it.
		if (trimmed === "/logout") {
			this.editor.setText("");
			await this.handleLogoutCommand();
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

		// Queue input typed during a compaction (extension commands still run immediately).
		if (this.session.isCompacting) {
			if (this.isExtensionCommand(trimmed)) {
				this.editor.addToHistory?.(trimmed);
				this.editor.setText("");
				await this.session.prompt(trimmed);
			} else {
				this.queueCompactionMessage(trimmed, "steer");
			}
			return;
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
	 * Commit the deploy. The daemon flips the latch, registers the OS service unit, and creates a fresh
	 * deployed session (with a real backend it also stands up the supervised daemon and re-points the
	 * client transport onto it). The App then replaces this chat with the new session's.
	 */
	private async doDeploy(): Promise<void> {
		try {
			const sessionId = await this.ctx.deploy();
			await this.ctx.switchSession(sessionId);
		} catch (error) {
			this.appendErrorLine(error instanceof Error ? error.message : String(error));
			this.ui.requestRender();
		}
	}

	/**
	 * `/new` — create a fresh session (additive: the daemon keeps the others live) and have the App
	 * switch to its chat. While the agent is still forming it stays in its single birth session, so
	 * `/new` is refused here (the primary guard) and again by the daemon (the birth-session invariant).
	 */
	private async handleNewCommand(): Promise<void> {
		if (!isDeployed(this.session.config)) {
			this.appendErrorLine(
				"This agent is still forming — it stays in its birth session until it deploys. Type /deploy when it's ready.",
			);
			this.ui.requestRender();
			return;
		}
		try {
			const sessionId = await this.ctx.createSession();
			await this.ctx.switchSession(sessionId);
		} catch (error) {
			this.appendErrorLine(error instanceof Error ? error.message : String(error));
			this.ui.requestRender();
		}
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
		try {
			await this.session.compact(customInstructions);
		} catch (error) {
			if (error instanceof AgentHarnessError && error.code === "busy") return;
			this.appendErrorLine(error instanceof Error ? error.message : String(error));
		}
		this.ui.requestRender();
	}

	/**
	 * Swap the editor for a selector in `editorContainer`, focus it (the TUI routes input there),
	 * and restore the editor when `done` fires. De-dups the clear/addChild/setFocus idiom the model
	 * and scoped-model panels share; teardown mirrors `hideExtensionSelector`.
	 */
	private showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		const done = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
		};
		const { component, focus } = create(done);
		this.editorContainer.clear();
		this.editorContainer.addChild(component);
		this.ui.setFocus(focus);
		this.ui.requestRender();
	}

	/**
	 * `/model [search]` — switch the model. With no arg, open the selector; with an exact match,
	 * switch immediately; otherwise open the selector seeded with the search term.
	 */
	private async handleModelCommand(searchTerm?: string): Promise<void> {
		if (!searchTerm) {
			await this.showModelSelector();
			return;
		}

		const model = await this.findExactModelMatch(searchTerm);
		if (model) {
			try {
				await this.session.setModel(model.provider, model.id);
				this.ui.requestRender();
				this.updateEditorBorderColor();
				this.showStatus(`Model: ${model.id}`);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		await this.showModelSelector(searchTerm);
	}

	private async findExactModelMatch(searchTerm: string): Promise<Model<Api> | undefined> {
		const models = await this.getModelCandidates();
		return findExactModelReferenceMatch(searchTerm, models);
	}

	private async getModelCandidates(): Promise<Model<Api>[]> {
		const scopedModels = this.session.getScopedModels();
		if (scopedModels.length > 0) {
			return scopedModels.map((scoped) => scoped.model);
		}
		try {
			return await this.session.getAvailableModels();
		} catch {
			return [];
		}
	}

	/**
	 * Open the single-pick model selector. The candidate list + current scope are pre-fetched (the
	 * daemon owns the registry), then handed to the component. Selecting switches the model.
	 */
	private async showModelSelector(initialSearchInput?: string): Promise<void> {
		const available = await this.session.getAvailableModels();
		const scopedModels = this.session.getScopedModels();
		this.showSelector((done) => {
			const selector = new ModelSelectorComponent(
				this.ui,
				this.session.getModel(),
				available,
				scopedModels,
				async (model) => {
					try {
						await this.session.setModel(model.provider, model.id);
						this.ui.requestRender();
						this.updateEditorBorderColor();
						done();
						this.showStatus(`Model: ${model.id}`);
					} catch (error) {
						done();
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSearchInput,
			);
			return { component: selector, focus: selector };
		});
	}

	/**
	 * `/thinking [level]` — set the thinking level. With no arg, open the selector; with a valid level,
	 * apply it immediately; otherwise open the selector.
	 */
	private async handleThinkingCommand(level?: string): Promise<void> {
		if (!level) {
			this.showThinkingSelector();
			return;
		}

		if (isValidThinkingLevel(level)) {
			try {
				await this.session.setThinkingLevel(level);
				this.ui.requestRender();
				this.showStatus(`Thinking level: ${level}`);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		this.showThinkingSelector();
	}

	/**
	 * Open the thinking-level selector. The current level + the model's supported levels come from the
	 * cached snapshot (the daemon clamps internally), then are handed to the component. Selecting applies
	 * the level.
	 */
	private showThinkingSelector(): void {
		this.showSelector((done) => {
			const selector = new ThinkingSelectorComponent(
				this.session.getThinkingLevel(),
				this.session.getAvailableThinkingLevels(),
				async (level) => {
					try {
						await this.session.setThinkingLevel(level);
						this.ui.requestRender();
						done();
						this.showStatus(`Thinking level: ${level}`);
					} catch (error) {
						done();
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector.getSelectList() };
		});
	}

	/**
	 * `/login` — pick an auth method, then a provider, then run the login through the shared login
	 * dialog. The daemon drives the OAuth/api-key flow over the login seam (`login_ui_request` frames
	 * dispatched by `dispatchLoginRequest`); on success the new provider's models become selectable via `/model`.
	 */
	private async handleLoginCommand(): Promise<void> {
		const subscriptionLabel = "Use a subscription";
		const apiKeyLabel = "Use an API key";
		this.showSelector((done) => {
			const selector = new ExtensionSelectorComponent(
				"Select authentication method:",
				[subscriptionLabel, apiKeyLabel],
				(option) => {
					done();
					void this.showLoginProviderSelector(option === subscriptionLabel ? "oauth" : "api_key");
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private async showLoginProviderSelector(authType: "oauth" | "api_key"): Promise<void> {
		const providers = await this.session.getLoginProviderOptions(authType);
		if (providers.length === 0) {
			this.showStatus(
				authType === "oauth" ? "No subscription providers available." : "No API key providers available.",
			);
			return;
		}
		this.showSelector((done) => {
			const selector = new ExtensionSelectorComponent(
				"Select a provider:",
				providers.map((provider) => provider.name),
				async (label) => {
					done();
					const provider = providers.find((p) => p.name === label);
					if (!provider) return;
					await this.runProviderLogin(provider);
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	/**
	 * Run a provider login over the daemon login seam: swap a shared `LoginDialogComponent` into the
	 * editor, bind `session.onLoginRequest` to dispatch each daemon frame into it (answering the awaited
	 * frames via `respondLogin`), then `await session.login(...)`. The browser opens client-side (the
	 * dialog's show* methods call it) and credentials are written daemon-side only. Esc cancels the dialog
	 * → `loginCancel()` aborts the daemon flow; the handler is cleared and the editor restored on completion.
	 */
	private async runProviderLogin(provider: AuthSelectorProvider): Promise<void> {
		const dialog = new LoginDialogComponent(
			this.ui,
			provider.id,
			(success) => {
				// onComplete only fires on cancel (Esc) — abort the in-flight daemon-side login.
				if (!success) void this.session.loginCancel();
			},
			provider.name,
		);
		this.session.onLoginRequest = (req) => this.dispatchLoginRequest(dialog, req);

		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();

		try {
			await this.session.login(provider.id, provider.authType);
			this.showStatus(`Logged in to ${provider.name}.`);
		} catch (error) {
			// A user cancel aborts the dialog's signal; only surface real failures.
			if (!dialog.signal.aborted) this.showError(error instanceof Error ? error.message : String(error));
		} finally {
			this.session.onLoginRequest = undefined;
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		}
	}

	/**
	 * Client half of the login round-trip: a daemon `login_ui_request` arrives over SSE (the login-seam
	 * sibling of `dispatchUiRequest`). The fire-and-forget frames (`auth`/`deviceCode`/`progress`) update
	 * the dialog; the awaited frames (`prompt`/`manualInput`/`select`) are shown locally and the answer is
	 * POSTed back via `respondLogin`, resolving the parked daemon-side promise.
	 */
	private dispatchLoginRequest(dialog: LoginDialogComponent, req: LoginUIRequest): void {
		switch (req.method) {
			case "auth":
				dialog.showAuth(req.url, req.instructions);
				return;
			case "deviceCode":
				dialog.showDeviceCode({ userCode: req.userCode, verificationUri: req.verificationUri });
				return;
			case "progress":
				dialog.showProgress(req.message);
				return;
			case "prompt":
				// The dialog input rejects on cancel; the loginCancel path drains the daemon side, so swallow.
				dialog
					.showPrompt(req.message, req.placeholder)
					.then((value) => this.session.respondLogin(req.id, { value }))
					.catch(() => {});
				return;
			case "manualInput":
				dialog
					.showManualInput("Paste the redirect URL or code, or finish in your browser:")
					.then((value) => this.session.respondLogin(req.id, { value }))
					.catch(() => {});
				return;
			case "select":
				void this.showLoginSelect(dialog, req.message, req.options).then((id) =>
					this.session.respondLogin(req.id, id === undefined ? { cancelled: true } : { value: id }),
				);
				return;
		}
	}

	/** Pick one option mid-login: swap an ExtensionSelector in over the dialog, restore the dialog after. */
	private showLoginSelect(
		dialog: LoginDialogComponent,
		message: string,
		options: OAuthSelectOption[],
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			const restoreDialog = () => {
				this.editorContainer.clear();
				this.editorContainer.addChild(dialog);
				this.ui.setFocus(dialog);
				this.ui.requestRender();
			};
			const selector = new ExtensionSelectorComponent(
				message,
				options.map((option) => option.label),
				(label) => {
					restoreDialog();
					resolve(options.find((option) => option.label === label)?.id);
				},
				() => {
					restoreDialog();
					resolve(undefined);
				},
			);
			this.editorContainer.clear();
			this.editorContainer.addChild(selector);
			this.ui.setFocus(selector);
			this.ui.requestRender();
		});
	}

	/** `/logout` — pick a provider with stored credentials and remove it. */
	private async handleLogoutCommand(): Promise<void> {
		const providers = await this.session.getLogoutProviderOptions();
		if (providers.length === 0) {
			this.showStatus("No stored credentials to remove.");
			return;
		}
		this.showSelector((done) => {
			const selector = new ExtensionSelectorComponent(
				"Log out of which provider?",
				providers.map((provider) => provider.name),
				async (label) => {
					done();
					const provider = providers.find((p) => p.name === label);
					if (!provider) return;
					try {
						await this.session.logout(provider.id);
						this.showStatus(`Logged out of ${provider.name}.`);
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	/**
	 * `/scoped-models` — toggle/reorder the session model shortlist. `onChange` switches the
	 * session-only scope (the daemon resolves the ids); `onPersist` (Ctrl+S) writes the agent-tier
	 * `enabledModels` to agent.json. All-enabled / none-enabled collapses to "no scope".
	 */
	private async showModelsSelector(): Promise<void> {
		const allModels = await this.session.getAvailableModels();
		if (allModels.length === 0) {
			this.showStatus("No models available");
			return;
		}

		const sessionScopedModels = this.session.getScopedModels();
		const currentEnabledIds: string[] | null =
			sessionScopedModels.length > 0
				? sessionScopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`)
				: null;

		const updateSessionModels = async (enabledIds: string[] | null) => {
			if (enabledIds && enabledIds.length > 0 && enabledIds.length < allModels.length) {
				await this.session.setScopedModels(enabledIds);
			} else {
				// All enabled or none enabled = no filter
				await this.session.setScopedModels([]);
			}
			this.ui.requestRender();
		};

		this.showSelector((done) => {
			const selector = new ScopedModelsSelectorComponent(
				{ allModels, enabledModelIds: currentEnabledIds },
				{
					onChange: async (enabledIds) => {
						await updateSessionModels(enabledIds);
					},
					onPersist: (enabledIds) => {
						const newPatterns =
							enabledIds === null || enabledIds.length === allModels.length ? undefined : enabledIds;
						void this.session.setEnabledModels(newPatterns ? [...newPatterns] : undefined);
						this.showStatus("Model selection saved to settings");
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector };
		});
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
			// If the swapped-in editor extends CustomEditor, copy the app actions/hooks onto it.
			// Duck-typed because `instanceof` is unreliable across module boundaries.
			const candidate = newEditor as unknown as Record<string, unknown>;
			if (candidate.actionHandlers instanceof Map) {
				candidate.onLeftAtStart ??= () => this.defaultEditor.onLeftAtStart?.();
				candidate.onExtensionShortcut ??= (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					(candidate.actionHandlers as Map<string, () => void>).set(action, handler);
				}
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

	/** Install a custom footer component, or clear it (voli has no built-in footer row). */
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

	/** Install a custom header component, or clear it (voli's built-in header is in the chat log). */
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
	 * Snapshot the extension keyboard shortcuts; handleExtensionShortcut matches against them. The
	 * runner is server-side and shortcuts aren't wired over the daemon, so this stays empty.
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
	 * Client half of the extension-UI round-trip: a daemon `extension_ui_request` arrives over SSE.
	 * The four awaited dialogs (`select`/`confirm`/`input`/`editor`) are shown locally and the user's
	 * answer is POSTed back via `this.session.respondUi`, resolving the parked daemon-side promise.
	 * The five fire-and-forget methods apply to this client's TUI with no response.
	 */
	private async dispatchUiRequest(req: ExtensionUIRequest): Promise<void> {
		switch (req.method) {
			// —— Awaited dialogs: show locally, answer the parked daemon promise ——
			case "select": {
				const value = await this.showExtensionSelector(req.title, req.options, { timeout: req.timeout });
				void this.session.respondUi(req.id, value === undefined ? { cancelled: true } : { value });
				return;
			}
			case "confirm": {
				// Drive the selector directly (not showExtensionConfirm) so cancel stays distinct from "No".
				const value = await this.showExtensionSelector(`${req.title}\n${req.message}`, ["Yes", "No"], {
					timeout: req.timeout,
				});
				void this.session.respondUi(req.id, value === undefined ? { cancelled: true } : { confirmed: value === "Yes" });
				return;
			}
			case "input": {
				const value = await this.showExtensionInput(req.title, req.placeholder, { timeout: req.timeout });
				void this.session.respondUi(req.id, value === undefined ? { cancelled: true } : { value });
				return;
			}
			case "editor": {
				const value = await this.showExtensionEditor(req.title, req.prefill);
				void this.session.respondUi(req.id, value === undefined ? { cancelled: true } : { value });
				return;
			}

			// —— Fire-and-forget: apply to this client's TUI, no response ——
			case "notify":
				this.showExtensionNotify(req.message, req.notifyType);
				return;
			case "setStatus":
				this.setExtensionStatus(req.statusKey, req.statusText);
				return;
			case "setWidget":
				this.setExtensionWidget(req.widgetKey, req.widgetLines, { placement: req.widgetPlacement });
				return;
			case "setTitle":
				this.ui.terminal.setTitle(req.title);
				return;
			case "setEditorText":
				this.editor.setText(req.text);
				return;
		}
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
	 * Run a user-typed shell command (`!cmd` / `!!cmd`).
	 *
	 * Extensions may intercept via the `user_bash` event: returning a `result` short-circuits
	 * execution, and returning `environment` swaps the backend the command runs in. The result is
	 * recorded into the agent's context unless `!!` was used (`excludeFromContext`).
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
			const result = await executeBash(
				command,
				this.session.getCwd(),
				eventResult?.environment ?? createHostEnvironment(this.session.getCwd()),
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
			case "compaction_start": {
				// Keep the editor active; submissions are queued during compaction. Repurpose Escape to
				// cancel the compaction, saving the prior handler to restore at compaction_end.
				this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					void this.session.abortCompaction();
				};
				this.statusContainer.clear();
				const cancelHint = `(${keyDisplayText("app.interrupt")} to cancel)`;
				const label =
					event.reason === "manual"
						? `Compacting context... ${cancelHint}`
						: `${event.reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
				this.autoCompactionLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					label,
				);
				this.statusContainer.addChild(this.autoCompactionLoader);
				break;
			}
			case "compaction_end": {
				// Restore the editor's prior Escape handler (undefined by default in voli).
				this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
				this.autoCompactionEscapeHandler = undefined;
				if (this.autoCompactionLoader) {
					this.autoCompactionLoader.stop();
					this.autoCompactionLoader = undefined;
					this.statusContainer.clear();
				}
				if (event.aborted) {
					if (event.reason === "manual") {
						this.showError("Compaction cancelled");
					} else {
						this.showStatus("Auto-compaction cancelled");
					}
				} else if (event.result) {
					// Repaint the compacted context, then append the summary at the boundary so the
					// [compaction] marker lands where the user is, not just at messages[0] off-screen
					// above the kept window. Mirrors coding-agent's compaction_end result branch; the
					// rebuild is awaited first because voli's runs against the daemon.
					const result = event.result;
					void this.rebuildChatFromMessages().then(() => {
						this.addMessageToChat(
							createCompactionSummaryMessage(result.summary, result.tokensBefore, new Date().toISOString()),
						);
						this.ui.requestRender();
					});
				} else if (event.errorMessage) {
					if (event.reason === "manual") {
						this.showError(event.errorMessage);
					} else {
						this.chatContainer.addChild(new Spacer(1));
						this.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
					}
				}
				void this.flushCompactionQueue({ willRetry: event.willRetry });
				break;
			}
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
			if (message.role === "assistant") {
				this.addMessageToChat(message);
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
				const component = renderedPendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					renderedPendingTools.delete(message.toolCallId);
				}
			} else {
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
			steering: [
				...this.session
					.getSteeringMessages()
					.map((m) => this.getUserMessageText(m))
					.filter((t) => t.length > 0),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
			],
			followUp: [
				...this.session
					.getFollowUpMessages()
					.map((m) => this.getUserMessageText(m))
					.filter((t) => t.length > 0),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
			],
		};
	}

	/**
	 * Clear all queued messages (session queue + compaction queue) and return their contents (the
	 * `clear_queue` verb round-trips for the session queue).
	 */
	private async clearAllQueues(): Promise<{ steering: string[]; followUp: string[] }> {
		const { steering, followUp } = await this.session.clearQueue();
		const compactionSteering = this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text);
		const compactionFollowUp = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "followUp")
			.map((msg) => msg.text);
		this.compactionQueuedMessages = [];
		return {
			steering: [...steering.map((m) => this.getUserMessageText(m)).filter((t) => t.length > 0), ...compactionSteering],
			followUp: [...followUp.map((m) => this.getUserMessageText(m)).filter((t) => t.length > 0), ...compactionFollowUp],
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

		// Queue input typed during a compaction (extension commands still run immediately).
		if (this.session.isCompacting) {
			if (this.isExtensionCommand(text)) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text);
			} else {
				this.queueCompactionMessage(text, "followUp");
			}
			return;
		}

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

	/** Whether `text` is a registered extension command (run immediately even during compaction). */
	private isExtensionCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		return this.session.getCommands().some((command) => command.name === commandName && command.source === "extension");
	}

	/** Hold a message typed during a compaction; it is flushed when the compaction ends. */
	private queueCompactionMessage(text: string, mode: "steer" | "followUp"): void {
		this.compactionQueuedMessages.push({ text, mode });
		this.editor.addToHistory?.(text);
		this.editor.setText("");
		this.updatePendingMessagesDisplay();
		this.showStatus("Queued message for after compaction");
	}

	/**
	 * Flush messages queued during a compaction once it ends. When a retry is pending the messages
	 * ride the retry turn (steer/follow-up); otherwise the first non-command message starts a fresh
	 * turn and the rest queue behind it. Extension commands run immediately on either path.
	 */
	private async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.compactionQueuedMessages];
		this.compactionQueuedMessages = [];
		this.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			void this.session.clearQueue();
			this.compactionQueuedMessages = queuedMessages;
			this.updatePendingMessagesDisplay();
			this.showError(
				`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		};

		try {
			if (options?.willRetry) {
				// A retry is pending: queue the messages for the retry turn.
				for (const message of queuedMessages) {
					if (this.isExtensionCommand(message.text)) {
						await this.session.prompt(message.text);
					} else if (message.mode === "followUp") {
						await this.session.prompt(message.text, { streamingBehavior: "followUp" });
					} else {
						await this.session.prompt(message.text, { streamingBehavior: "steer" });
					}
				}
				this.updatePendingMessagesDisplay();
				return;
			}

			// Find the first non-extension-command message to use as the prompt that starts the turn.
			const firstPromptIndex = queuedMessages.findIndex((message) => !this.isExtensionCommand(message.text));
			if (firstPromptIndex === -1) {
				// All extension commands - execute them all.
				for (const message of queuedMessages) {
					await this.session.prompt(message.text);
				}
				return;
			}

			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex]!;
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				await this.session.prompt(message.text);
			}

			// Send the first prompt (starts streaming).
			const promptPromise = this.session.prompt(firstPrompt.text).catch((error) => {
				restoreQueue(error);
			});

			// Queue the remaining messages behind it.
			for (const message of rest) {
				if (this.isExtensionCommand(message.text)) {
					await this.session.prompt(message.text);
				} else if (message.mode === "followUp") {
					await this.session.prompt(message.text, { streamingBehavior: "followUp" });
				} else {
					await this.session.prompt(message.text, { streamingBehavior: "steer" });
				}
			}
			this.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	/** Clear the chat log and repaint it from the (compacted) session context. Mirrors coding-agent's `rebuildChatFromMessages`. */
	private async rebuildChatFromMessages(): Promise<void> {
		this.chatContainer.clear();
		const context = await this.session.buildSessionContext();
		this.renderSessionContext(context);
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

	/** Match a key against the extension shortcuts (wired to the editor's `onExtensionShortcut`). */
	private handleExtensionShortcut(data: string): boolean {
		for (const [shortcut, registered] of this.extensionShortcuts) {
			if (matchesKey(data, shortcut)) {
				Promise.resolve(registered.handler(this.session.createShortcutContext())).catch((err) => {
					this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
				});
				return true;
			}
		}
		return false;
	}

	/** Left-arrow at the input start: two-press (hint, then navigate) back to the dashboard. */
	private handleBackArrow(): void {
		const now = Date.now();
		if (now - this.lastBackArrowTime < BACK_ARROW_WINDOW_MS) {
			this.lastBackArrowTime = 0;
			this.ctx.home();
			return;
		}
		this.lastBackArrowTime = now;
		this.statusContainerBelow.clear();
		const hint = new Text(theme.fg("dim", "Press ← again for the dashboard."), 1, 0);
		this.statusContainerBelow.addChild(hint);
		this.ui.requestRender();
		setTimeout(() => {
			if (this.statusContainerBelow.children.length === 1 && this.statusContainerBelow.children[0] === hint) {
				this.statusContainerBelow.clear();
				this.ui.requestRender();
			}
		}, BACK_ARROW_WINDOW_MS);
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
			this.ctx.quit();
			return;
		}
		this.lastSigintTime = now;
		this.editor.setText("");
		this.statusContainerBelow.clear();
		const hint = new Text(theme.fg("dim", "Press Ctrl+C again to exit."), 1, 0);
		this.statusContainerBelow.addChild(hint);
		this.ui.requestRender();
		setTimeout(() => {
			if (this.statusContainerBelow.children.length === 1 && this.statusContainerBelow.children[0] === hint) {
				this.statusContainerBelow.clear();
				this.ui.requestRender();
			}
		}, CTRL_C_EXIT_WINDOW_MS);
	}
}
