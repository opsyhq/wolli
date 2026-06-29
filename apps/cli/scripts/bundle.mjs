#!/usr/bin/env node
/**
 * Build the single-package `wolli` npm artifact.
 *
 * esbuild bundles the CLI plus its three workspace packages (@opsyhq/agent,
 * @opsyhq/tui, @opsyhq/wolli) and all bundleable third-party deps into one
 * dist/cli.js, then copies the non-JS sidecars (themes, plugins, docs, tui
 * native addons, photon wasm) and writes a dependency-free package.json. The
 * result in `bundle/` is a self-contained package: one name, one version,
 * nothing else to publish.
 */

import { build } from "esbuild";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(scriptDir, "..");
const repoRoot = resolve(scriptDir, "../../..");
const wolliDir = join(repoRoot, "packages/wolli");
const tuiDir = join(repoRoot, "packages/tui");
const out = join(cliDir, "bundle");

const cliPkg = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "dist"), { recursive: true });

// 1. Bundle JS. First-party + third-party are inlined; node builtins stay
//    external (platform:node). createRequire shim lets bundled CJS deps call
//    require(); define flips the loaders onto jiti virtualModules at runtime.
await build({
	entryPoints: [join(cliDir, "src/cli.ts")],
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	outfile: join(out, "dist/cli.js"),
	banner: { js: 'import { createRequire as __cr } from "node:module";\nconst require = __cr(import.meta.url);' },
	define: { "process.env.WOLLI_BUNDLED": '"1"' },
	logLevel: "info",
});
chmodSync(join(out, "dist/cli.js"), 0o755);

// 2. Sidecars that cannot live inside a JS bundle. Paths mirror what
//    packages/wolli/src/config.ts resolves relative to the package root.
cpSync(join(wolliDir, "src/theme"), join(out, "dist/theme"), { recursive: true }); // getThemesDir -> <pkg>/dist/theme
cpSync(join(wolliDir, "built-in"), join(out, "built-in"), { recursive: true }); // getBuiltInDir -> <pkg>/built-in (plugins + skills)
cpSync(join(wolliDir, "docs"), join(out, "docs"), { recursive: true }); // getDocsPath -> <pkg>/docs
cpSync(join(repoRoot, "README.md"), join(out, "README.md")); // npm page + getReadmePath -> <pkg>/README.md
cpSync(join(repoRoot, "LICENSE"), join(out, "LICENSE"));

// tui native addons: native-modifiers.ts resolves <pkg>/dist/../native/...
cpSync(join(tuiDir, "native/darwin/prebuilds"), join(out, "native/darwin/prebuilds"), { recursive: true });
cpSync(join(tuiDir, "native/win32/prebuilds"), join(out, "native/win32/prebuilds"), { recursive: true });

// photon wasm: ships next to cli.js (photon.ts fallback looks in the module dir).
cpSync(
	join(repoRoot, "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm"),
	join(out, "dist/photon_rs_bg.wasm"),
);

// 3. Dependency-free package.json — everything is bundled or shipped as a file.
const pkg = {
	name: "wolli",
	version: cliPkg.version,
	description: "Persistent, purposeful agent CLI with memory and identity",
	type: "module",
	piConfig: { name: "wolli", configDir: ".wolli" },
	bin: { wolli: "dist/cli.js" },
	files: ["dist", "built-in", "docs", "native"],
	keywords: ["agent", "agents", "ai", "llm", "cli", "tui", "memory", "autonomous", "assistant"],
	license: "Apache-2.0",
	homepage: "https://github.com/opsyhq/wolli#readme",
	repository: { type: "git", url: "git+https://github.com/opsyhq/wolli.git" },
	bugs: { url: "https://github.com/opsyhq/wolli/issues" },
	engines: { node: ">=22.19.0" },
};
writeFileSync(join(out, "package.json"), `${JSON.stringify(pkg, null, "\t")}\n`);

console.log(`\nBundled wolli@${pkg.version} -> ${out}`);
