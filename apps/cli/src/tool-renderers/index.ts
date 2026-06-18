import type { Component } from "@opsyhq/tui";
import type { Theme, ToolName, ToolRenderContext, ToolRenderResultOptions } from "@opsyhq/steward";
import { bashRenderer } from "./bash.ts";
import { editRenderer } from "./edit.ts";
import { findRenderer } from "./find.ts";
import { grepRenderer } from "./grep.ts";
import { lsRenderer } from "./ls.ts";
import { readRenderer } from "./read.ts";
import { writeRenderer } from "./write.ts";

/**
 * The render half of a built-in tool, lifted client-side. Mirrors `ToolDefinition`'s render members
 * but types `args`/`result` as `any` — the concrete schema type is lost once the renderer is detached
 * from its (engine-side) `ToolDefinition<TParams>`, and each renderer narrows internally.
 */
export interface ToolRenderer {
	renderCall?: (args: any, theme: Theme, context: ToolRenderContext) => Component;
	renderResult?: (result: any, options: ToolRenderResultOptions, theme: Theme, context: ToolRenderContext) => Component;
	renderShell?: "default" | "self";
}

export const toolRenderers: Record<ToolName, ToolRenderer> = {
	read: readRenderer,
	bash: bashRenderer,
	edit: editRenderer,
	write: writeRenderer,
	grep: grepRenderer,
	find: findRenderer,
	ls: lsRenderer,
};

export function getToolRenderer(name: string): ToolRenderer | undefined {
	return (toolRenderers as Record<string, ToolRenderer>)[name];
}
