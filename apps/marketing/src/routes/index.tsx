import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { Chat } from "@/components/chat";
import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/use-session";

export const Route = createFileRoute("/")({ component: Home });

const INSTALL_COMMAND = "npm i -g wolli";

function Home() {
	const [copied, setCopied] = useState(false);
	const session = useSession("/sessions/extend.jsonl");

	function copyInstall() {
		navigator.clipboard.writeText(INSTALL_COMMAND).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	}

	return (
		<>
			<main className="flex min-h-screen flex-col items-center justify-center px-6">
				<div className="mx-auto flex max-w-3xl flex-col items-center text-center">
					<h1 className="text-5xl font-semibold tracking-tight text-balance sm:text-6xl md:text-7xl">
						Create agents that grow around a purpose
					</h1>
					<p className="mt-6 max-w-xl text-lg text-balance text-muted-foreground sm:text-xl">
						Each agent remembers across sessions, runs on schedules, reacts to events, and extends itself over
						time.
					</p>
					<div className="group mt-10 flex items-center gap-1 rounded-full bg-background py-2.5 pr-3 pl-5 shadow-[0_2px_8px_rgba(0,0,0,0.06)] ring-1 ring-black/[0.06]">
						<span className="pr-1 font-mono text-base text-muted-foreground select-none">$</span>
						<span className="font-mono text-sm text-foreground">{INSTALL_COMMAND}</span>
						<Button
							variant="ghost"
							size="icon"
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
				</div>
			</main>
			<section ref={session.ref} className="flex justify-center px-6 pb-32">
				<div className="w-full max-w-3xl">
					<Chat blocks={session.blocks} busy={session.busy} input={session.input} />
				</div>
			</section>
		</>
	);
}
