/** Agent detail page: a scaffold from `agent.config` with placeholder sections. Never opens a daemon. */

import { type Agent, isDeployed, theme } from "@opsyhq/steward";
import { type Component, Container, matchesKey, Spacer, Text } from "@opsyhq/tui";
import type { AppView, ViewContext } from "../app.ts";

const PLACEHOLDER_SECTIONS = ["Tools", "Integrations", "Runtime"];

export class AgentView extends Container implements AppView {
	private ctx!: ViewContext;
	private readonly agent: Agent;

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

		this.addChild(new Text(theme.fg("dim", "enter/→ chat · esc/← back"), 1, 0));
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
		if (matchesKey(data, "escape") || matchesKey(data, "left")) {
			this.ctx.home();
		}
	}

	focusTarget(): Component {
		return this;
	}

	onUnmount(): void {}
}
