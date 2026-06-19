/**
 * Standalone startup-TUI dialog mounts — a pure, generic dialog-mount helper (no daemon coupling).
 * Each call spins up a short-lived TUI for one prompt and tears it down on answer. The onboarding
 * dispatcher in `commands/integrations.ts` uses these to render the daemon's onboarding dialogs.
 */

import { ProcessTerminal, setKeybindings, TUI } from "@opsyhq/tui";
import {
	ExtensionInputComponent,
	ExtensionSelectorComponent,
	initTheme,
	KeybindingsManager,
	type SettingsManager,
} from "@opsyhq/steward";

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
