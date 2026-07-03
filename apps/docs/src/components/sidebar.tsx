import { usePathname } from "fumadocs-core/framework";
import type * as PageTree from "fumadocs-core/page-tree";
import { SidebarDrawerContent, SidebarDrawerOverlay, SidebarItem } from "fumadocs-ui/components/sidebar/base";
import { useTreeContext } from "fumadocs-ui/contexts/tree";
import { SidebarTrigger } from "fumadocs-ui/layouts/docs/slots/sidebar";
import { FullSearchTrigger } from "fumadocs-ui/layouts/shared/slots/search-trigger";

// The wrapper div must mirror fumadocs' default sidebar slot so the layout
// grid still reserves the column.
export function WolliSidebar() {
	const { root } = useTreeContext();
	const pane = (
		<>
			<FullSearchTrigger hideIfDisabled className="mb-4 flex w-full" />
			<SidebarList items={root.children} />
		</>
	);

	return (
		<>
			<div
				data-sidebar-placeholder
				className="pointer-events-none sticky top-(--fd-docs-row-1) z-20 h-[calc(var(--fd-docs-height)-var(--fd-docs-row-1))] [grid-area:sidebar] *:pointer-events-auto max-md:hidden md:layout:[--fd-sidebar-width:268px]"
			>
				<div className="h-full overflow-y-auto px-4 py-10">{pane}</div>
			</div>
			<SidebarDrawerOverlay className="fixed inset-0 z-40 backdrop-blur-xs data-[state=open]:animate-fd-fade-in data-[state=closed]:animate-fd-fade-out" />
			<SidebarDrawerContent className="fixed inset-y-0 inset-e-0 z-40 flex w-[85%] max-w-[380px] flex-col border-s bg-fd-background shadow-lg data-[state=open]:animate-fd-sidebar-in data-[state=closed]:animate-fd-sidebar-out">
				<div className="flex-1 overflow-y-auto p-4">{pane}</div>
			</SidebarDrawerContent>
		</>
	);
}

export function MobileMenuButton() {
	return (
		<SidebarTrigger className="mb-4 flex items-center gap-2 self-start text-sm text-muted-foreground transition-colors hover:text-foreground md:hidden">
			<svg
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				aria-hidden="true"
				className="size-4"
			>
				<path d="M2 4h12M2 8h12M2 12h12" />
			</svg>
			Menu
		</SidebarTrigger>
	);
}

function SidebarList({ items }: { items: PageTree.Node[] }) {
	return items.map((item) => {
		if (item.type === "separator") {
			return (
				<p key={item.$id} className="mt-6 mb-2 text-sm font-medium text-foreground first:mt-0">
					{item.name}
				</p>
			);
		}
		if (item.type === "folder") {
			return (
				<div key={item.$id}>
					{item.index ? <SidebarLink item={item.index} /> : <p className="py-1.5 text-sm">{item.name}</p>}
					<div className="ms-3">
						<SidebarList items={item.children} />
					</div>
				</div>
			);
		}
		return <SidebarLink key={item.$id} item={item} />;
	});
}

function SidebarLink({ item }: { item: PageTree.Item }) {
	const pathname = usePathname();
	const active = pathname.replace(/\/+$/, "") === item.url;
	return (
		<SidebarItem
			href={item.url}
			external={item.external}
			active={active}
			className="block w-full truncate py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground data-[active=true]:font-medium data-[active=true]:text-foreground"
		>
			{item.name}
		</SidebarItem>
	);
}
