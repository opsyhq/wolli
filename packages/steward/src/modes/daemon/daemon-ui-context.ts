/**
 * The daemon's extension-UI context — the server half of the extension-UI round-trip.
 *
 * A near-verbatim port of pi rpc-mode's parked-promise machinery + `createExtensionUIContext`
 * (`coding-agent/src/modes/rpc/rpc-mode.ts:78-310`). Two seams change for the daemon:
 *   - the transport: pi writes `serializeJsonLine(obj)` to stdout; the daemon pushes `obj` as
 *     an SSE frame via the injected `output` sink (`pushFrame` in daemon-mode.ts);
 *   - the `theme` family: pi returns the live TUI theme; the daemon returns the same data-only
 *     / inert values as `noOpUIContext` (theme rendering is a client concern).
 *
 * The serializable-vs-stub split is dictated by serializability (a function/Component can't cross
 * JSON), not host capability, so it ports unchanged even though steward's client has a full TUI.
 */

import { randomUUID } from "node:crypto";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import type { ExtensionUIRequest, ExtensionUIResponse } from "./daemon-types.ts";

/** The daemon-side UI context plus the inbound/disconnect hooks the daemon route needs. */
export interface DaemonUIContext {
	/** Bound to the host via `bindInteractiveContext({ uiContext, mode: "rpc", ... })`. */
	context: ExtensionUIContext;
	/** Resolve the parked dialog promise for `response.id` (the `POST /ui-response` body). */
	resolveUiResponse(response: ExtensionUIResponse): void;
	/** Resolve every parked dialog to cancel (e.g. the last attach client dropped). */
	cancelAllPending(): void;
}

/**
 * Build the daemon's extension-UI context. `output` pushes a request frame to attach clients.
 *
 * `pendingExtensionRequests` is owned here (closure scope), so it survives harness swaps: the
 * host re-applies the SAME context object after every `build()`/`reload()`, so an in-flight
 * dialog parked before a swap can still be answered after it.
 */
export function createDaemonUIContext(output: (request: ExtensionUIRequest) => void): DaemonUIContext {
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (response: ExtensionUIResponse) => void; reject: (error: Error) => void }
	>();

	/** Park a promise for an awaited dialog with signal/timeout support (pi `rpc-mode.ts:90-130`). */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: ExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response: ExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			output({ type: "extension_ui_request", id, ...request } as ExtensionUIRequest);
		});
	}

	const context: ExtensionUIContext = {
		select: (title, options, opts) =>
			createDialogPromise<string | undefined>(
				opts,
				undefined,
				{ method: "select", title, options, timeout: opts?.timeout },
				(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
			),

		confirm: (title, message, opts) =>
			createDialogPromise<boolean>(
				opts,
				false,
				{ method: "confirm", title, message, timeout: opts?.timeout },
				(r) => ("cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false),
			),

		input: (title, placeholder, opts) =>
			createDialogPromise<string | undefined>(
				opts,
				undefined,
				{ method: "input", title, placeholder, timeout: opts?.timeout },
				(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget — no response needed.
			output({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, notifyType: type });
		},

		onTerminalInput(): () => void {
			// Raw terminal input is a client-only concern; the daemon has no terminal.
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			output({
				type: "extension_ui_request",
				id: randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			});
		},

		setWorkingMessage(_message?: string): void {
			// Requires TUI loader access — client-only.
		},

		setWorkingVisible(_visible: boolean): void {
			// Requires TUI loader access — client-only.
		},

		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
			// Requires TUI loader access — client-only.
		},

		setHiddenThinkingLabel(_label?: string): void {
			// Requires TUI message rendering — client-only.
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only string arrays cross the wire; component factories can't be serialized.
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					id: randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				});
			}
		},

		setFooter(_factory: unknown): void {
			// Custom footer is a component factory — can't serialize.
		},

		setHeader(_factory: unknown): void {
			// Custom header is a component factory — can't serialize.
		},

		setTitle(title: string): void {
			output({ type: "extension_ui_request", id: randomUUID(), method: "setTitle", title });
		},

		async custom() {
			// Custom components can't cross the wire.
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// No paste semantics over the wire — falls back to setEditorText.
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			output({ type: "extension_ui_request", id: randomUUID(), method: "setEditorText", text });
		},

		getEditorText(): string {
			// Synchronous read can't round-trip; the client tracks editor state locally.
			return "";
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			// Parked directly — `editor` has no signal/timeout in the extension API, so `cancelAllPending`
			// (last client gone) is its only escape from hanging forever.
			const id = randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response: ExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) resolve(undefined);
						else if ("value" in response) resolve(response.value);
						else resolve(undefined);
					},
					reject,
				});
				output({ type: "extension_ui_request", id, method: "editor", title, prefill });
			});
		},

		addAutocompleteProvider(): void {
			// Autocomplete composition is a client-only concern.
		},

		setEditorComponent(): void {
			// Custom editor components can't be serialized.
		},

		getEditorComponent() {
			return undefined;
		},

		// —— theme family: data-only / inert, matching noOpUIContext (keeps theme rendering client-side) ——
		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			return { success: false, error: "UI not available" };
		},

		getToolsExpanded() {
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion is client TUI state.
		},
	};

	/** Look up the parked promise for the response's `id`, delete it, resolve (pi `rpc-mode.ts:721-735`). */
	const resolveUiResponse = (response: ExtensionUIResponse): void => {
		const pending = pendingExtensionRequests.get(response.id);
		if (pending) {
			pendingExtensionRequests.delete(response.id);
			pending.resolve(response);
		}
	};

	/** Cancel every parked dialog. The wrapped resolvers map a `cancelled` response to each dialog's default. */
	const cancelAllPending = (): void => {
		for (const [id, pending] of [...pendingExtensionRequests]) {
			pending.resolve({ type: "extension_ui_response", id, cancelled: true });
		}
		pendingExtensionRequests.clear();
	};

	return { context, resolveUiResponse, cancelAllPending };
}
