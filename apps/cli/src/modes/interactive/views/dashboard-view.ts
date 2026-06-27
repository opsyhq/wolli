/**
 * Dashboard: arrows browse the agent list; typing drives the command menu (new/help/quit). The bar
 * runs the editor's own autocomplete in bare-command mode — any letter opens the menu, Tab completes
 * to /command, a single Enter runs it, unknown input errors.
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
    else if (name === "help") this.openHelp();
    else if (name === "quit") this.ctx.quit();
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
