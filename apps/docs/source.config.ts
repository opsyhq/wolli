import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import type { Root } from "mdast";
import { visit } from "unist-util-visit";

// content/docs holds thin .mdx stubs (frontmatter + <include>) around the
// docs shipped inside the wolli package, which are also read at runtime by
// the agent and are never edited here. meta.json defines the sidebar order.
export const docs = defineDocs({
	dir: "content/docs",
	docs: {
		// Load bodies lazily so the search route indexes on demand and the
		// server bundle doesn't evaluate every compiled page up front.
		async: true,
	},
});

const GITHUB_BLOB = "https://github.com/opsyhq/wolli/blob/main/packages/wolli";

// The included packages/wolli/docs files are plain Markdown written for
// reading on disk: several carry a manual "Table of Contents" section and
// cross-references are relative `.md` links. Adapt them to the site at build
// time so the files themselves stay untouched. Runs after fumadocs'
// remark-include, which replaces the <include> tag with the included file's
// root node — so headings sit one level down, not at the top level. Lives in
// this file because the mdx vite plugin invalidates compiled pages only when
// source.config.ts changes.
function remarkWolliDocs() {
	return (tree: Root) => {
		visit(tree, "heading", (node, index, parent) => {
			if (!parent || index === undefined) return;
			// Drop the hand-written ToC (heading plus its list); the site
			// renders its own "On this page" rail.
			const [text] = node.children;
			if (node.depth === 2 && text?.type === "text" && text.value === "Table of Contents") {
				const next = parent.children[index + 1];
				parent.children.splice(index, next?.type === "list" ? 2 : 1);
				return index;
			}
		});
		visit(tree, "link", (node) => {
			node.url = rewriteLink(node.url);
		});
	};
}

function rewriteLink(url: string): string {
	// Leave protocol URLs, in-page anchors, and absolute paths alone.
	if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("#") || url.startsWith("/")) {
		return url;
	}
	// Links out of the docs dir (../README.md, ../src/types.ts) point at the
	// package on GitHub.
	if (url.startsWith("../")) {
		return `${GITHUB_BLOB}/${url.slice("../".length)}`;
	}
	// `extensions.md#anchor` / `./extensions.md` → site routes under /docs;
	// index.md is published as getting-started.
	const match = url.match(/^(?:\.\/)?([\w-]+)\.md(#.*)?$/);
	if (!match) return url;
	const [, name, anchor = ""] = match;
	return `/docs/${name === "index" ? "getting-started" : name}${anchor}`;
}

export default defineConfig({
	mdxOptions: { remarkPlugins: [remarkWolliDocs] },
});
