import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({ component: Home });

const INSTALL_COMMAND = "npm i -g wolli";

const STRUCTURE_FILES = [
	{
		name: "SOUL.md",
		label: "purpose",
		copy: "The durable identity your agent writes and carries forward.",
	},
	{
		name: "integrations/github.ts",
		label: "integration",
		copy: "Connect GitHub, Telegram, Discord, schedulers, and your own services.",
	},
	{
		name: "workflows/triage.md",
		label: "workflow",
		copy: "Wake on events, follow repeatable playbooks, and keep moving.",
	},
	{
		name: "skills/research.md",
		label: "custom",
		copy: "Capture repeated experience as skills the agent can reuse.",
	},
];

const FEATURE_SECTIONS = [
	{
		eyebrow: "Integrations",
		title: "Add the places your agent should work.",
		copy: "Drop in built-in plugins for GitHub, Telegram, Discord, and schedules, or add your own integration when the job needs a private system.",
		align: "left",
		visual: "integrations",
	},
	{
		eyebrow: "Workflows",
		title: "Turn repeated operations into durable runs.",
		copy: "Agents can wake up from events, cron schedules, or a conversation, then keep their context across the whole workflow.",
		align: "right",
		visual: "workflows",
	},
	{
		eyebrow: "Customization",
		title: "Shape the agent around your process.",
		copy: "Tune memory, skills, tools, providers, themes, and sandbox behavior in files that live with the agent instead of in a remote dashboard.",
		align: "left",
		visual: "customize",
	},
] as const;

const FINAL_FEATURES = [
	"Persistent sessions",
	"Curated memory",
	"Sandboxed execution",
	"Multi-provider models",
	"Built-in plugins",
	"Local-first configuration",
];

function AgentDirectory() {
	return (
		<div className="relative mx-auto w-full max-w-4xl overflow-hidden rounded-[2rem] border border-black/10 bg-white/75 p-4 shadow-[0_28px_90px_-50px_rgba(0,0,0,0.55)] backdrop-blur-xl sm:p-6">
			<div className="rounded-[1.5rem] border border-black/5 bg-[#f7f7f5] p-4 sm:p-6">
				<div className="flex items-center justify-between border-b border-black/10 pb-4">
					<div>
						<p className="font-mono text-xs text-muted-foreground">agent/</p>
						<p className="mt-1 text-lg font-medium">Your agent is a directory</p>
					</div>
					<div className="rounded-full bg-[#E84D35]/10 px-3 py-1 font-mono text-xs text-[#B93824]">wolli</div>
				</div>
				<div className="mt-5 grid gap-3 md:grid-cols-2">
					{STRUCTURE_FILES.map((file) => (
						<div key={file.name} className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-sm">
							<div className="flex items-center justify-between gap-3">
								<p className="truncate font-mono text-sm">{file.name}</p>
								<span className="rounded-full bg-muted px-2 py-1 text-[11px] text-muted-foreground">
									{file.label}
								</span>
							</div>
							<p className="mt-8 text-sm leading-relaxed text-muted-foreground">{file.copy}</p>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

function FeatureVisual({ type }: { type: (typeof FEATURE_SECTIONS)[number]["visual"] }) {
	if (type === "integrations") {
		return (
			<div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
				{["GitHub", "Telegram", "Discord", "Scheduler", "MCP", "Custom API"].map((item) => (
					<div key={item} className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-sm">
						<div className="mb-8 size-2 rounded-full bg-[#E84D35]" />
						{item}
					</div>
				))}
			</div>
		);
	}
	if (type === "workflows") {
		return (
			<div className="space-y-3 font-mono text-sm">
				{["issue.opened", "load memory", "run triage", "request approval", "post summary"].map((step, index) => (
					<div
						key={step}
						className="flex items-center gap-3 rounded-2xl border border-black/[0.06] bg-white p-4 shadow-sm"
					>
						<span className="flex size-7 items-center justify-center rounded-full bg-[#E84D35]/10 text-xs text-[#B93824]">
							{index + 1}
						</span>
						<span>{step}</span>
					</div>
				))}
			</div>
		);
	}
	return (
		<div className="rounded-3xl border border-black/[0.06] bg-white p-5 font-mono text-sm shadow-sm">
			<p className="text-muted-foreground">SOUL.md</p>
			<div className="mt-5 space-y-3">
				<p># Identity</p>
				<p className="text-muted-foreground">You are the release coordinator.</p>
				<p># Skills</p>
				<p className="text-muted-foreground">Use changelog, deploy, and incident playbooks.</p>
			</div>
		</div>
	);
}

function Home() {
	const [copied, setCopied] = useState(false);

	function copyInstall() {
		navigator.clipboard.writeText(INSTALL_COMMAND).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	}

	return (
		<>
			<main className="overflow-hidden">
				<section className="relative flex min-h-[calc(100svh-3.5rem)] flex-col items-center justify-center px-6 py-24 text-center">
					<div
						aria-hidden
						className="absolute inset-x-0 top-16 -z-10 mx-auto h-[34rem] max-w-5xl rounded-full bg-[#E84D35]/20 blur-3xl"
					/>
					<div className="mx-auto max-w-4xl">
						<p className="font-mono text-sm text-[#B93824]">local-first agent framework</p>
						<h1 className="mt-5 font-heading text-[3rem]/[0.95] font-normal tracking-[-0.04em] text-balance sm:text-[4.75rem]/[0.9] md:text-[6.5rem]/[0.86]">
							Build agents from a folder.
						</h1>
						<p className="mx-auto mt-7 max-w-2xl text-lg leading-8 text-muted-foreground sm:text-xl">
							Wolli gives every agent memory, integrations, workflows, skills, tools, and sandboxed execution
							that grow with its purpose.
						</p>
						<div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
							<div className="group flex items-center gap-1 rounded-full bg-background py-1.5 pr-2.5 pl-4 shadow-[0_2px_8px_rgba(0,0,0,0.06)] ring-1 ring-black/[0.06]">
								<span className="pr-1 font-mono text-base text-muted-foreground select-none">$</span>
								<span className="font-mono text-sm text-foreground">{INSTALL_COMMAND}</span>
								<Button
									variant="ghost"
									size="icon-sm"
									onClick={copyInstall}
									aria-label="Copy install command"
									className="ml-1 cursor-pointer rounded-full"
								>
									{copied ? <Check /> : <Copy />}
									<span className="sr-only" aria-live="polite">
										{copied ? "Copied" : ""}
									</span>
								</Button>
							</div>
							<a
								href="/docs/getting-started/"
								className={cn(
									buttonVariants({ size: "lg" }),
									"h-12 rounded-full bg-[#E84D35] px-7 text-white hover:bg-[#E84D35]/90",
								)}
							>
								Get started
							</a>
						</div>
					</div>
					<div className="mt-16 w-full">
						<AgentDirectory />
					</div>
				</section>

				<section className="mx-auto w-full max-w-7xl px-6 py-16 sm:py-24">
					{FEATURE_SECTIONS.map((feature) => (
						<div
							key={feature.title}
							className="grid min-h-[72svh] items-center gap-10 py-12 md:grid-cols-2 md:gap-16"
						>
							<div className={cn(feature.align === "right" && "md:order-2 md:pl-10")}>
								<p className="font-mono text-sm text-[#B93824]">{feature.eyebrow}</p>
								<h2 className="mt-4 font-heading text-[2.5rem]/[0.95] font-normal tracking-[-0.035em] text-balance sm:text-[4rem]/[0.9]">
									{feature.title}
								</h2>
								<p className="mt-6 max-w-xl text-lg leading-8 text-muted-foreground">{feature.copy}</p>
							</div>
							<div className="rounded-[2rem] border border-black/10 bg-[#f7f7f5]/80 p-4 shadow-[0_28px_90px_-60px_rgba(0,0,0,0.6)] backdrop-blur sm:p-6">
								<FeatureVisual type={feature.visual} />
							</div>
						</div>
					))}
				</section>

				<section className="mx-auto w-full max-w-6xl px-6 py-24 text-center sm:py-32">
					<h2 className="mx-auto max-w-3xl font-heading text-[2.75rem]/[0.95] font-normal tracking-[-0.035em] text-balance sm:text-[5rem]/[0.9]">
						Everything at the bottom, ready for production.
					</h2>
					<div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{FINAL_FEATURES.map((feature) => (
							<div
								key={feature}
								className="rounded-2xl border border-black/[0.06] bg-white/80 p-5 text-left shadow-sm"
							>
								{feature}
							</div>
						))}
					</div>
					<a
						href="/docs/getting-started/"
						className={cn(
							buttonVariants({ size: "lg" }),
							"mt-12 h-12 rounded-full bg-[#E84D35] px-7 text-white hover:bg-[#E84D35]/90",
						)}
					>
						Build your first agent
					</a>
				</section>
			</main>
			<footer className="border-t border-border bg-muted/50">
				<div className="mx-auto flex h-14 w-full items-center justify-between px-6 text-sm text-muted-foreground md:px-24 lg:px-40">
					<p>© 2026 Opsy, Inc.</p>
					<a
						href="https://github.com/opsyhq/wolli"
						target="_blank"
						rel="noreferrer"
						className="transition-colors hover:text-foreground"
					>
						GitHub
					</a>
				</div>
			</footer>
		</>
	);
}
