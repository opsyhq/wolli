/**
 * Dashboard: arrows browse the agent list; typing drives the command menu. The bar runs the editor's
 * own autocomplete in bare-command mode — any letter opens the menu, Tab completes to /command, a
 * single Enter runs it, unknown input errors.
 *
 * The `model`/`thinking`/`login`/`logout` commands mirror the in-session ones but run against the
 * global tier in-process, so each change persists the shared default that agents inherit.
 */

import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@opsyhq/agent";
import {
  type Agent,
  AuthStorage,
  DEFAULT_THINKING_LEVEL,
  findExactModelReferenceMatch,
  getDefaultModel,
  getDefaultProvider,
  getDefaultThinkingLevel,
  getEditorTheme,
  getSelectListTheme,
  HOME_SLASH_COMMANDS,
  isApiKeyLoginProvider,
  isDeployed,
  ModelRegistry,
  openBrowser,
  rawKeyHint,
  setSharedDefaultModel,
  setSharedDefaultThinkingLevel,
  theme,
  THINKING_LEVELS,
} from "@opsyhq/steward";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  Box,
  type Component,
  Container,
  type Focusable,
  fuzzyFilter,
  Input,
  matchesKey,
  type OverlayHandle,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from "@opsyhq/tui";
import type { KeybindingsManager } from "../../../keybindings-manager.ts";
import { type AppView, BIRTH_OPENER, type ViewContext } from "../app.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { ExtensionInputComponent } from "./components/extension-input.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import { ThinkingSelectorComponent } from "./components/thinking-selector.ts";

export class DashboardView extends Container implements AppView {
  private ctx!: ViewContext;
  private readonly keybindings: KeybindingsManager;
  private readonly headerContainer = new Container();
  private readonly bodyContainer = new Container();
  private readonly editorContainer = new Container();
  private readonly statusContainer = new Container();
  private readonly footerContainer = new Container();
  private editor!: CustomEditor;
  private list?: SelectList;
  private overlay?: OverlayHandle;
  // The global credential tier + a registry over it; the auth/model commands read and persist here.
  private auth!: AuthStorage;
  private registry!: ModelRegistry;

  constructor(keybindings: KeybindingsManager) {
    super();
    this.keybindings = keybindings;
  }

  onMount(ctx: ViewContext): void {
    this.ctx = ctx;
    this.auth = AuthStorage.create();
    this.registry = ModelRegistry.create(this.auth);

    // Focus the bar by hand (the view is the focus target). Bare-command mode (prefix "") lets the
    // editor's own autocomplete drive the menu without a leading slash.
    this.editor = new CustomEditor(ctx.tui, getEditorTheme(), this.keybindings, {
      paddingX: 1,
      commandMenuPrefix: "",
    });
    this.editor.focused = true;
    this.editor.setAutocompleteProvider(new HomeCommandProvider());
    this.editor.onEscape = () => this.editor.setText("");
    this.editor.onChange = () => {
      this.statusContainer.clear();
      this.renderFooter();
    };
    this.editor.onSubmit = (text) => this.runCommand(text);

    // Mounted for invalidation only; render() composes them with a bottom-pinning filler.
    this.addChild(this.headerContainer);
    this.addChild(this.bodyContainer);
    this.addChild(this.editorContainer);
    this.addChild(this.statusContainer);
    this.addChild(this.footerContainer);
    this.editorContainer.addChild(this.editor);

    this.renderHeader();
    this.renderBody();
    this.renderFooter();
  }

  /** Empty bar: the arrows browse the agent list. Otherwise the bar owns input and drives the menu. */
  private isBrowsing(): boolean {
    return this.editor.getText().trim() === "";
  }

  private renderHeader(): void {
    this.headerContainer.clear();
    this.headerContainer.addChild(new Text(theme.bold("Agents"), 1, 0));
  }

  private renderBody(): void {
    this.bodyContainer.clear();
    const agents = this.ctx.steward.list();
    if (agents.length === 0) {
      this.list = undefined;
      this.bodyContainer.addChild(
        new Text(theme.fg("dim", "No agents yet — type new to create your first one."), 1, 0),
      );
      return;
    }
    const items: SelectItem[] = agents.map((agent) => ({
      value: agent.name,
      label: `${isDeployed(agent.config) ? theme.fg("success", "●") : theme.fg("dim", "○")} ${agent.name}`,
      description: agent.config.purpose.trim().replace(/\s+/g, " "),
    }));
    this.list = new SelectList(items, 12, getSelectListTheme());
    this.list.onSelect = (item) => void this.ctx.navigate({ to: "chat", name: item.value });
    this.bodyContainer.addChild(this.list);
  }

  private renderFooter(): void {
    this.footerContainer.clear();
    const hints = this.isBrowsing()
      ? [
          rawKeyHint("↑/↓", "browse"),
          rawKeyHint("enter", "chat"),
          rawKeyHint("tab", "details"),
          rawKeyHint("type", "to search commands"),
          rawKeyHint("ctrl+c", "quit"),
        ]
      : [rawKeyHint("↑/↓", "select"), rawKeyHint("tab", "complete"), rawKeyHint("enter", "run"), rawKeyHint("esc", "clear")];
    this.footerContainer.addChild(new Text(hints.join(theme.fg("muted", " · ")), 1, 0));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.ctx.quit();
      return;
    }
    if (this.isBrowsing()) {
      // Moving on from command feedback — drop any stale error.
      this.statusContainer.clear();
      if (matchesKey(data, "tab") || matchesKey(data, "right")) {
        const selected = this.list?.getSelectedItem();
        if (selected) void this.ctx.navigate({ to: "agent", name: selected.value });
        return;
      }
      if (this.list && (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "enter"))) {
        this.list.handleInput(data);
        return;
      }
      this.editor.handleInput(data);
      return;
    }
    // Command mode: the editor owns the menu, Tab, typing, and Enter (completes + runs in one press).
    this.editor.handleInput(data);
  }

  /** Dispatch the submitted command (/name, or raw text the user never completed). */
  private runCommand(text: string): void {
    const name = text.trim().replace(/^\//, "");
    if (name === "") return;
    if (name === "new") this.openCreate();
    else if (name === "quit") this.ctx.quit();
    else if (name === "model") this.showModelSelector();
    else if (name === "thinking") this.showThinkingSelector();
    else if (name === "login") this.handleLoginCommand();
    else if (name === "logout") this.handleLogoutCommand();
    else this.showStatus(theme.fg("warning", `Unknown command: ${name}`));
  }

  private showStatus(line: string): void {
    this.statusContainer.clear();
    this.statusContainer.addChild(new Text(line, 1, 0));
    this.ctx.tui.requestRender();
  }

  private openCreate(): void {
    // Drop the bar cursor while the overlay owns input, else a stray marker lands behind it.
    this.editor.focused = false;
    const create = new CreateAgent({
      create: (name) => this.ctx.steward.create(name),
      onCreated: (agent) => {
        this.overlay?.hide();
        void this.ctx.navigate({ to: "chat", name: agent.name, initialAssistantMessage: BIRTH_OPENER });
      },
      onCancel: () => {
        this.overlay?.hide();
        this.editor.focused = true;
      },
      onQuit: () => this.ctx.quit(),
    });
    this.overlay = this.ctx.tui.showOverlay(create, { anchor: "center", width: "50%", minWidth: 40, maxHeight: "60%" });
  }

  /** Swap the bar for a selector; `done` restores the bar and hands focus back to the view. */
  private showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
    const done = () => {
      this.editorContainer.clear();
      this.editorContainer.addChild(this.editor);
      this.ctx.tui.setFocus(this);
      this.ctx.tui.requestRender();
    };
    const { component, focus } = create(done);
    this.editorContainer.clear();
    this.editorContainer.addChild(component);
    this.ctx.tui.setFocus(focus);
    this.ctx.tui.requestRender();
  }

  /** Text dialog (API key + OAuth prompts), resolving on submit or cancel. */
  private showExtensionInput(title: string, placeholder?: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const done = (value?: string) => {
        this.editorContainer.clear();
        this.editorContainer.addChild(this.editor);
        this.ctx.tui.setFocus(this);
        this.ctx.tui.requestRender();
        resolve(value);
      };
      const input = new ExtensionInputComponent(title, placeholder, done, () => done(), { tui: this.ctx.tui });
      this.editorContainer.clear();
      this.editorContainer.addChild(input);
      this.ctx.tui.setFocus(input);
      this.ctx.tui.requestRender();
    });
  }

  /** Pick-one dialog used by OAuth `onSelect`. */
  private showExtensionSelector(title: string, options: string[]): Promise<string | undefined> {
    return new Promise((resolve) => {
      const done = (value?: string) => {
        this.editorContainer.clear();
        this.editorContainer.addChild(this.editor);
        this.ctx.tui.setFocus(this);
        this.ctx.tui.requestRender();
        resolve(value);
      };
      const selector = new ExtensionSelectorComponent(title, options, done, () => done(), { tui: this.ctx.tui });
      this.editorContainer.clear();
      this.editorContainer.addChild(selector);
      this.ctx.tui.setFocus(selector);
      this.ctx.tui.requestRender();
    });
  }

  /** The saved default model resolved against `available` (preselection + thinking levels). */
  private defaultModel(available: Model<Api>[]): Model<Api> | undefined {
    const id = getDefaultModel();
    if (!id) return undefined;
    const provider = getDefaultProvider();
    return findExactModelReferenceMatch(provider ? `${provider}/${id}` : id, available);
  }

  /** `/model` — set the default model agents inherit. */
  private showModelSelector(initialSearchInput?: string): void {
    const available = this.registry.getAvailable();
    if (available.length === 0) {
      this.showStatus("No models available — use /login to add a provider.");
      return;
    }
    this.showSelector((done) => {
      const selector = new ModelSelectorComponent(
        this.ctx.tui,
        this.defaultModel(available),
        available,
        [],
        (model) => {
          setSharedDefaultModel(model.provider, model.id);
          done();
          this.showStatus(`Default model: ${model.provider}/${model.id}`);
        },
        done,
        initialSearchInput,
      );
      return { component: selector, focus: selector };
    });
  }

  /** `/thinking` — set the default thinking level. */
  private showThinkingSelector(): void {
    const model = this.defaultModel(this.registry.getAvailable());
    const levels = (model ? getSupportedThinkingLevels(model) : THINKING_LEVELS) as ThinkingLevel[];
    const current = (getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL) as ThinkingLevel;
    this.showSelector((done) => {
      const selector = new ThinkingSelectorComponent(
        current,
        levels,
        (level) => {
          setSharedDefaultThinkingLevel(level);
          done();
          this.showStatus(`Default thinking level: ${level}`);
        },
        done,
      );
      return { component: selector, focus: selector.getSelectList() };
    });
  }

  /** `/login` — pick an auth method, then a provider. */
  private handleLoginCommand(): void {
    this.showSelector((done) => {
      const selector = new ExtensionSelectorComponent(
        "Select authentication method:",
        ["Use a subscription", "Use an API key"],
        (option) => {
          done();
          this.showLoginProviderSelector(option === "Use a subscription" ? "oauth" : "api_key");
        },
        done,
      );
      return { component: selector, focus: selector };
    });
  }

  private showLoginProviderSelector(authType: "oauth" | "api_key"): void {
    const oauthIds = new Set(this.auth.getOAuthProviders().map((p) => p.id));
    const providers = (
      authType === "oauth"
        ? this.auth.getOAuthProviders().map((p) => ({ id: p.id, name: p.name }))
        : [...new Set(this.registry.getAll().map((m) => m.provider))]
            .filter((id) => isApiKeyLoginProvider(id, oauthIds))
            .map((id) => ({ id, name: this.registry.getProviderDisplayName(id) }))
    ).sort((a, b) => a.name.localeCompare(b.name));
    if (providers.length === 0) {
      this.showStatus(authType === "oauth" ? "No subscription providers available." : "No API key providers available.");
      return;
    }
    this.showSelector((done) => {
      const selector = new ExtensionSelectorComponent(
        "Select a provider:",
        providers.map((p) => p.name),
        async (label) => {
          done();
          const provider = providers.find((p) => p.name === label);
          if (!provider) return;
          try {
            await this.login(provider.id, authType, provider.name);
            this.showStatus(`Logged in to ${provider.name}.`);
          } catch (error) {
            this.showStatus(theme.fg("warning", error instanceof Error ? error.message : String(error)));
          }
        },
        done,
      );
      return { component: selector, focus: selector };
    });
  }

  /** Run the login in-process against the global tier — the dashboard's `session.login`. */
  private async login(provider: string, authType: "oauth" | "api_key", name: string): Promise<void> {
    if (authType === "oauth") {
      await this.auth.login(provider, {
        onAuth: (info) => {
          openBrowser(info.url);
          this.showStatus(info.instructions ? `${info.url}\n${info.instructions}` : info.url);
        },
        onDeviceCode: (info) => this.showStatus(`Enter code ${info.userCode} at ${info.verificationUri}`),
        onPrompt: async (prompt) => (await this.showExtensionInput(prompt.message, prompt.placeholder)) ?? "",
        onProgress: (message) => this.showStatus(message),
        onSelect: async (prompt) => {
          const label = await this.showExtensionSelector(
            prompt.message,
            prompt.options.map((o) => o.label),
          );
          return prompt.options.find((o) => o.label === label)?.id;
        },
      });
    } else {
      const key = (await this.showExtensionInput(`Enter API key for ${name}`))?.trim();
      if (!key) throw new Error("API key cannot be empty.");
      this.auth.set(provider, { type: "api_key", key });
    }
    this.registry.refresh();
  }

  /** `/logout` — remove a stored provider credential. */
  private handleLogoutCommand(): void {
    const providers = this.auth
      .list()
      .filter((id) => this.auth.get(id))
      .map((id) => ({ id, name: this.registry.getProviderDisplayName(id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (providers.length === 0) {
      this.showStatus("No stored credentials to remove.");
      return;
    }
    this.showSelector((done) => {
      const selector = new ExtensionSelectorComponent(
        "Log out of which provider?",
        providers.map((p) => p.name),
        (label) => {
          done();
          const provider = providers.find((p) => p.name === label);
          if (!provider) return;
          this.auth.logout(provider.id);
          this.registry.refresh();
          this.showStatus(`Logged out of ${provider.name}.`);
        },
        done,
      );
      return { component: selector, focus: selector };
    });
  }

  /** List at the top; bar + status + footer pinned to the bottom, a filler between. The menu renders
   * inside editorContainer, growing upward into the filler. */
  render(width: number): string[] {
    const header = this.headerContainer.render(width);
    const body = this.bodyContainer.render(width);
    const bar = this.editorContainer.render(width);
    const status = this.statusContainer.render(width);
    const footer = this.footerContainer.render(width);
    // +1 for a blank line of breathing room under the header.
    const used = header.length + 1 + body.length + bar.length + status.length + footer.length;
    const rows = this.ctx?.tui.terminal.rows ?? used + 1;
    const filler = new Array(Math.max(0, rows - used)).fill("");
    return [...header, "", ...body, ...filler, ...bar, ...status, ...footer];
  }

  focusTarget(): Component {
    return this;
  }

  onUnmount(): void {
    this.overlay?.hide();
  }
}

/**
 * Feeds the bar: fuzzy-filters HOME_SLASH_COMMANDS against the whole line and completes to "/name "
 * so onSubmit dispatches it like a chat slash command. Null on an empty bar keeps the menu closed.
 */
class HomeCommandProvider implements AutocompleteProvider {
  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): Promise<AutocompleteSuggestions | null> {
    const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
    if (before.trim() === "") return null;
    const query = before.trimStart().replace(/^\//, "");
    const matches = fuzzyFilter([...HOME_SLASH_COMMANDS], query, (command) => command.name);
    if (matches.length === 0) return null;
    return {
      items: matches.map((command) => ({
        value: command.name,
        label: command.name,
        description: command.description,
      })),
      prefix: before,
    };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const currentLine = lines[cursorLine] ?? "";
    const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
    const afterCursor = currentLine.slice(cursorCol);
    const newLines = [...lines];
    newLines[cursorLine] = `${beforePrefix}/${item.value} ${afterCursor}`;
    return { lines: newLines, cursorLine, cursorCol: beforePrefix.length + item.value.length + 2 };
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
    this.box.addChild(new Text(theme.fg("dim", "What would you like to name the agent?"), 1, 0));
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

