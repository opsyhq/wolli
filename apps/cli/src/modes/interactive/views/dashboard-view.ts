/**
 * Dashboard: arrows browse the agent list; typing drives the command menu. The bar runs the editor's
 * own autocomplete in bare-command mode — any letter opens the menu, Tab completes to /command, a
 * single Enter runs it, unknown input errors.
 *
 * The `model`/`thinking`/`login`/`logout` commands mirror the in-session ones but run against the
 * global tier in-process, so each change persists the shared default that agents inherit.
 */

import { type Api, getSupportedThinkingLevels, type Model, type OAuthSelectPrompt } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@opsyhq/agent";
import {
  type Agent,
  type AuthSelectorProvider,
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
  LoginDialogComponent,
  OAuthSelectorComponent,
  rawKeyHint,
  setSharedDefaultModel,
  setSharedDefaultThinkingLevel,
  theme,
  THINKING_LEVELS,
} from "@opsyhq/wolli";
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

  constructor(keybindings: KeybindingsManager) {
    super();
    this.keybindings = keybindings;
  }

  /** The global credential tier + a registry over it; the auth/model commands read and persist here. */
  private get auth() {
    return this.ctx.wolli.auth;
  }
  private get registry() {
    return this.ctx.wolli.registry;
  }

  onMount(ctx: ViewContext): void {
    this.ctx = ctx;

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
    const agents = this.ctx.wolli.list();
    if (agents.length === 0) {
      this.list = undefined;
      this.bodyContainer.addChild(new Text(theme.fg("dim", "No agents yet."), 1, 0));
      this.bodyContainer.addChild(
        new Text(
          theme.fg("dim", "Type ") +
            theme.bold(theme.fg("accent", "new")) +
            theme.fg("dim", " to bring your first one to life."),
          1,
          0,
        ),
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
      create: (name) => this.ctx.wolli.create(name),
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

  /** Restore the command bar after a hosted login dialog finishes; mirrors `showSelector`'s done half. */
  private restoreEditor(): void {
    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.ctx.tui.setFocus(this);
    this.ctx.tui.requestRender();
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

  /** The flat (provider, auth method) list — oauth subscriptions plus api-key providers. */
  private getLoginProviderOptions(): AuthSelectorProvider[] {
    const oauthProviders = this.auth.getOAuthProviders();
    const oauthIds = new Set(oauthProviders.map((p) => p.id));
    const options: AuthSelectorProvider[] = oauthProviders.map((p) => ({ id: p.id, name: p.name, authType: "oauth" }));
    for (const providerId of new Set(this.registry.getAll().map((m) => m.provider))) {
      if (!isApiKeyLoginProvider(providerId, oauthIds)) continue;
      options.push({ id: providerId, name: this.registry.getProviderDisplayName(providerId), authType: "api_key" });
    }
    return options.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** `/login` — pick a provider + auth method from one searchable list, then run the login. */
  private handleLoginCommand(): void {
    const options = this.getLoginProviderOptions();
    if (options.length === 0) {
      this.showStatus("No providers available.");
      return;
    }
    this.showSelector((done) => {
      const selector = new OAuthSelectorComponent(
        "login",
        this.auth,
        options,
        (providerId) => {
          const option = options.find((o) => o.id === providerId);
          if (!option) return;
          if (option.authType === "oauth") void this.showLoginDialog(option.id, option.name);
          else void this.showApiKeyLoginDialog(option.id, option.name);
        },
        done,
      );
      return { component: selector, focus: selector };
    });
  }

  /** Subscription/OAuth login, in-process against the global tier, driven through the login dialog. */
  private async showLoginDialog(providerId: string, providerName: string): Promise<void> {
    const dialog = new LoginDialogComponent(this.ctx.tui, providerId, () => {}, providerName);
    this.editorContainer.clear();
    this.editorContainer.addChild(dialog);
    this.ctx.tui.setFocus(dialog);
    this.ctx.tui.requestRender();
    try {
      await this.auth.login(providerId, {
        onAuth: (info) => dialog.showAuth(info.url, info.instructions),
        onDeviceCode: (info) => dialog.showDeviceCode(info),
        onPrompt: (prompt) => dialog.showPrompt(prompt.message, prompt.placeholder),
        onProgress: (message) => dialog.showProgress(message),
        onManualCodeInput: () => dialog.showManualInput("Paste the redirect URL or code, or finish in your browser:"),
        onSelect: (prompt) => this.showOAuthLoginSelect(dialog, prompt),
        signal: dialog.signal,
      });
      this.registry.refresh();
      this.restoreEditor();
      this.showStatus(`Logged in to ${providerName}.`);
    } catch (error) {
      this.restoreEditor();
      // A user cancel aborts the dialog's signal; only surface real failures.
      if (!dialog.signal.aborted) {
        this.showStatus(theme.fg("warning", error instanceof Error ? error.message : String(error)));
      }
    }
  }

  /** API-key login, in-process against the global tier, prompting inside the login dialog. */
  private async showApiKeyLoginDialog(providerId: string, providerName: string): Promise<void> {
    const dialog = new LoginDialogComponent(this.ctx.tui, providerId, () => {}, providerName);
    this.editorContainer.clear();
    this.editorContainer.addChild(dialog);
    this.ctx.tui.setFocus(dialog);
    this.ctx.tui.requestRender();
    try {
      const key = (await dialog.showPrompt(`Enter API key for ${providerName}:`)).trim();
      if (!key) throw new Error("API key cannot be empty.");
      this.auth.set(providerId, { type: "api_key", key });
      this.registry.refresh();
      this.restoreEditor();
      this.showStatus(`Logged in to ${providerName}.`);
    } catch (error) {
      this.restoreEditor();
      if (!dialog.signal.aborted) {
        this.showStatus(theme.fg("warning", error instanceof Error ? error.message : String(error)));
      }
    }
  }

  /** An OAuth provider asked us to pick one of several options mid-login; swap to a selector and back. */
  private showOAuthLoginSelect(dialog: LoginDialogComponent, prompt: OAuthSelectPrompt): Promise<string | undefined> {
    return new Promise((resolve) => {
      const restoreDialog = () => {
        this.editorContainer.clear();
        this.editorContainer.addChild(dialog);
        this.ctx.tui.setFocus(dialog);
        this.ctx.tui.requestRender();
      };
      const selector = new ExtensionSelectorComponent(
        prompt.message,
        prompt.options.map((o) => o.label),
        (label) => {
          restoreDialog();
          resolve(prompt.options.find((o) => o.label === label)?.id);
        },
        () => {
          restoreDialog();
          resolve(undefined);
        },
      );
      this.editorContainer.clear();
      this.editorContainer.addChild(selector);
      this.ctx.tui.setFocus(selector);
      this.ctx.tui.requestRender();
    });
  }

  /** `/logout` — pick a provider with stored credentials from one list and remove it. */
  private handleLogoutCommand(): void {
    const options: AuthSelectorProvider[] = [];
    for (const id of this.auth.list()) {
      const credential = this.auth.get(id);
      if (!credential) continue;
      options.push({ id, name: this.registry.getProviderDisplayName(id), authType: credential.type });
    }
    options.sort((a, b) => a.name.localeCompare(b.name));
    if (options.length === 0) {
      this.showStatus("No stored credentials to remove.");
      return;
    }
    this.showSelector((done) => {
      const selector = new OAuthSelectorComponent(
        "logout",
        this.auth,
        options,
        (providerId) => {
          done();
          const option = options.find((o) => o.id === providerId);
          if (!option) return;
          this.auth.logout(option.id);
          this.registry.refresh();
          this.showStatus(`Logged out of ${option.name}.`);
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
    this.box.addChild(new Text(theme.fg("accent", "You're bringing a new agent to life."), 1, 0));
    this.box.addChild(new Text(theme.fg("dim", "What should we call it?"), 1, 0));
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

