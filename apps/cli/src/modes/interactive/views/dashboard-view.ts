/** Dashboard page: a `SelectList` of agents read from disk (`steward.list()`, no daemon). */

import { getSelectListTheme, theme } from "@opsyhq/steward";
import { type Component, Container, matchesKey, type SelectItem, SelectList, Spacer, Text } from "@opsyhq/tui";
import type { AppView, ViewContext } from "../app.ts";

export class DashboardView extends Container implements AppView {
	private ctx!: ViewContext;
	private list?: SelectList;

	onMount(ctx: ViewContext): void {
		this.ctx = ctx;
		this.addChild(new Text(theme.bold("Agents"), 1, 0));
		this.addChild(new Spacer(1));

		const items: SelectItem[] = ctx.steward.list().map((agent) => ({
			value: agent.name,
			label: agent.name,
			description: agent.config.purpose.trim().replace(/\s+/g, " "),
		}));

		if (items.length === 0) {
			this.addChild(new Text(theme.fg("dim", "No agents yet. Create one with: steward new <name>"), 1, 0));
			return;
		}

		this.list = new SelectList(items, 12, getSelectListTheme());
		this.list.onSelect = (item) => void ctx.navigate({ to: "chat", name: item.value });
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "enter chat · tab/→ details · q quit"), 1, 0));
	}

	// The view holds focus (SelectList isn't Focusable); it delegates list keys (up/down/enter) below.
	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c") || data === "q") {
			this.ctx.quit();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "right")) {
			const selected = this.list?.getSelectedItem();
			if (selected) void this.ctx.navigate({ to: "agent", name: selected.value });
			return;
		}
		this.list?.handleInput(data);
	}

	focusTarget(): Component {
		return this;
	}

	onUnmount(): void {}
}
