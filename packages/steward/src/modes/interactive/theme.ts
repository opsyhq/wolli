/**
 * Minimal TUI theme for steward's interactive mode.
 *
 * Mirrors `@opsyhq/coding-agent`'s theme/theme.ts factory names (`getEditorTheme`,
 * `getMarkdownTheme`, `getSelectListTheme`) but stays dependency-free: instead of a
 * full theme proxy + chalk, styling is a handful of raw-ANSI helpers. Swap these for
 * a richer palette later without touching the call sites.
 */

import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@opsyhq/tui";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

function wrap(code: string): (text: string) => string {
	return (text: string) => `${ESC}${code}m${text}${RESET}`;
}

const dim = wrap("2");
const bold = wrap("1");
const italic = wrap("3");
const underline = wrap("4");
const strikethrough = wrap("9");
const cyan = wrap("36");
const blue = wrap("34");
const yellow = wrap("33");

/** Shared accent helpers used by the interactive mode chat surface. */
export const style = { dim, bold, italic, underline, cyan, blue, yellow };

export function getMarkdownTheme(): MarkdownTheme {
	return {
		heading: (text) => bold(cyan(text)),
		link: (text) => blue(text),
		linkUrl: (text) => dim(blue(text)),
		code: (text) => yellow(text),
		codeBlock: (text) => yellow(text),
		codeBlockBorder: (text) => dim(text),
		quote: (text) => dim(text),
		quoteBorder: (text) => dim(text),
		hr: (text) => dim(text),
		listBullet: (text) => cyan(text),
		bold: (text) => bold(text),
		italic: (text) => italic(text),
		strikethrough: (text) => strikethrough(text),
		underline: (text) => underline(text),
	};
}

export function getSelectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (text) => cyan(text),
		selectedText: (text) => cyan(text),
		description: (text) => dim(text),
		scrollInfo: (text) => dim(text),
		noMatch: (text) => dim(text),
	};
}

export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text) => dim(text),
		selectList: getSelectListTheme(),
	};
}
