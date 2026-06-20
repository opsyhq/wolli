/**
 * Agent detail page: a scaffold from `agent.config` with placeholder sections. Never opens a daemon.
 *
 * The config never changes while mounted, so the scaffold is built once in `onMount`. Pressing `d`
 * opens a type-the-name delete confirm as a centered modal via `tui.showOverlay`, which captures focus
 * while it's up.
 */

import { type Agent, isDeployed, theme } from "@opsyhq/steward";
import { type Component, Container, matchesKey, type OverlayHandle, type OverlayOptions, Spacer, Text } from "@opsyhq/tui";
import type { AppView, ViewContext } from "../app.ts";
import { DeleteConfirm } from "./components/delete-confirm.ts";

const PLACEHOLDER_SECTIONS = ["Tools", "Integrations", "Runtime"];

/** Centered modal sizing for the delete confirm overlay. */
const MODAL_OPTIONS: OverlayOptions = { anchor: "center", width: "50%", minWidth: 40, maxHeight: "60%" };

export class AgentView extends Container implements AppView {
	private ctx!: ViewContext;
	private readonly agent: Agent;
	private overlay?: OverlayHandle;

	constructor(agent: Agent) {
		super();
		this.agent = agent;
	}

	onMount(ctx: ViewContext): void {
		this.ctx = ctx;
		const config = this.agent.config;

		this.addChild(new Text(theme.bold(config.name), 1, 0));
		const deployed = isDeployed(config);
		const when = deployed && config.deployedAt ? config.deployedAt : config.createdAt;
		this.addChild(new Text(theme.fg("dim", `${deployed ? "Deployed" : "Forming"} · ${when}`), 1, 0));
		this.addChild(new Spacer(1));

		const purpose = config.purpose.trim();
		if (purpose) {
			this.addChild(new Text(purpose, 1, 0));
			this.addChild(new Spacer(1));
		}
		this.addChild(new Text(theme.fg("dim", `Model: ${config.model ?? "default"}`), 1, 0));
		this.addChild(new Spacer(1));

		for (const label of PLACEHOLDER_SECTIONS) {
			this.addChild(new Text(theme.bold(label), 1, 0));
			this.addChild(new Text(theme.fg("dim", "(placeholder — populated later)"), 1, 0));
			this.addChild(new Spacer(1));
		}

		this.addChild(new Text(theme.fg("dim", "enter/→ chat · d delete · esc/← back"), 1, 0));
	}

	handleInput(data: string): void {
		// While the modal is up it owns focus, so this only runs in the browse state.
		if (matchesKey(data, "ctrl+c")) {
			this.ctx.quit();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "right")) {
			void this.ctx.navigate({ to: "chat", name: this.agent.name });
			return;
		}
		if (data === "d") {
			this.openDelete();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "left")) {
			this.ctx.home();
		}
	}

	private openDelete(): void {
		const confirm = new DeleteConfirm(this.agent, {
			onCancel: () => this.closeOverlay(),
			// The agent is gone — fall back to the dashboard, which re-lists from disk.
			onDeleted: () => {
				this.closeOverlay();
				this.ctx.home();
			},
			onQuit: () => this.ctx.quit(),
		});
		this.overlay = this.ctx.tui.showOverlay(confirm, MODAL_OPTIONS);
	}

	/** Tear down the active modal and hand focus back to the detail page (hide() repaints). */
	private closeOverlay(): void {
		this.overlay?.hide();
		this.overlay = undefined;
	}

	focusTarget(): Component {
		return this;
	}

	onUnmount(): void {
		// Defensive: never let the modal survive a view swap (onDeleted navigates home).
		this.overlay?.hide();
		this.overlay = undefined;
	}
}
