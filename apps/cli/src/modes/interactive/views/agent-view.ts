/** Agent detail page: config header plus live capability sections read from the daemon. */

import { type Agent, type AgentSession, isDeployed, theme } from "@opsyhq/steward";
import { type Component, Container, matchesKey, type OverlayHandle, Spacer, Text } from "@opsyhq/tui";
import type { AppView, ViewContext } from "../app.ts";
import { DeleteConfirm } from "./components/delete-confirm.ts";

export class AgentView extends Container implements AppView {
	private ctx!: ViewContext;
	private readonly agent: Agent;
	private readonly session?: AgentSession;
	private overlay?: OverlayHandle;

	constructor(agent: Agent, session?: AgentSession) {
		super();
		this.agent = agent;
		this.session = session;
	}

	async onMount(ctx: ViewContext): Promise<void> {
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
		this.addChild(new Text(theme.fg("dim", `Model: ${config.settings?.defaultModel ?? "default"}`), 1, 0));
		this.addChild(new Spacer(1));

		// Live capability sections are rendered only when the daemon answered. No session (open
		// failed) or a failed fetch shows just the config header above.
		if (this.session) {
			try {
				const [toolInfo, integrations, skills, plugins, contexts] = await Promise.all([
					this.session.listTools(),
					this.session.listIntegrations(),
					this.session.listSkills(),
					this.session.listPlugins(),
					this.session.listContexts(),
				]);
				const activeTools = new Set(toolInfo.activeToolNames);
				this.addSection(
					"Tools",
					toolInfo.tools.map(
						(t) => `${activeTools.has(t.name) ? theme.fg("success", "●") : theme.fg("dim", "○")} ${t.name}`,
					),
				);
				this.addSection(
					"Integrations",
					integrations.map(
						(i) =>
							`${i.service} ${i.configured ? theme.fg("success", "configured") : theme.fg("dim", "not set up")} ${theme.fg("dim", `${i.actions.length} actions · ${i.events.length} events`)}`,
					),
				);
				this.addSection(
					"Skills",
					skills.map((s) => `${s.name} ${theme.fg("dim", s.description)}`),
				);
				this.addSection(
					"Plugins",
					plugins.map((p) => p.source),
				);
				this.addSection(
					"Contexts",
					contexts.map((c) => `${c.name} ${theme.fg("dim", `${c.chars} chars`)}`),
				);
			} catch {
				// Session unreachable mid-fetch -> render no capability sections.
			}
		}

		this.addChild(new Text(theme.fg("dim", "enter/→ chat · d delete · esc/← back"), 1, 0));
	}

	/** A bold-labeled section: one line per entry, or a dim "none" when empty; trailing spacer. */
	private addSection(label: string, lines: string[]): void {
		this.addChild(new Text(theme.bold(label), 1, 0));
		if (lines.length === 0) {
			this.addChild(new Text(theme.fg("dim", "none"), 1, 0));
		} else {
			for (const line of lines) {
				this.addChild(new Text(line, 1, 0));
			}
		}
		this.addChild(new Spacer(1));
	}

	handleInput(data: string): void {
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
			onCancel: () => this.overlay?.hide(),
			onDeleted: () => {
				this.overlay?.hide();
				this.ctx.home();
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
