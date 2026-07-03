import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import browserCollections from "collections/browser";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsBody, DocsPage } from "fumadocs-ui/layouts/docs/page";
import { SidebarProvider, SidebarTrigger, useSidebar } from "fumadocs-ui/layouts/docs/slots/sidebar";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { Suspense } from "react";
import { MobileMenuButton, WolliSidebar } from "#/components/sidebar";
import { source } from "#/lib/source";

export const Route = createFileRoute("/docs/$")({
	component: Page,
	loader: async ({ params }) => {
		const slugs = params._splat?.split("/").filter(Boolean) ?? [];
		const data = await serverLoader({ data: slugs });
		await clientLoader.preload(data.path);
		return data;
	},
	head: ({ loaderData }) => ({
		meta: loaderData ? [{ title: loaderData.title }] : [],
	}),
});

// collections/server only runs in Node (fumadocs-mdx's server runtime), so
// page lookup stays behind a server function; its requests go to
// /docs/_serverFn/* on this worker (see vite.config.ts).
const serverLoader = createServerFn({ method: "GET" })
	.validator((slugs: string[]) => slugs)
	.handler(async ({ data: slugs }) => {
		const page = source.getPage(slugs);
		if (!page) throw notFound();
		return {
			path: page.path,
			title: page.data.title,
			pageTree: await source.serializePageTree(source.getPageTree()),
		};
	});

const clientLoader = browserCollections.docs.createClientLoader({
	id: "docs",
	component({ toc, default: MDX }) {
		return (
			// The Markdown's own `# H1` is the page title, so no <DocsTitle>.
			<DocsPage toc={toc} tableOfContent={{ style: "clerk" }}>
				<MobileMenuButton />
				<DocsBody>
					<MDX components={defaultMdxComponents} />
				</DocsBody>
			</DocsPage>
		);
	},
});

// Keep fumadocs' provider/trigger machinery, replace only the pane itself.
const sidebar = {
	provider: SidebarProvider,
	root: WolliSidebar,
	trigger: SidebarTrigger,
	useSidebar,
};

function Page() {
	const { path, pageTree } = useFumadocsLoader(Route.useLoaderData());

	return (
		// The grid's sticky rows start below the h-14 site header; fumadocs'
		// own navbar, search box, and theme switch stay off (light-only site).
		<DocsLayout
			tree={pageTree}
			nav={{ enabled: false }}
			searchToggle={{ enabled: false }}
			themeSwitch={{ enabled: false }}
			slots={{ sidebar }}
			containerProps={{
				className: "mx-auto max-w-[90rem]",
				style: { "--fd-docs-row-1": "3.5rem" } as React.CSSProperties,
			}}
		>
			<Suspense>{clientLoader.useContent(path)}</Suspense>
		</DocsLayout>
	);
}
