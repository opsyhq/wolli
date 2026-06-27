/**
 * Dashboard: an agent list you browse with the arrows, plus a persistent command bar. Typing `/`
 * opens the fuzzy command menu; Enter runs the selected command (`/new`, `/delete`, `/help`,
 * `/quit`). This mirrors the chat screen's slash-command machinery — the same `CustomEditor` +
 * `CombinedAutocompleteProvider` + a `handleSubmit` if-chain kept in lockstep with
 * `HOME_SLASH_COMMANDS`.
 */

import {
  type Agent,
  getEditorTheme,
  getSelectListTheme,
  HOME_SLASH_COMMANDS,
  isDeployed,
  rawKeyHint,
  theme,
} from "@opsyhq/steward";
import {
  Box,
  CombinedAutocompleteProvider,
  type Component,
  Container,
  type Focusable,
  Input,
  matchesKey,
  type OverlayHandle,
  type SelectItem,
  SelectList,
  type SlashCommand,
  Spacer,
  Text,
} from "@opsyhq/tui";
import type { KeybindingsManager } from "../../../keybindings-manager.ts";
import { type AppView, BIRTH_OPENER, type ViewContext } from "../app.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { DeleteConfirm } from "./components/delete-confirm.ts";

export class DashboardView extends Container implements AppView {
  private ctx!: ViewContext;
  private readonly keybindings: KeybindingsManager;
  private readonly headerContainer = new Container();
  private readonly bodyContainer = new Container();
  private readonly editorContainer = new Container();
  private readonly footerContainer = new Container();
  private editor!: CustomEditor;
  private list?: SelectList;
  private overlay?: OverlayHandle;

  constructor(keybindings: KeybindingsManager) {
    super();
    this.keybindings = keybindings;
  }

  onMount(ctx: ViewContext): void {
    this.ctx = ctx;

    // The persistent command bar mirrors chat (`chat-view.ts`): the same CustomEditor, focused so
    // its cursor renders even though the view (not the editor) is the TUI focus target.
    this.editor = new CustomEditor(ctx.tui, getEditorTheme(), this.keybindings, { paddingX: 1 });
    this.editor.focused = true;
    this.editor.onSubmit = (text) => this.handleSubmit(text);
    this.editor.onEscape = () => this.editor.setText("");
    this.editor.onChange = () => this.renderFooter();
    this.setupAutocompleteProvider();

    this.addChild(this.headerContainer);
    this.addChild(new Spacer(1));
    this.addChild(this.bodyContainer);
    this.addChild(new Spacer(1));
    this.addChild(this.editorContainer);
    this.addChild(this.footerContainer);
    this.editorContainer.addChild(this.editor);

    this.renderHeader();
    this.renderBody();
    this.renderFooter();
  }

  /**
   * Build the slash-command autocomplete from `HOME_SLASH_COMMANDS`, mirroring chat's
   * `createBaseAutocompleteProvider`. No session here, so there are no dynamic commands and no `fd`
   * (fuzzy `@`-file search stays dormant); slash-command filtering uses the provider's fuzzy filter.
   */
  private setupAutocompleteProvider(): void {
    const commands: SlashCommand[] = HOME_SLASH_COMMANDS.map((command) => ({
      name: command.name,
      description: command.description,
    }));
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, process.cwd(), null));
  }

  /** Empty bar with no command dropdown: arrows browse the agent list. Otherwise the editor owns input. */
  private isBrowsing(): boolean {
    return this.editor.getText() === "" && !this.editor.isShowingAutocomplete();
  }

  private renderHeader(): void {
    this.headerContainer.clear();
    this.headerContainer.addChild(new Text(theme.bold("Agents"), 1, 0));
    const agents = this.ctx.steward.list();
    if (agents.length === 0) return;
    const deployed = agents.filter((agent) => isDeployed(agent.config)).length;
    this.headerContainer.addChild(
      new Text(theme.fg("dim", `${agents.length} ${agents.length === 1 ? "agent" : "agents"} · ${deployed} deployed`), 1, 0),
    );
  }

  private renderBody(): void {
    this.bodyContainer.clear();
    const agents = this.ctx.steward.list();
    if (agents.length === 0) {
      this.list = undefined;
      this.bodyContainer.addChild(
        new Text(theme.fg("dim", "No agents yet — type /new to create your first one."), 1, 0),
      );
      return;
    }
    const items: SelectItem[] = agents.map((agent) => ({
      value: agent.name,
      // Lead with a deployment badge, reusing the ●/○ glyphs from the agent detail view.
      label: `${isDeployed(agent.config) ? theme.fg("success", "●") : theme.fg("dim", "○")} ${agent.name}`,
      description: agent.config.purpose.trim().replace(/\s+/g, " "),
    }));
    this.list = new SelectList(items, 12, getSelectListTheme());
    this.list.onSelect = (item) => void this.ctx.navigate({ to: "chat", name: item.value });
    this.bodyContainer.addChild(this.list);
  }

  /** Mode-aware key legend: browse hints when the bar is empty, dropdown hints once typing. */
  private renderFooter(): void {
    this.footerContainer.clear();
    const hints = this.isBrowsing()
      ? [
          rawKeyHint("↑/↓", "browse"),
          rawKeyHint("enter", "chat"),
          rawKeyHint("tab", "details"),
          rawKeyHint("/", "commands"),
          rawKeyHint("ctrl+c", "quit"),
        ]
      : [rawKeyHint("↑/↓", "select"), rawKeyHint("enter", "run"), rawKeyHint("esc", "cancel")];
    this.footerContainer.addChild(new Text(hints.join(theme.fg("muted", " · ")), 1, 0));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.ctx.quit();
      return;
    }
    // Browsing: arrows move the agent list, enter opens its chat, tab/→ opens details. Any other
    // key (letters, `/`) falls through to the editor — typing starts; `/` opens the command menu.
    if (this.isBrowsing()) {
      if (matchesKey(data, "tab") || matchesKey(data, "right")) {
        const selected = this.list?.getSelectedItem();
        if (selected) void this.ctx.navigate({ to: "agent", name: selected.value });
        return;
      }
      if (this.list && (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "enter"))) {
        this.list.handleInput(data);
        return;
      }
    }
    // Command mode (or a fall-through key): the editor owns input, so its autocomplete dropdown's
    // up/down/enter/tab/esc behave exactly as in chat.
    this.editor.handleInput(data);
  }

  /**
   * Dispatch a submitted command, mirroring chat's `handleSubmit` if-chain. Kept in lockstep with
   * `HOME_SLASH_COMMANDS`. There is no prompt target on the dashboard, so unknown input just clears.
   */
  private handleSubmit(text: string): void {
    const trimmed = text.trim();
    // Clear the bar up front: every branch (and unknown input) clears it, and there is no
    // empty-guard or argument-carrying command to keep the text around for, unlike chat.
    this.editor.setText("");
    if (trimmed === "/new") {
      this.openCreate();
      return;
    }
    if (trimmed === "/delete") {
      this.openDelete();
      return;
    }
    if (trimmed === "/help") {
      this.openHelp();
      return;
    }
    if (trimmed === "/quit") {
      this.ctx.quit();
      return;
    }
  }

  private openCreate(): void {
    // Drop the bar's cursor while the overlay owns input, else both emit a marker and the TUI's
    // bottom-most one wrongly lands in the bar behind the overlay. Restored on every close path.
    this.editor.focused = false;
    const create = new CreateAgent({
      create: (name) => this.ctx.steward.create(name),
      onCreated: (agent) => {
        this.overlay?.hide();
        void this.ctx.navigate({
          to: "chat",
          name: agent.name,
          initialAssistantMessage: BIRTH_OPENER,
        });
      },
      onCancel: () => {
        this.overlay?.hide();
        this.editor.focused = true;
      },
      onQuit: () => this.ctx.quit(),
    });
    this.overlay = this.ctx.tui.showOverlay(create, {
      anchor: "center",
      width: "50%",
      minWidth: 40,
      maxHeight: "60%",
    });
  }

  private openDelete(): void {
    const selected = this.list?.getSelectedItem();
    if (!selected) return;
    const agent = this.ctx.steward.get(selected.value);
    if (!agent) return;

    this.editor.focused = false;
    const confirm = new DeleteConfirm(agent, {
      onCancel: () => {
        this.overlay?.hide();
        this.editor.focused = true;
      },
      onDeleted: () => {
        this.overlay?.hide();
        this.editor.focused = true;
        // Re-render counts + list; deleting the last agent drops to the empty state.
        this.renderHeader();
        this.renderBody();
        this.renderFooter();
        this.ctx.tui.requestRender();
      },
      onQuit: () => this.ctx.quit(),
    });
    this.overlay = this.ctx.tui.showOverlay(confirm, {
      anchor: "center",
      width: "50%",
      minWidth: 40,
      maxHeight: "60%",
    });
  }

  private openHelp(): void {
    this.editor.focused = false;
    const help = new Help({
      onClose: () => {
        this.overlay?.hide();
        this.editor.focused = true;
      },
      onQuit: () => this.ctx.quit(),
    });
    this.overlay = this.ctx.tui.showOverlay(help, {
      anchor: "center",
      width: "50%",
      minWidth: 40,
      maxHeight: "60%",
    });
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
    this.box.addChild(
      new Text(theme.fg("dim", "What would you like to name the agent?"), 1, 0),
    );
    this.box.addChild(this.input);
    this.box.addChild(this.status);
    this.box.addChild(new Spacer(1));
    this.box.addChild(
      new Text(theme.fg("dim", "enter create · esc cancel"), 1, 0),
    );
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
      this.status.setText(
        theme.fg(
          "warning",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  render(width: number): string[] {
    return this.box.render(width);
  }

  invalidate(): void {
    this.box.invalidate();
  }
}

interface HelpCallbacks {
  onClose: () => void;
  onQuit: () => void;
}

// Command reference modal; dashboard-only, co-located with CreateAgent above.
class Help implements Component, Focusable {
  private readonly callbacks: HelpCallbacks;
  private readonly box = new Box(2, 1, (t) => theme.bg("selectedBg", t));
  public focused = false;

  constructor(callbacks: HelpCallbacks) {
    this.callbacks = callbacks;
    this.box.addChild(new Text(theme.fg("accent", "Commands"), 1, 0));
    for (const command of HOME_SLASH_COMMANDS) {
      this.box.addChild(
        new Text(`${theme.fg("accent", `/${command.name}`)}  ${theme.fg("dim", command.description)}`, 1, 0),
      );
    }
    this.box.addChild(new Spacer(1));
    this.box.addChild(new Text(theme.fg("dim", "↑/↓ browse · enter chat · tab details"), 1, 0));
    this.box.addChild(new Spacer(1));
    this.box.addChild(new Text(theme.fg("dim", "esc close"), 1, 0));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.callbacks.onQuit();
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
      this.callbacks.onClose();
      return;
    }
  }

  render(width: number): string[] {
    return this.box.render(width);
  }

  invalidate(): void {
    this.box.invalidate();
  }
}
