import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const agentSrc = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const agentNodeSrc = fileURLToPath(new URL("../agent/src/node.ts", import.meta.url));
const tuiSrc = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
	},
	resolve: {
		// Resolve workspace packages to source so tests run against current code.
		// Order matters: the /node subpath must match before the bare specifier.
		alias: [
			{ find: /^@opsyhq\/agent\/node$/, replacement: agentNodeSrc },
			{ find: /^@opsyhq\/agent$/, replacement: agentSrc },
			{ find: /^@opsyhq\/tui$/, replacement: tuiSrc },
		],
	},
});
