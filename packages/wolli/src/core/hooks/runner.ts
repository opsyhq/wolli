/**
 * Hook runner: dispatches the interception chains.
 *
 * Translated from ExtensionRunner (its successor once extensions are removed): the hooks bound
 * to a `before:` event form a chain that runs in load order, terminal decisions short-circuit,
 * and failures are fail-open onto the error sink so a thrown hook never breaks the turn. Unlike
 * the workflow engine, executions are deliberately unrecorded — hooks are inline interception,
 * not durable automation, so there is no journal, no run, no abort controller.
 */

import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@opsyhq/agent";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import type { DialogUI, InputSource, MessageEndEvent, WorkflowSession } from "../workflows/types.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderRequestEvent,
	ContextEvent,
	ContextEventResult,
	Hook,
	HookContext,
	HookError,
	HookErrorListener,
	HookEventMap,
	InputEvent,
	InputEventResult,
	MessageEndEventResult,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
} from "./types.ts";

/** Combined result from all before_agent_start hooks. */
interface BeforeAgentStartCombinedResult {
	messages?: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPrompt?: string;
}

export class HookRunner {
	/** `before:` event → hooks bound to it, in load order — the interception chain. */
	private readonly hooks = new Map<keyof HookEventMap, Hook[]>();
	private readonly errorListeners = new Set<HookErrorListener>();

	constructor(hooks: Hook[]) {
		for (const hook of hooks) {
			const bindings = this.hooks.get(hook.definition.before);
			if (bindings) bindings.push(hook);
			else this.hooks.set(hook.definition.before, [hook]);
		}
	}

	/** Whether any hook binds this `before:` event — lets the runtime skip building the event and dispatching. */
	hasHooks(event: string): boolean {
		return this.hooks.has(event as keyof HookEventMap);
	}

	onError(listener: HookErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	private emitError(error: HookError): void {
		for (const listener of this.errorListeners) {
			listener(error);
		}
	}

	/** Build the flat context handed to every hook from its producing session and dialog UI. */
	private createContext(session: WorkflowSession, ui: DialogUI): HookContext {
		return { session, ui };
	}

	/**
	 * The `tool_call` chain (translated from ExtensionRunner.emitToolCall): the SAME event
	 * object flows to every hook — `event.input` mutates in place, so a later hook sees
	 * earlier patches (today's documented contract). A `{ block }` result short-circuits;
	 * otherwise the last truthy result wins.
	 */
	async dispatchToolCall(
		event: ToolCallEvent,
		session: WorkflowSession,
		ui: DialogUI,
	): Promise<ToolCallEventResult | undefined> {
		const ctx = this.createContext(session, ui);
		let result: ToolCallEventResult | undefined;

		for (const hook of this.hooks.get("tool_call") ?? []) {
			try {
				const handlerResult = await hook.definition.run(event, ctx);

				if (handlerResult) {
					result = handlerResult as ToolCallEventResult;
					if (result.block) {
						return result;
					}
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				this.emitError({
					path: hook.path,
					event: "tool_call",
					error: message,
					stack,
				});
			}
		}

		return result;
	}

	/** The `tool_result` chain (translated from ExtensionRunner.emitToolResult): one working copy patched across hooks. */
	async dispatchToolResult(
		event: ToolResultEvent,
		session: WorkflowSession,
		ui: DialogUI,
	): Promise<ToolResultEventResult | undefined> {
		const ctx = this.createContext(session, ui);
		const currentEvent: ToolResultEvent = { ...event };
		let modified = false;

		for (const hook of this.hooks.get("tool_result") ?? []) {
			try {
				const handlerResult = (await hook.definition.run(currentEvent, ctx)) as ToolResultEventResult | undefined;
				if (!handlerResult) continue;

				if (handlerResult.content !== undefined) {
					currentEvent.content = handlerResult.content;
					modified = true;
				}
				if (handlerResult.details !== undefined) {
					currentEvent.details = handlerResult.details;
					modified = true;
				}
				if (handlerResult.isError !== undefined) {
					currentEvent.isError = handlerResult.isError;
					modified = true;
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				this.emitError({
					path: hook.path,
					event: "tool_result",
					error: message,
					stack,
				});
			}
		}

		if (!modified) {
			return undefined;
		}

		return {
			content: currentEvent.content,
			details: currentEvent.details,
			isError: currentEvent.isError,
		};
	}

	/** The `context` chain (translated from ExtensionRunner.emitContext): messages cloned once, replaced per hook. */
	async dispatchContext(messages: AgentMessage[], session: WorkflowSession, ui: DialogUI): Promise<AgentMessage[]> {
		const ctx = this.createContext(session, ui);
		let currentMessages = structuredClone(messages);

		for (const hook of this.hooks.get("context") ?? []) {
			try {
				const event: ContextEvent = { type: "context", messages: currentMessages };
				const handlerResult = await hook.definition.run(event, ctx);

				if (handlerResult && (handlerResult as ContextEventResult).messages) {
					currentMessages = (handlerResult as ContextEventResult).messages!;
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				this.emitError({
					path: hook.path,
					event: "context",
					error: message,
					stack,
				});
			}
		}

		return currentMessages;
	}

	/** The `provider_request` chain (translated from ExtensionRunner.emitBeforeProviderRequest): payload threaded, any non-undefined return replaces it. */
	async dispatchProviderRequest(payload: unknown, session: WorkflowSession, ui: DialogUI): Promise<unknown> {
		const ctx = this.createContext(session, ui);
		let currentPayload = payload;

		for (const hook of this.hooks.get("provider_request") ?? []) {
			try {
				const event: BeforeProviderRequestEvent = {
					type: "before_provider_request",
					payload: currentPayload,
				};
				const handlerResult = await hook.definition.run(event, ctx);
				if (handlerResult !== undefined) {
					currentPayload = handlerResult;
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				this.emitError({
					path: hook.path,
					event: "provider_request",
					error: message,
					stack,
				});
			}
		}

		return currentPayload;
	}

	/**
	 * The `agent_start` chain (translated from ExtensionRunner.emitBeforeAgentStart):
	 * messages accumulate, the system prompt chains (last writer wins). systemPromptOptions
	 * arrives explicitly — the workflow session facade does not expose it the way the
	 * extension ctx.session does.
	 */
	async dispatchAgentStart(
		prompt: string,
		images: ImageContent[] | undefined,
		systemPrompt: string,
		systemPromptOptions: BuildSystemPromptOptions,
		session: WorkflowSession,
		ui: DialogUI,
	): Promise<BeforeAgentStartCombinedResult | undefined> {
		const ctx = this.createContext(session, ui);
		let currentSystemPrompt = systemPrompt;
		const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];
		let systemPromptModified = false;

		for (const hook of this.hooks.get("agent_start") ?? []) {
			try {
				const event: BeforeAgentStartEvent = {
					type: "before_agent_start",
					prompt,
					images,
					systemPrompt: currentSystemPrompt,
					systemPromptOptions,
				};
				const handlerResult = await hook.definition.run(event, ctx);

				if (handlerResult) {
					const result = handlerResult as BeforeAgentStartEventResult;
					if (result.message) {
						messages.push(result.message);
					}
					if (result.systemPrompt !== undefined) {
						currentSystemPrompt = result.systemPrompt;
						systemPromptModified = true;
					}
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				this.emitError({
					path: hook.path,
					event: "agent_start",
					error: message,
					stack,
				});
			}
		}

		if (messages.length > 0 || systemPromptModified) {
			return {
				messages: messages.length > 0 ? messages : undefined,
				systemPrompt: systemPromptModified ? currentSystemPrompt : undefined,
			};
		}

		return undefined;
	}

	/** The `message_end` chain (translated from ExtensionRunner.emitMessageEnd): a role-changing replacement is rejected. */
	async dispatchMessageEnd(
		event: MessageEndEvent,
		session: WorkflowSession,
		ui: DialogUI,
	): Promise<AgentMessage | undefined> {
		const ctx = this.createContext(session, ui);
		let currentMessage = event.message;
		let modified = false;

		for (const hook of this.hooks.get("message_end") ?? []) {
			try {
				const currentEvent: MessageEndEvent = { ...event, message: currentMessage };
				const handlerResult = (await hook.definition.run(currentEvent, ctx)) as MessageEndEventResult | undefined;
				if (!handlerResult?.message) continue;

				if (handlerResult.message.role !== currentMessage.role) {
					this.emitError({
						path: hook.path,
						event: "message_end",
						error: "message_end hooks must return a message with the same role",
					});
					continue;
				}

				currentMessage = handlerResult.message;
				modified = true;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				this.emitError({
					path: hook.path,
					event: "message_end",
					error: message,
					stack,
				});
			}
		}

		return modified ? currentMessage : undefined;
	}

	/**
	 * The `input` chain (translated from ExtensionRunner.emitInput): transforms chain,
	 * "handled" short-circuits.
	 */
	async dispatchInput(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior: "steer" | "followUp" | undefined,
		session: WorkflowSession,
		ui: DialogUI,
	): Promise<InputEventResult> {
		const ctx = this.createContext(session, ui);
		let currentText = text;
		let currentImages = images;

		for (const hook of this.hooks.get("input") ?? []) {
			try {
				const event: InputEvent = {
					type: "input",
					text: currentText,
					images: currentImages,
					source,
					streamingBehavior,
				};
				const result = (await hook.definition.run(event, ctx)) as InputEventResult | undefined;
				if (result?.action === "handled") return result;
				if (result?.action === "transform") {
					currentText = result.text;
					currentImages = result.images ?? currentImages;
				}
			} catch (err) {
				this.emitError({
					path: hook.path,
					event: "input",
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		return currentText !== text || currentImages !== images
			? { action: "transform", text: currentText, images: currentImages }
			: { action: "continue" };
	}

	/**
	 * The `compact` chain (translated from the session_before_compact arm of
	 * ExtensionRunner.emit): last truthy result wins, `{ cancel }` short-circuits. Dedicated
	 * only because hooks have no generic observational emit to ride.
	 */
	async dispatchCompact(
		event: SessionBeforeCompactEvent,
		session: WorkflowSession,
		ui: DialogUI,
	): Promise<SessionBeforeCompactResult | undefined> {
		const ctx = this.createContext(session, ui);
		let result: SessionBeforeCompactResult | undefined;

		for (const hook of this.hooks.get("compact") ?? []) {
			try {
				const handlerResult = await hook.definition.run(event, ctx);

				if (handlerResult) {
					result = handlerResult as SessionBeforeCompactResult;
					if (result.cancel) {
						return result;
					}
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				this.emitError({
					path: hook.path,
					event: "compact",
					error: message,
					stack,
				});
			}
		}

		return result;
	}
}
