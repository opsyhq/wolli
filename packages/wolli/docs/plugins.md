# Plugins

A plugin is an npm-style package whose `package.json` carries a `"wolli"` manifest declaring the resources it contributes — extensions, integrations, skills, prompt templates, and/or themes. One install adds all of them to an agent at once, resolved in place from the single package. Plugins are how you share a [dual-half integration](./integrations.md#the-dual-half-package) (a transport plus its mapping extension), a bundle of [extensions](./extensions.md), or any mix of resource types between agents and across machines.

> **Per-agent, not global.** Wolli has no project scope. A plugin is installed for one agent and lands in that agent's own home (`~/.wolli/agents/<name>/`). The agent name precedes every verb: `wolli <agent> plugins install <source>`.

> **Security:** Plugins run with full host access. Extensions and integrations execute arbitrary code inside the agent process, and skills can instruct the model to take any action. Review a plugin's source before installing a third-party package.

## Table of Contents

- [What is a Plugin](#what-is-a-plugin)
- [Where Plugins Install](#where-plugins-install)
- [The package.json `wolli` Manifest](#the-packagejson-wolli-manifest)
- [Authoring a Plugin](#authoring-a-plugin)
- [Publishing](#publishing)
- [Installing](#installing)
- [Configuring & Onboarding](#configuring--onboarding)
- [Listing, Updating, Removing](#listing-updating-removing)
- [How Resolution Works](#how-resolution-works)
- [Worked Example: Packaging the Telegram Integration](#worked-example-packaging-the-telegram-integration)

## What is a Plugin

A plugin is a directory (or published package) with a `package.json` whose `"wolli"` field names the contribution files. Each listed path is a normal source module loaded by the agent's resource loader at launch:

- **integrations** — transport modules registered via `wolli.registerIntegration` (see [integrations.md](./integrations.md)).
- **extensions** — agent-owned behavior modules (see [extensions.md](./extensions.md)).
- **skills** — `SKILL.md` (or top-level `.md`) instruction files (see [skills.md](./skills.md)).
- **prompts** — `.md` prompt templates (see [prompt-templates.md](./prompt-templates.md)).
- **themes** — `.json` theme files (see [themes.md](./themes.md)).

A plugin may declare any subset. The canonical case is a single plugin that ships both halves of an integration: a transport under `"integrations"` and its mapping extension under `"extensions"`. Both resolve from the one install — the extension is **not** copied anywhere; it is loaded in place from the package (see [How Resolution Works](#how-resolution-works)).

## Where Plugins Install

`install` copies/clones the package into the agent's managed plugin store under its home. The store is keyed by source scheme:

```
~/.wolli/agents/<name>/
├── agent.json                     # the agent's settings override; records installed plugins in "plugins"[]
└── .plugins/
    ├── npm/                       # npm: sources — a private npm project; packages under node_modules/
    │   ├── package.json
    │   └── node_modules/<pkg>/
    ├── git/<host>/<user>/<repo>/  # git: sources — a clone per repo
    └── local/<slug>-<hash>/       # local sources — a recursive copy per origin path
```

- `npm:` packages install via `npm install --prefix <store>/npm --legacy-peer-deps` (bun/pnpm equivalents use `--omit=peer` / `auto-install-peers=false`). They live under `<store>/npm/node_modules/<name>`.
- `git:` sources are cloned to `<store>/git/<host>/<user>/<repo>`; if the clone has a `package.json`, dependencies are installed there.
- Local sources are copied (not symlinked) to `<store>/local/<basename-slug>-<sha256-prefix>`, so the install travels even if the origin moves; dependencies install in the copy.

The agent's discovery dirs (`~/.wolli/agents/<name>/extensions/`, `integrations/`, `skills/`, etc.) are for hand-placed local resources. Installed plugins are **not** unpacked into those dirs — they stay in `.plugins/` and are resolved from there.

## The package.json `wolli` Manifest

The plugin manager reads `package.json` and parses exactly the `"wolli"` object. Every key is an array of paths (relative to the package root) or glob patterns:

| Key            | Loaded as       | File pattern                  |
|----------------|-----------------|-------------------------------|
| `integrations` | integration modules | `.ts` / `.js`             |
| `extensions`   | extension modules   | `.ts` / `.js`             |
| `skills`       | skills              | `SKILL.md` / `.md`        |
| `prompts`      | prompt templates    | `.md`                     |
| `themes`       | themes              | `.json`                   |

No other keys under `"wolli"` are read. (There is no gallery/preview metadata; wolli has no package registry of its own — see [Publishing](#publishing).)

Example manifest (modeled on the shipped Telegram plugin; see the [worked example](#worked-example-packaging-the-telegram-integration) for the verbatim file):

```json
{
  "name": "wolli-integration-telegram",
  "type": "module",
  "wolli": {
    "integrations": ["./index.ts"],
    "extensions": ["./telegram-chat.ts"]
  },
  "dependencies": {
    "grammy": "1.44.0",
    "@grammyjs/runner": "2.0.3"
  },
  "peerDependencies": {
    "@opsyhq/wolli": "*"
  }
}
```

The simplest manifest lists one plain single-file path per key — a flat package with each contribution file at the package root:

```json
{
  "wolli": {
    "integrations": ["./index.ts"],
    "extensions": ["./x.ts"]
  }
}
```

Plain single-file path entries are **first-class**; globs and override prefixes are optional and only needed for multi-file or directory layouts. The advanced directory/glob/override-prefix semantics below layer on top of this base case.

**Notes:**

- Paths are relative to the package root and resolved against it. An entry is one of three things:
  - a **plain path** — a single file (`./index.ts`) loaded as-is, or a **directory**, which is then collected for that resource type. Directories collect by the type's file pattern (`.md` for skills/prompts, `.json` for themes); for `integrations`/`extensions` the directory is collected with the same package-style discovery as a convention dir (an `index.ts`/`index.js` or nested `package.json` manifest per subdir, **not** a flat sweep of every `.ts`).
  - a **glob** (contains `*` or `?`, e.g. `extensions/*.ts`) — expanded against the package root, then each match collected as above.
  - an **override prefix** (`!exclude`, `+force-include`, `-force-exclude`) — not a source itself; it layers on top of the paths the plain/glob entries already produced. `!` removes matches, `+` adds an exact path back even if excluded, `-` removes an exact path even if force-included.
  When an entry resolves to a directory (or a glob matches one), only files matching the resource type's pattern are picked up; a plain entry pointing straight at a single file is taken as-is, so list each file under its correct key.
- If no `"wolli"` manifest is present, the manager falls back to convention directories — `extensions/`, `integrations/`, `skills/`, `prompts/`, `themes/` — and auto-discovers files there. A bare file or a manifest-less directory with no convention dirs is treated as a single extension.
- Third-party runtime deps (here `grammy`; `croner` in the scheduler plugin) go in `dependencies` and are installed automatically when the plugin is fetched. `"dependencies"` is **optional** and may be omitted entirely when the transport relies only on Node globals — a transport that talks to a plain HTTP endpoint can call `fetch` directly with no bundled client (see [integrations.md › Available Imports](./integrations.md#available-imports), which states a plain-HTTP transport can use `fetch` directly and needs no bundled client). Bundling a client library is only needed for richer protocols.

### Why peerDependencies on `@opsyhq/wolli`

Contribution modules import host types and APIs from `@opsyhq/wolli` (`IntegrationsAPI`, `ExtensionFactory`, etc.). The host process *provides* that package at runtime, so the plugin must not bundle its own copy. Declare it as a peer with a `"*"` range:

```json
{ "peerDependencies": { "@opsyhq/wolli": "*" } }
```

Managed installs are run with peer resolution disabled (`--legacy-peer-deps` and equivalents), so the package manager does not try to install or solve this host-provided peer. The agent resolves it from the host at load time instead.

## Authoring a Plugin

Lay the package out as a normal npm package. A dual-half integration plugin looks like:

```
my-plugin/
├── package.json        # name, type: "module", "wolli" manifest, deps, peerDependencies
├── index.ts            # the integration transport (listed under "integrations")
├── my-chat.ts          # the mapping extension (listed under "extensions")
└── README.md
```

1. **Write the contribution files.** Author the transport half per [integrations.md](./integrations.md) and the mapping/behavior half per [extensions.md](./extensions.md). This doc does not duplicate their authoring guidance; it only packages them.
2. **Declare them in the manifest.** List each file under the matching `"wolli"` key (above).
3. **Set `"type": "module"`** so `.ts`/`.js` modules load as ESM.
4. **Put runtime deps in `dependencies`** and **`@opsyhq/wolli` in `peerDependencies`** with `"*"`.

That is the whole contract. There is no build step or registration call beyond the manifest — the agent's resource loader imports the listed files at launch.

## Publishing

A plugin is shared as an ordinary package. Wolli installs from three source kinds and nothing else — there is no wolli-hosted registry or installer. Pick the distribution that matches the source scheme you want users to install with:

| Distribution     | How users install                                         |
|------------------|-----------------------------------------------------------|
| npm registry     | `npm publish`, then `wolli <agent> plugins install npm:<name>` |
| git repository   | push to a host, then `... plugins install git:<host>/<user>/<repo>` |
| local path       | hand someone the directory, then `... plugins install ./path` |

- **npm:** publish the package to any registry the user's npm client can reach. Versioned specs (`npm:pkg@1.2.3`) install pinned and are skipped by `update`.

> **Publishing requirements for the npm path.** A registry-publishable plugin must **not** set `"private": true`. The shipped Telegram/Scheduler examples set it only because they are in-repo packages never published; `npm publish` refuses a `"private": true` package. npm also requires a `"version"` field — it is mandatory for `npm publish` and for any versioned spec (`npm:pkg@1.2.3`). The in-repo examples carry `"version": "1.0.0"` for this reason; the abbreviated manifest under [The package.json `wolli` Manifest](#the-packagejson-wolli-manifest) omits both fields to focus on the `"wolli"` block, not because they are optional for publishing.
- **git:** any reachable repo works; HTTPS and SSH are both supported, and a pinned ref (`@tag`/`@commit`) freezes the checkout.
- **local:** for development or private sharing — no registry needed. The path is copied into the agent's store on install.

Wolli does not run `npm publish` for you; it only *consumes* one of these three source forms.

## Installing

The agent name precedes the verb. Each source scheme maps to a distinct install path:

```bash
wolli <agent> plugins install npm:@scope/pkg              # npm: registry package
wolli <agent> plugins install npm:@scope/pkg@1.2.3        # pinned version
wolli <agent> plugins install git:github.com/user/repo    # git: shorthand
wolli <agent> plugins install git:github.com/user/repo@v1 # pinned ref
wolli <agent> plugins install ./path/to/plugin            # local path
```

Source-scheme rules (as parsed by the plugin manager):

- **`npm:`** — everything after the prefix is the npm spec; a trailing `@version` marks it pinned.
- **`git:`** — accepts shorthand (`github.com/user/repo`, `git@github.com:user/repo`) and protocol URLs (`https://`, `ssh://`). Without the `git:` prefix, only explicit protocol URLs are recognized as git.
- **local** — a path starting with `./`, `../`, `/`, or `~`; also the fallback for any source that is neither `npm:` nor a recognized git URL.

`install` routes to the agent's daemon, which is the single writer of the plugin store and reloads itself after the change. Install:

1. fetches the source into the agent's `.plugins/` store,
2. records the source in the agent's settings (`agent.json` `"plugins"[]`),
3. runs onboarding if applicable (below).

Local sources are normalized to an agent-relative form before being persisted, so they round-trip on the next launch.

Settings hold **one entry per plugin identity**, not per spec. Identity ignores the version/ref: npm by package name, git by `host/path` (so an SSH and an HTTPS URL for the same repo are the same plugin), local by resolved absolute origin. For local sources this means `remove ./path` / `update ./path` match by **resolved absolute origin**, not by the literal install spelling — `getPackageIdentity` keys on `local:<resolved-origin>` and `getLocalInstallPath` resolves the same way (`plugin-manager.ts`). So any relative spelling that resolves to the same directory matches the installed entry; reusing the identical spelling is sufficient but **not** required. Re-installing the same plugin at a different version or ref — e.g. after publishing a new `npm:pkg@2.0.0` over an existing `npm:pkg@1.0.0` — updates that single entry in place rather than appending a duplicate. This is also why a pinned npm entry whose installed copy no longer matches its pin is re-fetched at resolve time on the next launch.

## Configuring & Onboarding

If a contributed integration declares an `onboard` step (see [integrations.md › Onboarding](./integrations.md#onboarding)), guided setup runs over the daemon's UI round-trip, rendered in a startup TUI:

```bash
wolli <agent> plugins install ./packages/wolli/plugins/telegram   # installs, then auto-onboards if on a TTY
wolli <agent> plugins configure ./packages/wolli/plugins/telegram # re-run guided setup on demand
```

- **On install, on an interactive terminal (TTY):** onboarding runs immediately. Each onboarded service prints one result: `connected` (then a hint to run `wolli <agent>` to use it), `cancelled` (you dismissed a prompt), `not-found` (the integration is not installed for the agent), `no-onboard` (it declares no guided setup), or an `error` with its message. Any non-`connected`/`cancelled` result makes the command exit non-zero.
- **On install, non-interactive (no TTY):** install completes but skips setup and points you at `wolli <agent> plugins configure <source>` to finish later.
- **`configure`** re-runs the guided setup even if the account already exists. It requires an interactive terminal and is rejected early when headless. If the plugin has no guided setup, it reports `No guided setup available for this plugin.`

Onboarding writes account credentials to the per-agent `integrations.json`, separate from the plugin store — removing the plugin does not by itself touch saved accounts.

## Listing, Updating, Removing

| Verb                       | What it does                                          | Daemon |
|----------------------------|-------------------------------------------------------|--------|
| `plugins list`             | print installed plugins and the integrations they add | no     |
| `plugins update`           | update all installed plugins                          | yes    |
| `plugins update <source>`  | update only the matching plugin                       | yes    |
| `plugins remove <source>`  | remove the plugin and drop it from settings           | yes    |

```bash
wolli <agent> plugins list             # read installed plugins from settings (local, no daemon)
wolli <agent> plugins update           # update all installed plugins
wolli <agent> plugins update <source>  # update only the matching plugin
wolli <agent> plugins remove <source>  # remove the plugin and drop it from settings
```

- **`list`** reads the agent's settings on disk directly (no daemon spawn). It prints each configured source, its on-disk install path, a `(filtered)` marker when the entry uses the object form, and then the integrations those plugins contribute. Listing the integrations calls `resolve()`, which self-heals a missing install (see [How Resolution Works](#how-resolution-works)) — so `list` is not strictly read-only: a configured-but-uninstalled npm/git source can trigger a fetch here unless `WOLLI_OFFLINE=1` is set.
- **`update`** routes to the daemon. With a source, only the matching plugin updates; without one, all do. Pinned npm versions are fixed and skipped. Git sources reconcile an existing clone to the configured ref. Local sources are re-copied from their origin. Set `WOLLI_OFFLINE=1` to skip network fetches (local re-copy still runs).
- **`remove`** routes to the daemon, deletes the plugin from the store, and removes its source from settings. It errors if no configured plugin matches the source.

A plugin entry in settings can be a bare string (load everything) or an object that filters which contributions load:

```json
{
  "plugins": [
    "npm:wolli-integration-scheduler",
    {
      "source": "git:github.com/user/repo",
      "extensions": ["*.ts", "!legacy.ts"],
      "skills": []
    }
  ]
}
```

Omit a key to load all of that type; `[]` loads none; `!pattern` excludes; `+path`/`-path` force-include/exclude exact paths. Filters narrow what the manifest already allows.

## How Resolution Works

At each launch the resource loader calls the plugin manager's `resolve()`, which:

1. reads the agent's `"plugins"[]` from settings,
2. for each source, self-heals a missing install (re-fetches if the store entry is gone but the origin still exists),
3. resolves the contributions **in place** from the install — manifest paths first, then convention dirs, then the single-extension fallback,
4. applies any per-entry filter and name-collision precedence,
5. hands the enabled paths to the integration loader and extension loader.

Crucially, a dual-half package's integration and its paired extension both resolve from the *same* install directory in `.plugins/`. The extension is never copied into `<agent>/extensions/`. The integration arm loads first so the producer runner exists before the extension wires `getIntegration(...)`.

Because `install`/`remove`/`update` go through the daemon (the single writer), the running agent reloads itself after the change — installed contributions become active without a manual restart. Onboarding-gated mapping extensions activate once their account is configured.

## Worked Example: Packaging the Telegram Integration

The shipped Telegram plugin (`packages/wolli/plugins/telegram/`) is the canonical dual-half plugin. Its layout:

```
telegram/
├── package.json        # "wolli": { integrations: ["./index.ts"], extensions: ["./telegram-chat.ts"] }
├── index.ts            # transport: long-polls grammY, holds the bot token, emits a `message` event,
│                       #   exposes sendMessage / sendChatAction / setCommands, declares onboard
└── telegram-chat.ts    # mapping extension: routes each message into a per-chat Wolli session,
                        #   ships the reply back through the transport
```

Its manifest (verbatim):

```json
{
  "name": "wolli-integration-telegram",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "wolli": {
    "integrations": ["./index.ts"],
    "extensions": ["./telegram-chat.ts"]
  },
  "dependencies": {
    "grammy": "1.44.0",
    "@grammyjs/runner": "2.0.3"
  },
  "peerDependencies": {
    "@opsyhq/wolli": "*"
  }
}
```

Install it into an agent and onboard the bot token in one step (on a TTY):

```bash
wolli my-agent plugins install ./packages/wolli/plugins/telegram
# -> copies the package into ~/.wolli/agents/my-agent/.plugins/local/telegram-<hash>/
# -> records "plugins": ["packages/wolli/plugins/telegram"] in agent.json (agent-relative)
# -> runs onboard: prompts for the bot token, writes the account to integrations.json
```

Both `index.ts` and `telegram-chat.ts` resolve from that one copy. The transport starts; once the account is configured, the mapping extension activates and bidirectional chat is live. To package it for others, publish the same directory to npm (`wolli-integration-telegram`) or a git repo and have them install with `npm:` / `git:` instead of the local path.

The shipped scheduler plugin (`packages/wolli/plugins/scheduler/`) has the identical shape — `"integrations": ["./index.ts"]`, `"extensions": ["./scheduler-chat.ts"]`, one runtime dep (`croner`), and the same `@opsyhq/wolli` peer — confirming the dual-half pattern is the convention, not Telegram-specific. The only manifest differences are the package name, the dependency, and the extension filename.
