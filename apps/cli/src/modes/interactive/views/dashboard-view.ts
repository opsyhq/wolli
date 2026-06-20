/**
 * Dashboard page: a `SelectList` of agents (`steward.list()`, no daemon). Press `n` to create one (then
 * drop into its birth chat), or `d` to delete the highlighted one after a type-the-name confirm. Both
 * flows open as centered modals via `tui.showOverlay`, which captures focus while they're up.
 *
 * Layout is a fixed skeleton built once in `onMount`: a stable `listContainer` (rebuilt only when the
 * agent set changes) and a static `actionContainer` of key hints. State changes mutate one region and
 * lean on the TUI's differential render — no whole-view clear, no forced repaint.
 */

import { type Agent, getSelectListTheme, theme } from "@opsyhq/steward";
import {
	Box,
	type Component,
	Container,
	type Focusable,
	Input,
	matchesKey,
	type OverlayHandle,
	type OverlayOptions,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
} from "@opsyhq/tui";
import { type AppView, BIRTH_OPENER, type ViewContext } from "../app.ts";
import { DeleteConfirm } from "./components/delete-confirm.ts";

/** Centered modal sizing, shared by the create and delete overlays. */
const MODAL_OPTIONS: OverlayOptions = { anchor: "center", width: "50%", minWidth: 40, maxHeight: "60%" };

/** Raised-surface background so a modal reads as a layer above the page. */
const panelBg = (t: string): string => theme.bg("selectedBg", t);

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

	/** Rebuild the agent list. Runs once on mount, then only when the set changes (after a delete). */
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

	/** Static key hints; the list-dependent actions only show when there's a selectable list. */
	private renderAction(): void {
		this.actionContainer.clear();
		const browseKeys = this.list ? "enter chat · tab/→ details · d delete · " : "";
		this.actionContainer.addChild(new Text(theme.fg("dim", `${browseKeys}n new · q quit`), 1, 0));
	}

	handleInput(data: string): void {
		// While a modal is up it owns focus, so this only runs in the browse state.
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
				this.closeOverlay();
				void this.ctx.navigate({ to: "chat", name: agent.name, initialAssistantMessage: BIRTH_OPENER });
			},
			onCancel: () => this.closeOverlay(),
			onQuit: () => this.ctx.quit(),
		});
		this.overlay = this.ctx.tui.showOverlay(create, MODAL_OPTIONS);
	}

	private openDelete(): void {
		const selected = this.list?.getSelectedItem();
		if (!selected) return; // Empty list / no selection: nothing to delete.
		const agent = this.ctx.steward.get(selected.value);
		if (!agent) return;

		const confirm = new DeleteConfirm(agent, {
			onCancel: () => this.closeOverlay(),
			onDeleted: () => {
				// The deleted agent drops out of the list — that's the confirmation.
				this.renderList();
				this.renderAction();
				this.closeOverlay();
			},
			onQuit: () => this.ctx.quit(),
		});
		this.overlay = this.ctx.tui.showOverlay(confirm, MODAL_OPTIONS);
	}

	/** Tear down the active modal and hand focus back to the dashboard (hide() repaints). */
	private closeOverlay(): void {
		this.overlay?.hide();
		this.overlay = undefined;
	}

	focusTarget(): Component {
		return this;
	}

	onUnmount(): void {
		// Defensive: never let a modal survive a view swap (navigation happens mid-flow).
		this.overlay?.hide();
		this.overlay = undefined;
	}
}

interface CreateAgentCallbacks {
	/** Create the agent (validates the name, rejects collisions); may throw. */
	create: (name: string) => Agent;
	/** The agent exists now; the host navigates into its birth chat. */
	onCreated: (agent: Agent) => void;
	/** Esc: abandon creation, return to the dashboard unchanged. */
	onCancel: () => void;
	/** Ctrl+C inside the modal still quits the whole shell. */
	onQuit: () => void;
}

/**
 * New-agent modal. Dashboard-only, so it lives here rather than in its own component file. Shown as a
 * centered overlay (captures focus); takes a name, creates via `create`, and surfaces validation/IO
 * errors inline while keeping the modal open. Mirrors `DeleteConfirm`'s shape by hand — no shared base.
 */
class CreateAgent implements Component, Focusable {
	private readonly callbacks: CreateAgentCallbacks;
	private readonly input = new Input();
	private readonly status = new Text("", 1, 0);
	private readonly box = new Box(2, 1, panelBg);

	constructor(callbacks: CreateAgentCallbacks) {
		this.callbacks = callbacks;
		this.box.addChild(new Text(theme.fg("accent", "New agent"), 1, 0));
		this.box.addChild(new Text(theme.fg("dim", "Name it, then describe its purpose in chat."), 1, 0));
		this.box.addChild(this.input);
		this.box.addChild(this.status);
		this.box.addChild(new Spacer(1));
		this.box.addChild(new Text(theme.fg("dim", "enter create · esc cancel"), 1, 0));
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
		const name = this.input.getValue().trim();
		if (name.length === 0) return; // Enter on a blank field: no-op, not an error.
		// create() validates the name and rejects collisions; catch surfaces that (and IO errors) inline
		// without crashing the synchronous input dispatch.
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
