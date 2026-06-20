/**
 * The interactive TUI shell. `App` owns the terminal and swaps between pages (dashboard, agent
 * detail, chat). Navigation is flat: `home()` (←/Esc) returns to the dashboard, `navigate()` opens a
 * page, `quit()` (Ctrl+C) exits. Global init and the sole `tui.start()`/`stop()` live here.
 */

import { type AgentSession, initTheme, type Steward } from "@opsyhq/steward";
import { type Component, Container, ProcessTerminal, setKeybindings, TUI } from "@opsyhq/tui";
import { KeybindingsManager } from "../../keybindings-manager.ts";
import { AgentView } from "./views/agent-view.ts";
import { ChatView } from "./views/chat-view.ts";
import { DashboardView } from "./views/dashboard-view.ts";

/** A newly born agent opens the chat itself, asking its human what it is for. Seeded as the chat opener. */
export const BIRTH_OPENER = "What is my purpose?";

/** A navigation target. The chat route carries the optional birth opener from `new`. */
export type Route =
	| { to: "dashboard" }
	| { to: "agent"; name: string }
	| { to: "chat"; name: string; initialAssistantMessage?: string };

export type Navigate = (route: Route) => Promise<void>;

/** Wiring handed to each view on mount: the shared TUI, the agent collection, and navigation. */
export interface ViewContext {
	tui: TUI;
	steward: Steward;
	/** Open a page (dashboard → details, dashboard → chat, details → chat). */
	navigate: Navigate;
	/** Return to the global dashboard from anywhere — what ←/Esc map to. */
	home: () => void;
	/** Quit the whole process from anywhere — what Ctrl+C / `/quit` map to. */
	quit: () => void;
}

/** A page in the shell. Every view is a `Container` so it gets `render`/`addChild`/`clear` for free. */
export interface AppView extends Component {
	onMount(ctx: ViewContext): void | Promise<void>;
	onUnmount(): void;
	focusTarget(): Component;
}

export class App {
	private readonly tui: TUI;
	private readonly steward: Steward;
	private readonly keybindings: KeybindingsManager;
	private readonly root: Container;
	private readonly ctx: ViewContext;
	private current?: AppView;
	private resolveExit?: () => void;
	private stopped = false;

	constructor(steward: Steward) {
		// Theme + keybindings must be initialized before any styling runs.
		initTheme();
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		this.tui = new TUI(new ProcessTerminal());
		this.steward = steward;
		this.root = new Container();
		this.tui.addChild(this.root);
		this.ctx = {
			tui: this.tui,
			steward,
			navigate: (route) => this.openView(route),
			home: () => void this.openView({ to: "dashboard" }),
			quit: () => this.stop(),
		};
	}

	/** The single process entry: start the terminal, show the opening route, block until exit. */
	async start(route: Route): Promise<void> {
		this.tui.start();
		await this.openView(route);
		await new Promise<void>((resolve) => {
			this.resolveExit = resolve;
		});
	}

	/** Build a fresh page for the route and swap it in. Unknown agents fall back to the dashboard. */
	private async openView(route: Route): Promise<void> {
		switch (route.to) {
			case "dashboard":
				await this.show(new DashboardView());
				return;
			case "agent": {
				// Crash on the impossible "agent dir vanished" case rather than silently redirecting.
				const agent = this.steward.get(route.name)!;
				let session: AgentSession | undefined;
				try {
					session = await agent.open();
				} catch {
					// Daemon unreachable — still show the page, just without the capability sections.
					session = undefined;
				}
				await this.show(new AgentView(agent, session));
				return;
			}
			case "chat": {
				const agent = this.steward.get(route.name);
				if (!agent) {
					await this.show(new DashboardView());
					return;
				}
				const session = await agent.open();
				await this.show(
					new ChatView(session, { initialAssistantMessage: route.initialAssistantMessage }, this.keybindings),
				);
				return;
			}
		}
	}

	/** Swap the visible view: unmount the old, mount the new onto the root, focus it, force a repaint. */
	private async show(view: AppView): Promise<void> {
		this.current?.onUnmount();
		this.root.clear();
		this.root.addChild(view);
		this.current = view;
		await view.onMount(this.ctx);
		this.tui.setFocus(view.focusTarget());
		// Force a full repaint: pages differ in height, so prior lines must be cleared.
		this.tui.requestRender(true);
	}

	/** Idempotent shutdown. */
	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.current?.onUnmount();
		this.tui.stop();
		this.resolveExit?.();
	}
}
