/**
 * Provider auth selector: a single flat, searchable list where each row is a concrete
 * (provider, auth method) option with a live status indicator (configured / env / unconfigured).
 *
 * Ported from the coding-agent's OAuthSelectorComponent so onboarding mirrors that flow rather than
 * the dashboard's method-first command bar. Reuses steward's shared primitives (AuthStorage,
 * DynamicBorder, theme) — nothing is imported from the coding-agent package.
 */

import { type AuthStatus, AuthStorage, DynamicBorder, theme } from "@opsyhq/steward";
import { Container, type Focusable, fuzzyFilter, getKeybindings, Input, Spacer, TruncatedText } from "@opsyhq/tui";

export type AuthSelectorProvider = {
	id: string;
	name: string;
	authType: "oauth" | "api_key";
};

/** Renders an auth provider selector: one flat searchable list, each row a (provider, authType). */
export class OAuthSelectorComponent extends Container implements Focusable {
	private searchInput: Input;

	// Focusable implementation - propagate to search input for IME cursor positioning.
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private listContainer: Container;
	private allProviders: AuthSelectorProvider[];
	private filteredProviders: AuthSelectorProvider[];
	private selectedIndex = 0;
	private mode: "login" | "logout";
	private authStorage: AuthStorage;
	private getAuthStatus: (providerId: string) => AuthStatus;
	private onSelectCallback: (providerId: string) => void;
	private onCancelCallback: () => void;

	constructor(
		mode: "login" | "logout",
		authStorage: AuthStorage,
		providers: AuthSelectorProvider[],
		onSelect: (providerId: string) => void,
		onCancel: () => void,
		getAuthStatus?: (providerId: string) => AuthStatus,
	) {
		super();

		this.mode = mode;
		this.authStorage = authStorage;
		this.getAuthStatus = getAuthStatus ?? ((providerId) => this.authStorage.getAuthStatus(providerId));
		this.allProviders = providers;
		this.filteredProviders = providers;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		const title = mode === "login" ? "Select provider to configure:" : "Select provider to logout:";
		this.addChild(new TruncatedText(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		this.searchInput.onSubmit = () => {
			const selectedProvider = this.filteredProviders[this.selectedIndex];
			if (selectedProvider) {
				this.onSelectCallback(selectedProvider.id);
			}
		};
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.filterProviders("");
	}

	private filterProviders(query: string): void {
		this.filteredProviders = query
			? fuzzyFilter(this.allProviders, query, (provider) => `${provider.name} ${provider.id} ${provider.authType}`)
			: this.allProviders;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.filteredProviders.length - 1)));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		const maxVisible = 8;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredProviders.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredProviders.length);

		for (let i = startIndex; i < endIndex; i++) {
			const provider = this.filteredProviders[i];
			if (!provider) continue;

			const isSelected = i === this.selectedIndex;
			const statusIndicator = this.formatStatusIndicator(provider);
			const line = isSelected
				? theme.fg("accent", "→ ") + theme.fg("accent", provider.name) + statusIndicator
				: `  ${theme.fg("text", provider.name)}${statusIndicator}`;
			this.listContainer.addChild(new TruncatedText(line, 1, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredProviders.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredProviders.length})`);
			this.listContainer.addChild(new TruncatedText(scrollInfo, 1, 0));
		}

		if (this.filteredProviders.length === 0) {
			const message =
				this.allProviders.length === 0
					? this.mode === "login"
						? "No providers available"
						: "No providers logged in. Use /login first."
					: "No matching providers";
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", `  ${message}`), 1, 0));
		}
	}

	private formatStatusIndicator(provider: AuthSelectorProvider): string {
		const credential = this.authStorage.get(provider.id);
		if (credential?.type === provider.authType) return theme.fg("success", " ✓ configured");
		if (credential) {
			const label = credential.type === "oauth" ? "subscription configured" : "API key configured";
			return theme.fg("muted", " • ") + theme.fg("warning", label);
		}
		if (provider.authType !== "api_key") return theme.fg("muted", " • unconfigured");

		const status = this.getAuthStatus(provider.id);
		switch (status.source) {
			case "environment":
				return theme.fg("success", ` ✓ env: ${status.label ?? "API key"}`);
			case "runtime":
				return theme.fg("success", " ✓ runtime API key");
			case "fallback":
				return theme.fg("success", " ✓ custom API key");
			case "models_json_key":
				return theme.fg("success", " ✓ key in models.json");
			case "models_json_command":
				return theme.fg("success", " ✓ command in models.json");
			default:
				return theme.fg("muted", " • unconfigured");
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredProviders.length === 0) return;
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredProviders.length === 0) return;
			this.selectedIndex = Math.min(this.filteredProviders.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedProvider = this.filteredProviders[this.selectedIndex];
			if (selectedProvider) {
				this.onSelectCallback(selectedProvider.id);
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		} else {
			this.searchInput.handleInput(keyData);
			this.filterProviders(this.searchInput.getValue());
		}
	}
}
