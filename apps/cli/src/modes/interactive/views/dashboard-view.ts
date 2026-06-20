/** Dashboard: a SelectList of agents; `n` creates one, `d` deletes the highlighted one (both as modals). */

import { type Agent, getSelectListTheme, theme } from "@opsyhq/steward";
import {
	Box,
	type Component,
	Container,
	type Focusable,
	Input,
	matchesKey,
	type OverlayHandle,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
} from "@opsyhq/tui";
import { type AppView, BIRTH_OPENER, type ViewContext } from "../app.ts";
import { DeleteConfirm } from "./components/delete-confirm.ts";

export class DashboardView extends Container implements AppView {
	private ctx!: ViewContext;
	private readonly listContainer = new Container();
	private readonly actionContainer = new Container();
	private list?: SelectList;
	private overlay?: OverlayHandle;

	onMount(ctx: ViewContext): void {
		this.ctx = ctx;
		this.addChild(new Text(theme.bold("Agents"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(this.actionContainer);
		this.renderList();
		this.renderAction();
	}

	private renderList(): void {
		this.listContainer.clear();
		const items: SelectItem[] = this.ctx.steward.list().map((agent) => ({
			value: agent.name,
			label: agent.name,
			description: agent.config.purpose.trim().replace(/\s+/g, " "),
		}));
		if (items.length === 0) {
			this.list = undefined;
			this.listContainer.addChild(new Text(theme.fg("dim", "No agents yet."), 1, 0));
			return;
		}
		this.list = new SelectList(items, 12, getSelectListTheme());
		this.list.onSelect = (item) => void this.ctx.navigate({ to: "chat", name: item.value });
		this.listContainer.addChild(this.list);
	}

	private renderAction(): void {
		this.actionContainer.clear();
		const browseKeys = this.list ? "enter chat · tab/→ details · d delete · " : "";
		this.actionContainer.addChild(new Text(theme.fg("dim", `${browseKeys}n new · q quit`), 1, 0));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.ctx.quit();
			return;
		}
		if (data === "q") {
			this.ctx.quit();
			return;
		}
		if (data === "n") {
			this.openCreate();
			return;
		}
		if (data === "d") {
			this.openDelete();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "right")) {
			const selected = this.list?.getSelectedItem();
			if (selected) void this.ctx.navigate({ to: "agent", name: selected.value });
			return;
		}
		this.list?.handleInput(data);
	}

	private openCreate(): void {
		const create = new CreateAgent({
			create: (name) => this.ctx.steward.create(name),
			onCreated: (agent) => {
				this.overlay?.hide();
				void this.ctx.navigate({ to: "chat", name: agent.name, initialAssistantMessage: BIRTH_OPENER });
			},
			onCancel: () => this.overlay?.hide(),
			onQuit: () => this.ctx.quit(),
		});
		this.overlay = this.ctx.tui.showOverlay(create, { anchor: "center", width: "50%", minWidth: 40, maxHeight: "60%" });
	}

	private openDelete(): void {
		const selected = this.list?.getSelectedItem();
		if (!selected) return;
		const agent = this.ctx.steward.get(selected.value);
		if (!agent) return;

		const confirm = new DeleteConfirm(agent, {
			onCancel: () => this.overlay?.hide(),
			onDeleted: () => {
				this.renderList();
				this.renderAction();
				this.overlay?.hide();
			},
			onQuit: () => this.ctx.quit(),
		});
		this.overlay = this.ctx.tui.showOverlay(confirm, { anchor: "center", width: "50%", minWidth: 40, maxHeight: "60%" });
	}

	focusTarget(): Component {
		return this;
	}

	onUnmount(): void {
		this.overlay?.hide();
	}
}

interface CreateAgentCallbacks {
	create: (name: string) => Agent;
	onCreated: (agent: Agent) => void;
	onCancel: () => void;
	onQuit: () => void;
}

// New-agent modal; dashboard-only, so it lives here rather than in its own file.
class CreateAgent implements Component, Focusable {
	private readonly callbacks: CreateAgentCallbacks;
	private readonly input = new Input();
	private readonly status = new Text("", 1, 0);
	private readonly box = new Box(2, 1, (t) => theme.bg("selectedBg", t));

	constructor(callbacks: CreateAgentCallbacks) {
		this.callbacks = callbacks;
		this.box.addChild(new Text(theme.fg("accent", "New agent"), 1, 0));
		this.box.addChild(new Text(theme.fg("dim", "Name it, then describe its purpose in chat."), 1, 0));
		this.box.addChild(this.input);
		this.box.addChild(this.status);
		this.box.addChild(new Spacer(1));
		this.box.addChild(new Text(theme.fg("dim", "enter create · esc cancel"), 1, 0));
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
		const name = this.input.getValue().trim();
		if (name.length === 0) return;
		try {
			this.callbacks.onCreated(this.callbacks.create(name));
		} catch (error) {
			this.status.setText(theme.fg("warning", error instanceof Error ? error.message : String(error)));
		}
	}

	render(width: number): string[] {
		return this.box.render(width);
	}

	invalidate(): void {
		this.box.invalidate();
	}
}
