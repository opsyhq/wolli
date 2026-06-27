/**
 * Dashboard: browse the agent list with the arrows, or type into the command bar to search the
 * command menu (new/delete/help/quit) and run one. Unknown input reports an error.
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
  private readonly menuContainer = new Container();
  private readonly statusContainer = new Container();
  private readonly footerContainer = new Container();
  private editor!: CustomEditor;
  private list?: SelectList;
  private commandMenu?: SelectList;
  private overlay?: OverlayHandle;

  constructor(keybindings: KeybindingsManager) {
    super();
    this.keybindings = keybindings;
  }

  onMount(ctx: ViewContext): void {
    this.ctx = ctx;

    // The view is the TUI focus target and multiplexes input, so focus the bar by hand to render its
    // cursor. The bar drives its own command menu (below) rather than the editor's slash autocomplete.
    this.editor = new CustomEditor(ctx.tui, getEditorTheme(), this.keybindings, { paddingX: 1 });
    this.editor.focused = true;
    this.editor.onEscape = () => this.editor.setText("");
    this.editor.onChange = (text) => this.updateCommandMenu(text);

    this.addChild(this.headerContainer);
    this.addChild(new Spacer(1));
    this.addChild(this.bodyContainer);
    this.addChild(new Spacer(1));
    this.addChild(this.editorContainer);
    this.addChild(this.menuContainer);
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

  /** Rebuild the command menu from the bar text (any substring, no slash needed) and clear any error. */
  private updateCommandMenu(text: string): void {
    this.statusContainer.clear();
    this.menuContainer.clear();
    const query = text.trim().replace(/^\//, "").toLowerCase();
    if (text.trim() === "") {
      this.commandMenu = undefined;
      this.renderFooter();
      return;
    }
    const matches = HOME_SLASH_COMMANDS.filter((command) => command.name.toLowerCase().includes(query));
    this.commandMenu = new SelectList(
      matches.map((command) => ({ value: command.name, label: command.name, description: command.description })),
      8,
      getSelectListTheme(),
    );
    this.menuContainer.addChild(this.commandMenu);
    this.renderFooter();
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
      : [rawKeyHint("↑/↓", "select"), rawKeyHint("enter", "run"), rawKeyHint("esc", "clear")];
    this.footerContainer.addChild(new Text(hints.join(theme.fg("muted", " · ")), 1, 0));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.ctx.quit();
      return;
    }
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
      this.editor.handleInput(data);
      return;
    }
    // Command mode: drive the menu. up/down move it, tab completes the highlighted command, enter runs
    // it. Reading the menu here (not via editor.onSubmit) avoids the editor's submit clearing it first.
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      this.commandMenu?.handleInput(data);
      return;
    }
    if (matchesKey(data, "tab")) {
      const selected = this.commandMenu?.getSelectedItem();
      if (selected) this.editor.setText(selected.value);
      return;
    }
    if (matchesKey(data, "enter")) {
      this.runCommand();
      return;
    }
    this.editor.handleInput(data);
  }

  /** Run the highlighted command, or report the bar text as an unknown command. */
  private runCommand(): void {
    const selected = this.commandMenu?.getSelectedItem();
    if (!selected) {
      this.showStatus(theme.fg("warning", `Unknown command: ${this.editor.getText().trim()}`));
      return;
    }
    this.editor.setText("");
    if (selected.value === "new") this.openCreate();
    else if (selected.value === "delete") this.openDelete();
    else if (selected.value === "help") this.openHelp();
    else if (selected.value === "quit") this.ctx.quit();
  }

  private showStatus(line: string): void {
    this.statusContainer.clear();
    this.statusContainer.addChild(new Text(line, 1, 0));
    this.ctx.tui.requestRender();
  }

  private openCreate(): void {
    // Drop the bar's cursor while the overlay owns input, else the TUI's bottom-most marker lands in
    // the bar behind it. Restored on every close path.
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
        this.renderHeader();
        this.renderBody();
        this.renderFooter();
        this.ctx.tui.requestRender();
      },
      onQuit: () => this.ctx.quit(),
    });
    this.overlay = this.ctx.tui.showOverlay(confirm, { anchor: "center", width: "50%", minWidth: 40, maxHeight: "60%" });
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
    this.overlay = this.ctx.tui.showOverlay(help, { anchor: "center", width: "50%", minWidth: 40, maxHeight: "60%" });
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
        new Text(`${theme.fg("accent", command.name)}  ${theme.fg("dim", command.description)}`, 1, 0),
      );
    }
    this.box.addChild(new Spacer(1));
    this.box.addChild(new Text(theme.fg("dim", "type a command to search · ↑/↓ select · enter run"), 1, 0));
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
