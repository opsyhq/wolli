/**
 * The interactive TUI shell. `App` owns the terminal and swaps between pages (dashboard, agent
 * detail, chat). A chat is 1:1 with a session: the shell shows exactly one `ChatView` at a time, and
 * `switchSession(id)` replaces it (used by `/new` and deploy). Navigation is flat: `home()` (←/Esc)
 * returns to the dashboard, `navigate()` opens a page, `quit()` (Ctrl+C) exits. Global init and the
 * sole `tui.start()`/`stop()` live here.
 */

import { type Agent, initTheme, type SessionHandle, type Wolli } from "@opsyhq/wolli";
import { type Component, Container, ProcessTerminal, setKeybindings, TUI } from "@opsyhq/tui";
import { KeybindingsManager } from "../../keybindings-manager.ts";
import { AgentView } from "./views/agent-view.ts";
import { ChatView } from "./views/chat-view.ts";
import { DashboardView } from "./views/dashboard-view.ts";
import { OnboardingView } from "./views/onboarding-view.ts";

/** A newly born agent opens the chat itself, asking its human what it is for. Seeded as the chat opener. */
export const BIRTH_OPENER = "What is my purpose?";

/** A navigation target. The chat route carries the optional birth opener from `new` and a session to open. */
export type Route =
	| { to: "dashboard" }
	| { to: "onboarding" }
	| { to: "agent"; name: string }
	| { to: "chat"; name: string; sessionId?: string; initialAssistantMessage?: string };

export type Navigate = (route: Route) => Promise<void>;

/** Wiring handed to each view on mount: the shared TUI, the agent collection, and navigation. */
export interface ViewContext {
	tui: TUI;
	wolli: Wolli;
	/** Open a page (dashboard → details, dashboard → chat, details → chat). */
	navigate: Navigate;
	/** Return to the global dashboard from anywhere — what ←/Esc map to. */
	home: () => void;
	/** Quit the whole process from anywhere — what Ctrl+C / `/quit` map to. */
	quit: () => void;
	/** Create a fresh session on the daemon (additive) and return its id. */
	createSession: () => Promise<string>;
	/** Commit the agent's deploy and return the fresh deployed session's id. */
	deploy: () => Promise<string>;
	/** Replace the visible chat with another session of the current agent (used by `/new` and deploy). */
	switchSession: (sessionId: string) => Promise<void>;
}

/** A page in the shell. Every view is a `Container` so it gets `render`/`addChild`/`clear` for free. */
export interface AppView extends Component {
	onMount(ctx: ViewContext): void | Promise<void>;
	onUnmount(): void;
	focusTarget(): Component;
}

export class App {
	private readonly tui: TUI;
	private readonly wolli: Wolli;
	private readonly keybindings: KeybindingsManager;
	private readonly root: Container;
	private readonly ctx: ViewContext;
	private current?: AppView;
	// Chat state: the connected agent backing the visible chat (the ChatView itself is `current`).
	private chatAgent?: Agent;
	private resolveExit?: () => void;
	private stopped = false;

	constructor(wolli: Wolli) {
		// Theme + keybindings must be initialized before any styling runs.
		initTheme();
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		this.tui = new TUI(new ProcessTerminal());
		this.wolli = wolli;
		this.root = new Container();
		this.tui.addChild(this.root);
		this.ctx = {
			tui: this.tui,
			wolli,
			navigate: (route) => this.openView(route),
			home: () => void this.openView({ to: "dashboard" }),
			quit: () => this.stop(),
			createSession: async () => (await this.requireChatAgent().createSession()).sessionId,
			deploy: async () => (await this.requireChatAgent().deploy()).sessionId,
			switchSession: (sessionId) => this.switchSession(sessionId),
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
				this.closeChat();
				await this.show(new DashboardView(this.keybindings));
				return;
			case "onboarding":
				this.closeChat();
				await this.show(new OnboardingView());
				return;
			case "agent": {
				this.closeChat();
				// Crash on the impossible "agent dir vanished" case rather than silently redirecting.
				const agent = this.wolli.get(route.name)!;
				let session: SessionHandle | undefined;
				try {
					await agent.connect();
					session = await agent.getLatestSession();
				} catch {
					// Daemon unreachable — still show the page, just without the capability sections.
					session = undefined;
				}
				await this.show(new AgentView(agent, session));
				return;
			}
			case "chat": {
				const agent = this.wolli.get(route.name);
				if (!agent) {
					await this.show(new DashboardView(this.keybindings));
					return;
				}
				await agent.connect();
				this.chatAgent = agent;
				const handle = route.sessionId ? await agent.getSession(route.sessionId) : await agent.getLatestSession();
				await this.mountChat(handle, { initialAssistantMessage: route.initialAssistantMessage });
				return;
			}
		}
	}

	/** Swap the visible non-chat view: unmount the old, mount the new onto the root, focus it, repaint. */
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

	/** Mount a fresh ChatView for `handle` as the visible page, unmounting whatever was shown. */
	private async mountChat(handle: SessionHandle, options: { initialAssistantMessage?: string }): Promise<void> {
		this.current?.onUnmount();
		const view = new ChatView(handle, options, this.keybindings);
		this.current = view;
		this.root.clear();
		this.root.addChild(view);
		await view.onMount(this.ctx);
		this.tui.setFocus(view.focusTarget());
		this.tui.requestRender(true);
	}

	/** The agent backing the current chat, or throw — used by the chat-lifecycle `ViewContext` actions. */
	private requireChatAgent(): Agent {
		if (!this.chatAgent) throw new Error("No connected agent for the current chat.");
		return this.chatAgent;
	}

	/**
	 * Replace the visible chat with another session's. The old `ChatView` is unmounted (its stream
	 * closes, so the idle session evicts on the daemon); a fresh one is mounted for `sessionId`. Used by
	 * `/new` and deploy — after a deploy reconnect, `agent.getSession()` resolves the handle on the new
	 * transport.
	 */
	private async switchSession(sessionId: string): Promise<void> {
		if (!this.chatAgent) return;
		const handle = await this.chatAgent.getSession(sessionId);
		await this.mountChat(handle, {});
	}

	/** Tear down the visible chat + the agent transport when leaving chat for another page. */
	private closeChat(): void {
		if (!this.chatAgent) return;
		this.current?.onUnmount();
		this.chatAgent.close();
		this.chatAgent = undefined;
		this.current = undefined;
	}

	/** Idempotent shutdown. */
	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.closeChat();
		this.current?.onUnmount();
		this.tui.stop();
		this.resolveExit?.();
	}
}
