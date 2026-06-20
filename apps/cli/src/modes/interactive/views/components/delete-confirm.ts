/**
 * Type-the-name delete confirmation, shared by the dashboard and the agent detail page. It is shown as
 * a centered modal via `tui.showOverlay`, so the TUI captures focus and routes keystrokes straight to
 * this component. It makes the operator retype the target agent's name, then tears it down via
 * `Agent.delete()`. A name mismatch or a failed delete surfaces inline and stays put; `onCancel`/
 * `onDeleted` hand control back to the host view, which hides the overlay and decides what happens next
 * (re-list, navigate home, etc.).
 */

import { type Agent, theme } from "@opsyhq/steward";
import { Box, type Component, type Focusable, Input, matchesKey, Spacer, Text } from "@opsyhq/tui";

export interface DeleteConfirmCallbacks {
	/** Esc: abandon the delete, return to the host view unchanged. */
	onCancel: () => void;
	/** The agent's home is gone; the host decides where to go next. */
	onDeleted: () => void;
	/** Ctrl+C inside the modal still quits the whole shell. */
	onQuit: () => void;
}

/** Raised-surface background so the modal reads as a layer above the page. */
const panelBg = (t: string): string => theme.bg("selectedBg", t);

export class DeleteConfirm implements Component, Focusable {
	private readonly agent: Agent;
	private readonly callbacks: DeleteConfirmCallbacks;
	private readonly input = new Input();
	private readonly status = new Text("", 1, 0);
	private readonly box = new Box(2, 1, panelBg);

	constructor(agent: Agent, callbacks: DeleteConfirmCallbacks) {
		this.agent = agent;
		this.callbacks = callbacks;

		this.box.addChild(new Text(theme.fg("accent", `Delete agent "${agent.name}"`), 1, 0));
		this.box.addChild(new Text(theme.fg("dim", "This removes its memory, sessions, and workspace."), 1, 0));
		this.box.addChild(new Text(theme.fg("dim", `Type ${agent.name} to confirm:`), 1, 0));
		this.box.addChild(this.input);
		this.box.addChild(this.status);
		this.box.addChild(new Spacer(1));
		this.box.addChild(new Text(theme.fg("dim", "enter delete · esc cancel"), 1, 0));
	}

	/** Focusable: the overlay owns focus, so mirror it onto the inner input for its cursor. */
	get focused(): boolean {
		return this.input.focused;
	}
	set focused(value: boolean) {
		this.input.focused = value;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.callbacks.onQuit();
			return;
		}
		if (matchesKey(data, "escape")) {
			this.callbacks.onCancel();
			return;
		}
		if (matchesKey(data, "enter")) {
			this.submit();
			return;
		}
		this.input.handleInput(data);
	}

	private submit(): void {
		// Type-the-name gate: Enter only fires the delete on an exact match.
		if (this.input.getValue().trim() !== this.agent.name) {
			this.status.setText(theme.fg("warning", `Name doesn't match. Type ${this.agent.name} to confirm.`));
			return;
		}
		const result = this.agent.delete();
		if (!result.ok) {
			this.status.setText(theme.fg("warning", result.error ?? "Delete failed."));
			return;
		}
		this.callbacks.onDeleted();
	}

	render(width: number): string[] {
		return this.box.render(width);
	}

	invalidate(): void {
		this.box.invalidate();
	}
}
