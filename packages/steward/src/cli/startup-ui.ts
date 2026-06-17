import {
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	ProcessTerminal,
	setKeybindings,
	TUI,
} from "@opsyhq/tui";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { ExtensionInputComponent } from "../modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.ts";
import { initTheme, type Theme, theme } from "../modes/interactive/theme/theme.ts";

function createStartupTui(settingsManager: SettingsManager): TUI {
	initTheme(settingsManager.getTheme());
	setKeybindings(KeybindingsManager.create());
	const ui = new TUI(new ProcessTerminal(), settingsManager.getShowHardwareCursor());
	ui.setClearOnShrink(settingsManager.getClearOnShrink());
	return ui;
}

async function clearStartupTui(ui: TUI): Promise<void> {
	ui.clear();
	ui.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 25));
}

export async function showStartupSelector<T>(
	settingsManager: SettingsManager,
	title: string,
	options: Array<{ label: string; value: T }>,
): Promise<T | undefined> {
	return new Promise((resolve) => {
		const ui = createStartupTui(settingsManager);

		let settled = false;
		const finish = async (result: T | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const selector = new ExtensionSelectorComponent(
			title,
			options.map((option) => option.label),
			(option) => void finish(options.find((entry) => entry.label === option)?.value),
			() => void finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		ui.start();
	});
}

export async function showStartupInput(
	settingsManager: SettingsManager,
	title: string,
	placeholder?: string,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		const ui = createStartupTui(settingsManager);

		let settled = false;
		const finish = async (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			input.dispose();
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const input = new ExtensionInputComponent(
			title,
			placeholder,
			(value) => void finish(value),
			() => void finish(undefined),
			{ tui: ui },
		);
		ui.addChild(input);
		ui.setFocus(input);
		ui.start();
	});
}

/**
 * Show a caller-supplied component in a standalone TUI and resolve when its `done`
 * callback fires. Mirrors the mount logic of `InteractiveMode.showExtensionCustom`
 * (overlay vs. root child) but with the standalone startup-TUI lifecycle — there is no
 * persistent editor to restore, so teardown just clears + stops the TUI.
 */
export async function showStartupCustom<T>(
	settingsManager: SettingsManager,
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
	return new Promise((resolve, reject) => {
		const ui = createStartupTui(settingsManager);
		// A config-identical KeybindingsManager for the factory. (We can't hand it the exact
		// instance createStartupTui installed: getKeybindings() returns the @opsyhq/tui base
		// type, not steward's richer KeybindingsManager that the factory contract requires.)
		const keybindings = KeybindingsManager.create();
		const isOverlay = options?.overlay ?? false;

		let settled = false;
		let component: Component & { dispose?(): void };

		const finish = async (result: T) => {
			if (settled) {
				return;
			}
			settled = true;
			await clearStartupTui(ui);
			ui.stop();
			try {
				component?.dispose?.();
			} catch {
				// Ignore dispose errors.
			}
			resolve(result);
		};

		Promise.resolve(factory(ui, theme, keybindings, (result) => void finish(result)))
			.then((c) => {
				if (settled) return;
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
					const handle = ui.showOverlay(component, resolveOptions());
					options?.onHandle?.(handle);
				} else {
					ui.addChild(component);
					ui.setFocus(component);
				}
				ui.start();
			})
			.catch((err) => {
				if (settled) return;
				settled = true;
				ui.stop();
				reject(err);
			});
	});
}
