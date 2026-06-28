import { Editor, type EditorOptions, type EditorTheme, matchesKey, type TUI } from "@opsyhq/tui";
import type { AppKeybinding, KeybindingsManager } from "@opsyhq/wolli";

/**
 * Editor that dispatches app keybindings from its own `handleInput`, i.e. on the focused-component
 * path the TUI already release-filters (so a key fires once per physical press, unlike a raw input
 * listener). Also the base for extension editors via `ctx.ui.setEditorComponent`.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Left-arrow at the very start of the input (e.g. navigate back). */
	public onLeftAtStart?: () => void;
	/** Extension-registered shortcuts; returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
	}

	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Intercept paste-image only when a handler is registered (the default key is Ctrl+V).
		if (this.onPasteImage && this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage();
			return;
		}

		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			super.handleInput(data); // escape cancels autocomplete
			return;
		}

		if (this.keybindings.matches(data, "app.exit") && this.getText().length === 0) {
			const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
			if (handler) {
				handler();
				return;
			}
		}

		// Left-arrow only navigates at the buffer start; elsewhere it falls through to move the cursor.
		if (this.onLeftAtStart && matchesKey(data, "left") && this.isCursorAtStart() && !this.isShowingAutocomplete()) {
			this.onLeftAtStart();
			return;
		}

		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		super.handleInput(data);
	}
}
