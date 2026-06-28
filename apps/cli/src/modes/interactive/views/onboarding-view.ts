/**
 * Guided first-run: a fresh machine with no configured provider lands here instead of the dashboard.
 * It walks the human through connecting a model provider (one flat list of provider + auth-method
 * options with live status), runs the login in a cohesive dialog, auto-picks a default model, then
 * drops into the dashboard. Esc/Ctrl+C steps back, or skips out from the welcome screen.
 *
 * The provider list and login dialog are the shared OAuthSelectorComponent / LoginDialogComponent,
 * driven here against the global credential tier + a registry over it (`wolli.auth` / `wolli.registry`).
 */

import type { Api, Model, OAuthSelectPrompt } from "@earendil-works/pi-ai";
import {
  APP_NAME,
  type AuthSelectorProvider,
  defaultModelPerProvider,
  findExactModelReferenceMatch,
  getDefaultModel,
  getDefaultProvider,
  isApiKeyLoginProvider,
  LoginDialogComponent,
  OAuthSelectorComponent,
  rawKeyHint,
  setSharedDefaultModel,
  theme,
  VERSION,
} from "@opsyhq/wolli";
import { type Component, Container, Text } from "@opsyhq/tui";
import type { AppView, ViewContext } from "../app.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";

export class OnboardingView extends Container implements AppView {
  private ctx!: ViewContext;
  private readonly headerContainer = new Container();
  private readonly hostContainer = new Container();
  private readonly statusContainer = new Container();
  private readonly footerContainer = new Container();
  private active?: Component;

  /** The global credential tier + a registry over it, same ones the dashboard reads + writes through. */
  private get auth() {
    return this.ctx.wolli.auth;
  }
  private get registry() {
    return this.ctx.wolli.registry;
  }

  onMount(ctx: ViewContext): void {
    this.ctx = ctx;

    // Mounted for invalidation only; render() composes them with a bottom-pinning filler.
    this.addChild(this.headerContainer);
    this.addChild(this.hostContainer);
    this.addChild(this.statusContainer);
    this.addChild(this.footerContainer);

    this.renderHeader();
    this.renderFooter();
    this.showWelcome();
  }

  private renderHeader(): void {
    this.headerContainer.clear();
    this.headerContainer.addChild(
      new Text(theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${VERSION}`), 1, 0),
    );
  }

  private renderFooter(): void {
    this.footerContainer.clear();
    const hints = [rawKeyHint("↑/↓", "navigate"), rawKeyHint("enter", "select"), rawKeyHint("esc", "back")];
    this.footerContainer.addChild(new Text(hints.join(theme.fg("muted", " · ")), 1, 0));
  }

  /** Swap the hosted step component and hand it focus. */
  private setActive(component: Component): void {
    this.hostContainer.clear();
    this.hostContainer.addChild(component);
    this.active = component;
    this.ctx.tui.setFocus(component);
    this.ctx.tui.requestRender();
  }

  private showStatus(line: string): void {
    this.statusContainer.clear();
    this.statusContainer.addChild(new Text(line, 1, 0));
    this.ctx.tui.requestRender();
  }

  /** The saved default model resolved against `available`. */
  private defaultModel(available: Model<Api>[]): Model<Api> | undefined {
    const id = getDefaultModel();
    if (!id) return undefined;
    const provider = getDefaultProvider();
    return findExactModelReferenceMatch(provider ? `${provider}/${id}` : id, available);
  }

  /** Step 1: welcome. */
  private showWelcome(): void {
    const selector = new ExtensionSelectorComponent(
      `Welcome to ${APP_NAME}`,
      ["Get started", "Skip setup"],
      (option) => {
        if (option === "Get started") this.showLoginProviderSelector();
        else this.finish();
      },
      () => this.finish(),
    );
    this.setActive(selector);
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

  /** Step 2: pick a provider + auth method from one searchable list. */
  private showLoginProviderSelector(): void {
    const options = this.getLoginProviderOptions();
    if (options.length === 0) {
      this.showStatus("No providers available.");
      return;
    }
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
      () => this.showWelcome(),
    );
    this.setActive(selector);
  }

  /** Step 3a: subscription/OAuth login, driven through the login dialog. */
  private async showLoginDialog(providerId: string, providerName: string): Promise<void> {
    const dialog = new LoginDialogComponent(this.ctx.tui, providerId, () => {}, providerName);
    this.setActive(dialog);
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
      this.showModelStep();
    } catch (error) {
      // A user cancel aborts the dialog's signal; only surface real failures.
      if (!dialog.signal.aborted) {
        this.showStatus(theme.fg("warning", error instanceof Error ? error.message : String(error)));
      }
      this.showLoginProviderSelector();
    }
  }

  /** Step 3b: API-key login, prompting inside the login dialog. */
  private async showApiKeyLoginDialog(providerId: string, providerName: string): Promise<void> {
    const dialog = new LoginDialogComponent(this.ctx.tui, providerId, () => {}, providerName);
    this.setActive(dialog);
    try {
      const key = (await dialog.showPrompt(`Enter API key for ${providerName}:`)).trim();
      if (!key) throw new Error("API key cannot be empty.");
      this.auth.set(providerId, { type: "api_key", key });
      this.registry.refresh();
      this.showModelStep();
    } catch (error) {
      if (!dialog.signal.aborted) {
        this.showStatus(theme.fg("warning", error instanceof Error ? error.message : String(error)));
      }
      this.showLoginProviderSelector();
    }
  }

  /** An OAuth provider asked us to pick one of several options mid-login; swap to a selector and back. */
  private showOAuthLoginSelect(dialog: LoginDialogComponent, prompt: OAuthSelectPrompt): Promise<string | undefined> {
    return new Promise((resolve) => {
      const selector = new ExtensionSelectorComponent(
        prompt.message,
        prompt.options.map((o) => o.label),
        (label) => {
          this.setActive(dialog);
          resolve(prompt.options.find((o) => o.label === label)?.id);
        },
        () => {
          this.setActive(dialog);
          resolve(undefined);
        },
      );
      this.setActive(selector);
    });
  }

  /** Step 4: auto-pick a default model and confirm (with an optional override). */
  private showModelStep(): void {
    const available = this.registry.getAvailable();
    if (available.length === 0) {
      this.showStatus("No models available — choose another provider.");
      this.showLoginProviderSelector();
      return;
    }
    const existing = this.defaultModel(available);
    const preferred = available.find(
      (m) => defaultModelPerProvider[m.provider as keyof typeof defaultModelPerProvider] === m.id,
    );
    const chosen = existing ?? preferred ?? available[0];
    setSharedDefaultModel(chosen.provider, chosen.id);
    const selector = new ExtensionSelectorComponent(
      `Default model: ${chosen.provider}/${chosen.id}. Change anytime with /model.`,
      ["Open dashboard", "Pick a different model"],
      (option) => {
        if (option === "Pick a different model") this.showModelPicker();
        else this.finish();
      },
      () => this.finish(),
    );
    this.setActive(selector);
  }

  /** Optional override: pick a different default model. */
  private showModelPicker(): void {
    const available = this.registry.getAvailable();
    const selector = new ModelSelectorComponent(
      this.ctx.tui,
      this.defaultModel(available),
      available,
      [],
      (model) => {
        setSharedDefaultModel(model.provider, model.id);
        this.finish();
      },
      () => this.showModelStep(),
    );
    this.setActive(selector);
  }

  /** Done or skipped — re-enter the dashboard, which shares the same `wolli.auth`/`wolli.registry`. */
  private finish(): void {
    this.ctx.home();
  }

  /** Header at the top; status + footer pinned to the bottom, the active step floating between. */
  render(width: number): string[] {
    const header = this.headerContainer.render(width);
    const host = this.hostContainer.render(width);
    const status = this.statusContainer.render(width);
    const footer = this.footerContainer.render(width);
    // +1 for a blank line of breathing room under the header.
    const used = header.length + 1 + host.length + status.length + footer.length;
    const rows = this.ctx?.tui.terminal.rows ?? used + 1;
    const filler = new Array(Math.max(0, rows - used)).fill("");
    return [...header, "", ...host, ...filler, ...status, ...footer];
  }

  focusTarget(): Component {
    return this.active ?? this;
  }

  onUnmount(): void {}
}
