/** Type-the-name delete confirm modal, shared by the dashboard and the agent detail view. */

import { type Agent, theme } from "@opsyhq/steward";
import { Box, type Component, type Focusable, Input, matchesKey, Spacer, Text } from "@opsyhq/tui";

export interface DeleteConfirmCallbacks {
	onCancel: () => void;
	onDeleted: () => void;
	onQuit: () => void;
}

export class DeleteConfirm implements Component, Focusable {
	private readonly agent: Agent;
	private readonly callbacks: DeleteConfirmCallbacks;
	private readonly input = new Input();
	private readonly status = new Text("", 1, 0);
	private readonly box = new Box(2, 1, (t) => theme.bg("selectedBg", t));

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
