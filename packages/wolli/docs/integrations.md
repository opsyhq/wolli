# Integrations

Integrations are a wolli-native subsystem: a TypeScript module that models a bidirectional port to the outside world. Where an [extension](./extensions.md) is agent-owned behavior, an integration is a platform-owned transport. It faces the network, holds credentials, authenticates inbound traffic, and turns outside activity into events. It does not decide what the agent should care about — an extension does that.

The split is the whole point:

- **Integrations make sounds.** A Telegram message arrives. The clock ticks. The integration makes that available as an event and exposes actions to talk back.
- **Extensions listen.** An extension subscribes to those events, decides which matter, and maps them onto sessions.

So an integration is a transport, not a workflow object. The workflow lives in the paired extension, like everything else the agent learns or builds.

> **Note:** The integration factory's first argument is named `wolli` throughout this document — by convention, the same as the extension factory argument. It is the `IntegrationsAPI` object; call it whatever you like. The package.json manifest key that declares integrations is `"wolli"`; that key name is fixed and unrelated to the argument name.
>
> An integration has two halves. The **producer/transport** half (`run`, `actions`, `events`, `onboard`) is the integration module itself, registered via `wolli.registerIntegration`. The **mapping** half is an ordinary extension that consumes the integration via `wolli.getIntegration(...)`. The two ship together as one package (see [The dual-half package](#the-dual-half-package)).

## Table of Contents

- [Quick Start](#quick-start)
- [Integration Locations](#integration-locations)
- [Available Imports](#available-imports)
- [Writing an Integration](#writing-an-integration)
- [IntegrationConfig](#integrationconfig)
- [The producer: run(ctx)](#the-producer-runctx)
- [Durable state: ctx.store](#durable-state-ctxstore)
- [Actions](#actions)
- [Onboarding](#onboarding)
- [Consuming an Integration](#consuming-an-integration)
- [The dual-half package](#the-dual-half-package)
- [Installing and configuring](#installing-and-configuring)
- [Error Handling](#error-handling)
- [Worked example: Telegram (bidirectional chat)](#worked-example-telegram-bidirectional-chat)
- [Worked example: Scheduler (timer to wake)](#worked-example-scheduler-timer-to-wake)

## Quick Start

An integration is a default-exported factory that registers one or more services. The transport half emits events and exposes actions; the mapping half (an extension) consumes them.

`integration.ts` — the transport:

```typescript
import type { IntegrationsAPI } from "@opsyhq/wolli";
import { Type } from "typebox";

export default function (wolli: IntegrationsAPI) {
  wolli.registerIntegration({
    name: "ticker",
    account: Type.Object({ intervalMs: Type.Optional(Type.Number()) }),
    events: {
      tick: Type.Object({ at: Type.Number() }),
    },
    actions: {
      now: {
        description: "Return the current epoch ms.",
        parameters: Type.Object({}),
        execute: async () => ({ at: Date.now() }),
      },
    },
    run(ctx) {
      const account = ctx.account as { intervalMs?: number };
      const timer = setInterval(() => ctx.emit("tick", { at: Date.now() }), account.intervalMs ?? 1000);
      return () => clearInterval(timer); // disposer; also fired on ctx.signal abort
    },
  });
}
```

`mapping.ts` — the extension that listens:

```typescript
import type { ExtensionAPI } from "@opsyhq/wolli";

export default function (wolli: ExtensionAPI) {
  const ticker = wolli.getIntegration("ticker", "default");
  ticker.on("tick", async (data) => {
    const { at } = data as { at: number };
    const tag = { "ticker:default": "1" };
    const [match] = await wolli.findSessions(tag);
    const session = match
      ? await wolli.openSession(match.id)
      : await wolli.createSession({
          setup: async (sessionManager) => {
            await sessionManager.appendTags(tag);
          },
        });
    session.appendEntry("tick", { at }); // durable entry, not sent to the LLM
  });
}
```

Both files ship in one package (see [The dual-half package](#the-dual-half-package)), installed with:

```bash
wolli <agent> plugins install ./path/to/ticker
```

## Integration Locations

Integrations are discovered per-agent, like extensions. They live in the agent's own home; there is no project-local integration location.

| Location | Scope |
|----------|-------|
| `~/.wolli/agents/<name>/integrations/*.ts` | The agent (all sessions) |
| `~/.wolli/agents/<name>/integrations/*/index.ts` | The agent (subdirectory) |

Plugins installed with `wolli <agent> plugins install <source>` are resolved into this folder by the package manager. Configured account credentials live separately, in the per-agent `integrations.json`:

```
~/.wolli/agents/<name>/
├── integrations/             # discovered integration modules (resolved from installs)
├── integrations.json         # (service, account) credential records — written 0o600
└── store/
    └── <service>.json        # durable per-service runtime state (ctx.store)
```

`getAgentIntegrationsDir(name)` and `getAgentIntegrationsPath(name)` resolve these paths.

## Available Imports

| Package | Purpose |
|---------|---------|
| `@opsyhq/wolli` | Integration types (`IntegrationsAPI`, `IntegrationConfig`, `IntegrationOnboardContext`, `IntegrationRunContext`, `IntegrationActionContext`, `KeyValueStore`, `IntegrationHandle`) |
| `typebox` | Schemas (`Type`) for `account`, `events`, and action `parameters` |

The integration types are host-provided. A shipped integration package declares `@opsyhq/wolli` as a **peerDependency**, not a dependency — the host supplies it at load time. The package brings its own transport dependencies (the Telegram plugin bundles `grammy` + `@grammyjs/runner`; the scheduler bundles `croner`).

Node.js built-ins (`node:crypto`, etc.) are available. The integration runs in the host's Node.js process, so global `fetch`, `node:http`/`node:https`, `URL`, timers, and the other standard Node globals are all in scope. A transport that talks to a plain HTTP endpoint can use `fetch` directly; bundling a client library (as Telegram bundles `grammy`) is only needed for richer protocols.

## Writing an Integration

An integration module default-exports a factory receiving `IntegrationsAPI`. Inside, call `wolli.registerIntegration(config)` once per service. The factory may be synchronous or asynchronous.

```typescript
import type { IntegrationsAPI } from "@opsyhq/wolli";

export type IntegrationFactory = (wolli: IntegrationsAPI) => void | Promise<void>;
```

`IntegrationsAPI` is small:

```typescript
interface IntegrationsAPI {
  registerIntegration(config: IntegrationConfig): void;
  unregisterIntegration(name: string): void;
}
```

`registerIntegration` writes the definition directly at load time. `unregisterIntegration(name)` is available for teardown; the shipped plugins register a single static service and never call it.

## IntegrationConfig

The object passed to `registerIntegration`. Every field except a service identity is optional, so an integration can be pure-producer (events + `run`), pure-action (request/response only), or both.

```typescript
interface IntegrationConfig {
  name?: string;                                   // service id; defaults to the file/dir basename
  account?: TSchema;                               // schema for ONE configured account record
  events?: Record<string, TSchema>;                // named events this integration emits
  actions?: Record<string, IntegrationAction>;     // callable request/response functions
  run?(ctx: IntegrationRunContext): void | (() => void) | Promise<void | (() => void)>;
  onboard?(ctx: IntegrationOnboardContext): Promise<IntegrationAccountRecord | undefined>;
}
```

- `name` — the service id consumers pass to `getIntegration(name, account)`. Defaults to the basename of the file or directory.
- `account` — a typebox schema for **one** configured account record. The host validates the persisted record against this both at onboarding time and before handing it to `run`/actions as `ctx.account`. Derive the static type from the schema with typebox `Static<>` to avoid drift, e.g. `const Account = Type.Object({ url: Type.String() }); type Account = Static<typeof Account>;` then `ctx.account as Account`. The same pattern applies to action `parameters`.
- `events` — a map of event name to payload schema. `ctx.emit(event, data)` validates `data` against the matching schema.
- `actions` — request/response functions consumers invoke with `.call(action, params)`. See [Actions](#actions).
- `run` — the long-running producer. See [The producer: run(ctx)](#the-producer-runctx).
- `onboard` — guided first-run setup. See [Onboarding](#onboarding).

> **Multiple accounts:** `account` describes a single record. Onboarding always writes the account key `"default"`. A second account (`getIntegration(name, "work")`) only exists if you add it to `integrations.json` by hand; nothing in the shipped flow creates one.

## The producer: run(ctx)

`run` is the one genuinely new concept in wolli, which is otherwise pull/request-response. It opens a connection or loop and pushes inbound items out as events. The host calls `run` once per `(service, account)` after the account validates.

```typescript
interface IntegrationRunContext {
  account: unknown;                       // resolved + validated against config.account
  emit(event: string, data: unknown): void; // validated against config.events[event]
  store: KeyValueStore;                   // durable per-service runtime state
  signal: AbortSignal;                    // aborted on stop(); one run() per (service, account)
}
```

`emit` is fire-and-forget and never throws back into `run()`: an invalid payload (or a throwing listener) is captured by the host error sink, not raised at the emit call site. You do not need `try`/`catch` around `emit` for validation.

Lifecycle:

```
account validated
  └─► run(ctx) called
        ├─ opens a connection / starts a timer loop
        ├─ per inbound item: ctx.emit("<event>", data)
        └─ returns a disposer  () => void   (optional)

/reload  or  shutdown
  ├─► ctx.signal aborts   (listen for cleanup)
  └─► the returned disposer is called
```

`run` may return a disposer function (sync or via a Promise). Wire teardown to **both** the returned disposer and a `ctx.signal` abort listener — a reload stops the old producer before starting the new one, and both paths must release the transport (the Telegram producer relies on this to avoid Telegram's 409 "two pollers on one token" conflict).

> The disposer must be idempotent. On stop the host aborts `ctx.signal` (firing your abort listener) AND calls the returned disposer — so any teardown wired to both paths runs twice. `clearInterval` is naturally idempotent; for a stateful teardown (e.g. a long-poll runner) guard it, as the Telegram producer does with `if (runner?.isRunning()) void runner.stop();`.

```typescript
run(ctx) {
  const timer = setInterval(() => ctx.emit("tick", { at: Date.now() }), 1000);
  const dispose = () => clearInterval(timer);
  ctx.signal.addEventListener("abort", dispose);
  return dispose;
}
```

> **Do not await a non-resolving runner.** If your transport runs a loop that never resolves (e.g. a long-poll runner), start it fire-and-forget and capture the handle for the disposer — never `await` it, or `run` never returns.

## Durable state: ctx.store

`ctx.store` is a string-keyed `KeyValueStore` for machine-written runtime state, scoped to one service and backed by `~/.wolli/agents/<name>/store/<service>.json`. It is process-scoped and survives `/reload`. Use it where an integration keeps state it owns (the scheduler keeps its jobs here).

```typescript
interface KeyValueStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  getAll(): Record<string, unknown>;
  delete(key: string): void;
}
```

`get` returns `unknown`; cast to your stored shape at the boundary. The same store is reachable from `run` (`ctx.store`) and from action handlers (`ctx.store`), so a producer and its CRUD actions share one durable view — the scheduler's actions write jobs that its `run` loop reads each tick.

## Actions

Actions are callable request/response functions — the talk-back surface. Each is a `ToolDefinition`-shaped object minus the params generic: a `parameters` schema plus an `execute` validated at the boundary.

```typescript
interface IntegrationAction {
  description?: string;
  parameters: TSchema;
  execute(params: unknown, ctx: IntegrationActionContext): Promise<unknown>;
}

interface IntegrationActionContext {
  account: unknown;   // resolved + validated against config.account
  store: KeyValueStore;
  signal: AbortSignal;
}
```

`params` arrives validated against `parameters`; cast it to your typed shape inside `execute`. The return value is passed back to the caller of `.call(action, params)`. Use `ctx.account` to reach configured credentials and `ctx.store` for shared durable state.

```typescript
actions: {
  sendMessage: {
    description: "Send a text message to a chat.",
    parameters: Type.Object({ chatId: Type.Number(), text: Type.String() }),
    execute: async (params, ctx) => {
      const { chatId, text } = params as { chatId: number; text: string };
      const account = ctx.account as { botToken: string };
      // ... use account.botToken to send ...
      return { ok: true };
    },
  },
}
```

## Onboarding

`onboard(ctx)` is guided first-run setup. It auto-runs on `plugins install` for an unconfigured service when attached to a TTY, and on demand via `plugins configure <source>`. It returns **one** account record to persist, or `undefined` to cancel.

```typescript
interface IntegrationOnboardContext {
  ui: IntegrationOnboardUI;                  // select / confirm / input / notify only
  resolve: typeof resolveConfigValueUncached; // test a $ENV / ${ENV} / !cmd reference live
  signal: AbortSignal;
}

type IntegrationOnboardUI = Pick<ExtensionUIContext, "select" | "confirm" | "input" | "notify">;
```

The `ui` surface is narrowed to the four dialog primitives. Chat chrome (editors, widgets, custom components) is excluded because onboarding dialogs serialize to attached clients over the wire; calling anything outside this set is a compile error, not a silent no-op.

```typescript
ui.select(title: string, options: string[], opts?): Promise<string | undefined>;
ui.confirm(title: string, message: string, opts?): Promise<boolean>;
ui.input(title: string, placeholder?: string, opts?): Promise<string | undefined>;
ui.notify(message: string, type?: "info" | "warning" | "error"): void;
```

`select` and `input` resolve to `undefined` when the user cancels (escape) — branch on it to abort onboarding by returning `undefined`. `confirm` resolves to a boolean. `notify` is fire-and-forget.

What the host does with the returned record:

```
onboard(ctx) returns record  (or undefined → cancelled)
  └─► host resolves each string field ($ENV / !cmd)
        └─► validates the resolved record against config.account
              └─► persists ONLY if valid → integrations.json ("<service>" → "default")
```

Record values may be raw secrets or `$ENV` / `${ENV}` / `!cmd` references. `integrations.json` is written `0o600`. `ctx.resolve` lets `onboard` test a credential before returning it (e.g. resolve a `$TOKEN` reference and make a verifying API call). Returning a record whose resolved form fails the `account` schema is reported as an error and nothing is persisted.

```typescript
async function onboard(ctx: IntegrationOnboardContext): Promise<{ botToken: string } | undefined> {
  const entered = await ctx.ui.input("Paste the bot token");
  if (entered === undefined) return undefined; // cancelled
  const token = entered.trim();
  if (!token) {
    ctx.ui.notify("No token entered.", "error");
    return undefined;
  }
  // ... verify token with a live call here ...
  return { botToken: token };
}
```

An integration with no secret still benefits from a trivial `onboard` that returns `{}` — that writes the `"<service>.default"` account so `run` starts. (The scheduler does exactly this.)

## Consuming an Integration

The mapping half is an ordinary extension. It reaches the transport through `wolli.getIntegration(name, account?)`, which returns an `IntegrationHandle`. `account` defaults to `"default"`.

```typescript
interface IntegrationHandle {
  on(event: string, handler: (data: unknown) => void | Promise<void>): () => void; // returns unsubscribe
  call(action: string, params?: unknown): Promise<unknown>;
}
```

- `.on(event, handler)` subscribes to a producer event and returns an unsubscribe function. `data` is `unknown`; cast it to the event's payload shape. Events are delivered only to listeners attached at emit time; there is no buffering. An event emitted before any extension has called `.on` for it is dropped. For a producer that emits a catch-up batch on start, this means events fired before the paired extension subscribes are missed — design the producer to (re)emit on the next cycle rather than assume a subscriber exists at the first tick.
- `.call(action, params)` invokes an action; `params` is validated against the action's schema before `execute` runs, and the resolved return value comes back. When an action takes no parameters (schema `Type.Object({})`), call it as `.call("action")` with `params` omitted — the host substitutes `{}` before validation.

> **Onboard before you consume.** `getIntegration(name, account)` **throws if the integration or account is not configured**. Extensions call it at the factory top (load time), so an unconfigured account surfaces as a per-extension load error caught by the host — the mapping extension fails to load until the account exists. This is why the install/configure flow onboards the account before the paired extension activates (on the next launch). There is no deferred handle that silently defers the throw.

```typescript
import type { ExtensionAPI } from "@opsyhq/wolli";

export default function (wolli: ExtensionAPI) {
  const tg = wolli.getIntegration("telegram", "default"); // throws if telegram.default not configured

  tg.on("message", async (data) => {
    const m = data as { chatId: number; text: string };
    // ... map the event onto a session ...
  });

  await tg.call("sendMessage", { chatId: 123, text: "hi" });
}
```

Two surfaces exist but the shipped plugins use neither, so they are noted as available rather than demonstrated here: `IntegrationOnboardContext` threads a `resolve` field (a live `$ENV`/`!cmd` resolver for testing a credential mid-onboarding), and `IntegrationsAPI.unregisterIntegration(name)` tears a definition back down. The shipped plugins register one static service at load and never call `unregisterIntegration`.

## The dual-half package

A shipped integration is one package declaring both halves under its package.json `"wolli"` key:

```json
{
  "name": "wolli-integration-telegram",
  "type": "module",
  "wolli": {
    "integrations": ["./index.ts"],
    "extensions": ["./telegram-chat.ts"]
  },
  "dependencies": { "grammy": "1.44.0", "@grammyjs/runner": "2.0.3" },
  "peerDependencies": { "@opsyhq/wolli": "*" }
}
```

`"integrations"` lists the transport module(s); `"extensions"` lists the mapping module(s). A single `plugins install` installs the package once. The paired extension is **resolved in place by the package manager from that same install** — it is not copied into the agent's `extensions/` folder. After onboarding configures the account, the mapping extension activates on the next launch.

Why the split is load-bearing: the transport (`index.ts`) never touches sessions or the agent; the extension (`*-chat.ts`) owns the mapping between the external thread and a Wolli session. Swapping the mapping is an extension change; the transport is untouched.

## Installing and configuring

The CLI verb is `plugins`, and **the agent name precedes the verb**:

```bash
wolli <agent> plugins install <source>      # install + auto-onboard (on a TTY)
wolli <agent> plugins configure <source>    # re-run guided setup (requires a TTY)
wolli <agent> plugins list                  # list installed plugins + contributed integrations
wolli <agent> plugins remove <source>       # remove the plugin
wolli <agent> plugins update [source]       # update one or all plugins
```

Sources:

| Form | Example |
|------|---------|
| local | `wolli <agent> plugins install ./plugins/telegram` |
| npm | `wolli <agent> plugins install npm:@scope/pkg` |
| git | `wolli <agent> plugins install git:github.com/user/repo` |

On `install`, if the plugin's integration declares `onboard` and the terminal is interactive, guided setup runs immediately (rendered in a startup TUI over the daemon's UI round-trip). When headless, install points you at `plugins configure <source>` to set it up later. `configure` re-runs the guided setup even when the account already exists, and requires an interactive terminal.

## Error Handling

Integration errors ride the same sink as extension errors (`IntegrationError` mirrors `ExtensionError`), so they surface alongside extension load/runtime errors.

Failure modes to design for:

- **Producer-side errors.** Swallow transient transport failures inside `run` so a single poll/tick failure cannot crash the host. The Telegram producer installs a `bot.catch(...)` and logs; a hard throw out of `run` becomes a load error.
- **Action errors.** Throwing from an action's `execute` rejects the consumer's `.call(...)` Promise. Catch around `.call` in the mapping extension and degrade (log, retry, or surface to the agent) rather than letting the rejection escape a fire-and-forget callback.
- **Listener errors.** A throwing or rejecting `.on(event, handler)` is caught by the host and reported on the same error sink (it never crashes the producer), so an unguarded async `on`-handler is safe — though catching to degrade gracefully is still good practice.
- **Unconfigured account.** `getIntegration` throws at extension load if the account is missing — this is the onboard-before-consume ordering above, surfaced as a per-extension load error, not a runtime exception during an event.
- **Validation.** `ctx.emit` validates payloads against `events[event]`, `.call` validates params against the action schema, and onboarding validates the resolved record against `account`. A schema mismatch is reported, not silently dropped.

## Worked example: Telegram (bidirectional chat)

The Telegram plugin is the canonical dual-half integration. The transport (`index.ts`) long-polls grammY, holds the bot token, and emits a `message` event per inbound message. It exposes `sendMessage`, `sendChatAction`, and `setCommands` actions. The mapping (`telegram-chat.ts`) routes each message into a per-chat Wolli session and ships the reply back.

The transport — events, an action, onboarding, and the long-poll producer:

```typescript
import { run } from "@grammyjs/runner";
import type { IntegrationOnboardContext, IntegrationsAPI } from "@opsyhq/wolli";
import { Bot } from "grammy";
import { Type } from "typebox";

interface TelegramAccount {
  botToken: string;
  allowedChatIds?: number[];
  parseMode?: "MarkdownV2" | "HTML" | "plain";
}

async function onboard(ctx: IntegrationOnboardContext): Promise<{ botToken: string } | undefined> {
  const entered = await ctx.ui.input("Paste the bot token from BotFather");
  if (entered === undefined) return undefined;
  const token = entered.trim();
  if (!token) {
    ctx.ui.notify("No token entered.", "error");
    return undefined;
  }
  try {
    const me = await new Bot(token).api.getMe();
    ctx.ui.notify(`Verified bot @${me.username}.`, "info");
  } catch (err) {
    ctx.ui.notify(`Could not verify the token: ${err instanceof Error ? err.message : String(err)}`, "error");
    return undefined;
  }
  return { botToken: token };
}

export default function (wolli: IntegrationsAPI) {
  wolli.registerIntegration({
    name: "telegram",
    account: Type.Object({
      botToken: Type.String(),
      allowedChatIds: Type.Optional(Type.Array(Type.Number())),
      parseMode: Type.Optional(Type.Union([Type.Literal("MarkdownV2"), Type.Literal("HTML"), Type.Literal("plain")])),
    }),
    events: {
      message: Type.Object({
        chatId: Type.Number(),
        messageId: Type.Number(),
        text: Type.String(),
        from: Type.Object({ id: Type.Number(), username: Type.Optional(Type.String()) }),
        chatType: Type.String(),
        date: Type.Number(),
      }),
    },
    onboard,
    actions: {
      sendMessage: {
        description: "Send a text message to a chat.",
        parameters: Type.Object({
          chatId: Type.Number(),
          text: Type.String(),
          replyToMessageId: Type.Optional(Type.Number()),
        }),
        execute: async (params, ctx) => {
          const { chatId, text } = params as { chatId: number; text: string };
          const account = ctx.account as TelegramAccount;
          const sent = await new Bot(account.botToken).api.sendMessage(chatId, text);
          return { messageIds: [sent.message_id] };
        },
      },
    },
    run(ctx) {
      const { botToken } = ctx.account as TelegramAccount;
      const bot = new Bot(botToken);

      bot.on("message:text", (c) => {
        if (c.from?.id === c.me.id) return; // ignore our own messages
        ctx.emit("message", {
          chatId: c.chat.id,
          messageId: c.msg.message_id,
          text: c.msg.text,
          from: { id: c.from?.id ?? 0, username: c.from?.username },
          chatType: c.chat.type,
          date: c.msg.date,
        });
      });

      bot.catch((err) => console.error("[telegram] bot error:", err.message));

      // Fire-and-forget: never await the runner (it never resolves).
      let runner: ReturnType<typeof run> | undefined;
      void bot.api.deleteWebhook({ drop_pending_updates: true }).then(() => {
        if (ctx.signal.aborted) return;
        runner = run(bot);
      });

      const dispose = () => {
        if (runner?.isRunning()) void runner.stop();
      };
      ctx.signal.addEventListener("abort", dispose);
      return dispose;
    },
  });
}
```

The mapping — bind each chat to its own session via a tag, route inbound text in, ship the reply back on `agent_end`:

```typescript
import type { ExtensionAPI } from "@opsyhq/wolli";

interface TelegramMessage {
  chatId: number;
  text: string;
}

export default function (wolli: ExtensionAPI) {
  const tg = wolli.getIntegration("telegram", "default");

  // inbound: route each message into its chat's own session.
  tg.on("message", async (data) => {
    const m = data as TelegramMessage;
    const chatTag = { "telegram:chat": String(m.chatId) };
    const [match] = await wolli.findSessions(chatTag);
    const session = match
      ? await wolli.openSession(match.id)
      : await wolli.createSession({
          setup: async (sessionManager) => {
            await sessionManager.appendTags(chatTag);
          },
        });
    // followUp queues cleanly if a turn is already in flight.
    void session.sendUserMessage(m.text, { deliverAs: "followUp" });
  });

  // outbound: the reply rides the PRODUCING session's tag, so it returns to the
  // chat that started this turn — not whoever messaged last.
  wolli.on("agent_end", async ({ messages }, ctx) => {
    const chat = ctx.session.getTags()["telegram:chat"];
    if (!chat) return; // not a telegram-bound session
    const text = finalAssistantText(messages); // last assistant text; "" for a pure tool-call turn
    if (!text) return;
    await tg.call("sendMessage", { chatId: Number(chat), text });
  });
}
```

Key mechanics:
- **Session binding via tags.** Each chat gets its own session, bound by `{ "telegram:chat": <id> }`. `findSessions(tag)` locates it; `createSession({ setup })` lazily creates and tags a fresh one through the `SessionManager.appendTags(...)` call. Two chats run in parallel.
- **Reply routing.** `agent_end` reads the tag off the **producing** session (`ctx.session.getTags()`), so the answer returns to the chat that started the turn.
- **Delivery.** `sendUserMessage(text, { deliverAs: "followUp" })` queues mid-stream messages cleanly instead of interrupting.

## Worked example: Scheduler (timer to wake)

The scheduler plugin is a producer with no secret. Its transport (`index.ts`) owns the jobs (persisted in `ctx.store`), ticks a coarse timer, and emits `due` when a job's time arrives. CRUD actions (`addJob`, `listJobs`, `updateJob`, `removeJob`, `runJob`) let the agent manage jobs. The mapping (`scheduler-chat.ts`) registers a `cron` tool over those actions and, on `due`, wakes the originating session.

The transport — `ctx.store`-backed jobs, an action, a no-secret onboard, and the tick loop:

```typescript
import { randomUUID } from "node:crypto";
import type { IntegrationOnboardContext, IntegrationsAPI, KeyValueStore } from "@opsyhq/wolli";
import { type Static, Type } from "typebox";

const Schedule = Type.Union([
  Type.Object({ kind: Type.Literal("at"), at: Type.Number() }),
  Type.Object({ kind: Type.Literal("every"), everyMs: Type.Number() }),
  Type.Object({ kind: Type.Literal("cron"), expr: Type.String(), tz: Type.Optional(Type.String()) }),
]);
type Schedule = Static<typeof Schedule>;

interface Job {
  id: string;
  prompt: string;
  schedule: Schedule;
  enabled: boolean;
  originTags?: Record<string, string>;
  nextRunAt: number;
}

function loadJobs(store: KeyValueStore): Record<string, Job> {
  return (store.get("jobs") as Record<string, Job> | undefined) ?? {};
}

// No secret: writing an empty account is enough for run() to start.
async function onboard(ctx: IntegrationOnboardContext): Promise<Record<string, unknown>> {
  ctx.ui.notify("Scheduler enabled.", "info");
  return {};
}

export default function (wolli: IntegrationsAPI) {
  wolli.registerIntegration({
    name: "scheduler",
    account: Type.Object({ tickMs: Type.Optional(Type.Number()) }),
    events: {
      due: Type.Object({
        id: Type.String(),
        prompt: Type.String(),
        originTags: Type.Optional(Type.Record(Type.String(), Type.String())),
        name: Type.Optional(Type.String()),
      }),
    },
    onboard,
    actions: {
      addJob: {
        description: "Schedule a new job from a prompt and a schedule.",
        parameters: Type.Object({
          prompt: Type.String(),
          schedule: Schedule,
          originTags: Type.Optional(Type.Record(Type.String(), Type.String())),
        }),
        execute: async (params, ctx) => {
          const p = params as { prompt: string; schedule: Schedule; originTags?: Record<string, string> };
          const job: Job = {
            id: randomUUID(),
            prompt: p.prompt,
            schedule: p.schedule,
            enabled: true,
            originTags: p.originTags,
            nextRunAt: p.schedule.kind === "at" ? p.schedule.at : Date.now() + 1000,
          };
          const jobs = loadJobs(ctx.store);
          jobs[job.id] = job;
          ctx.store.set("jobs", jobs);
          return { id: job.id, nextRunAt: job.nextRunAt };
        },
      },
    },
    run(ctx) {
      const { tickMs } = ctx.account as { tickMs?: number };
      const tick = () => {
        const now = Date.now();
        const jobs = loadJobs(ctx.store);
        const due: Job[] = [];
        for (const job of Object.values(jobs)) {
          if (!job.enabled || job.nextRunAt > now) continue;
          if (job.schedule.kind === "at") job.enabled = false; // one-shot
          due.push(job);
        }
        if (due.length === 0) return;
        // Persist the advanced state BEFORE emitting, so a crash right after never re-fires.
        ctx.store.set("jobs", jobs);
        for (const job of due) {
          ctx.emit("due", { id: job.id, prompt: job.prompt, originTags: job.originTags });
        }
      };
      tick(); // one catch-up tick on start
      const timer = setInterval(tick, tickMs ?? 60_000);
      const dispose = () => clearInterval(timer);
      ctx.signal.addEventListener("abort", dispose);
      return dispose;
    },
  });
}
```

The mapping — a `cron` tool over the CRUD actions, and a `due` handler that wakes the origin session:

```typescript
import type { ExtensionAPI } from "@opsyhq/wolli";
import { Type } from "typebox";

export default function (wolli: ExtensionAPI) {
  const sched = wolli.getIntegration("scheduler", "default");

  wolli.registerTool({
    name: "cron",
    label: "Cron",
    description: "Schedule prompts to run later (add / list / update / remove / run).",
    parameters: Type.Object({
      action: Type.String(),
      prompt: Type.Optional(Type.String()),
      at: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "add" && params.prompt && params.at !== undefined) {
        // Snapshot the scheduling session's tags so the fired result returns to this surface.
        const result = await sched.call("addJob", {
          prompt: params.prompt,
          schedule: { kind: "at", at: params.at },
          originTags: ctx.session.getTags(),
        });
        return { content: [{ type: "text", text: "Scheduled." }], details: result };
      }
      return { content: [{ type: "text", text: "Unsupported action." }], details: {} };
    },
  });

  sched.on("due", async (data) => {
    const job = data as { prompt: string; originTags?: Record<string, string> };
    // Run the prompt in the newest session matching the origin tags. A telegram-tagged
    // origin → telegram's own agent_end ships the reply to that chat; no scheduler-side
    // channel handling. Create a SAME-tagged session if none matches, never an untagged one.
    const [match] = await wolli.findSessions(job.originTags ?? {});
    const session = match
      ? await wolli.openSession(match.id)
      : await wolli.createSession({
          setup: async (sessionManager) => {
            await sessionManager.appendTags(job.originTags ?? {});
          },
        });
    await session.sendUserMessage(job.prompt, { deliverAs: "followUp" });
  });
}
```

Key mechanics:
- **Producer owns durable state.** Jobs live in `ctx.store` under one key (`"jobs"`); the tick loop and the CRUD actions share that view. State is persisted **before** `emit`, so a crash right after firing never double-fires (at-most-once).
- **Tag-routed delivery, no channel coupling.** `addJob` snapshots the scheduling session's tags as `originTags`. When the job fires, the prompt runs in the newest session matching those tags — so a telegram-tagged origin gets its reply shipped by telegram's own `agent_end`, with no scheduler-side special-casing.
- **No secret.** Onboarding writes an empty `{}` account so `run` starts; the agent schedules its own jobs through the `cron` tool.
