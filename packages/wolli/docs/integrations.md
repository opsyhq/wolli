# Integrations

The transport between a platform and your agent: credentials, inbound events, and callable actions.

An integration is a transport that connects your agent to an outside platform (Telegram, Discord, an internal API). It faces the network, holds the credentials, turns platform activity into events, and exposes actions that talk back. It does **not** route: an integration never reaches a session and never decides what the agent does with an event. Workflows own that; the integration's job ends at the wire.

## The integration file

Integrations live under `integrations/` in the agent home, one service per file. The file basename is the service name, so `integrations/telegram.ts` registers `telegram`. The definition is the module's default export:

```typescript
// ~/.wolli/agents/assistant/integrations/telegram.ts
import { defineIntegration } from "wolli";
import { Type } from "typebox";

const telegram = defineIntegration({
  account: Type.Object({ botToken: Type.String() }),
  events: {
    message: Type.Object({ chatId: Type.Number(), text: Type.String() }),
  },
  actions: {
    sendMessage: {
      description: "Send a text message to a chat.",
      parameters: Type.Object({ chatId: Type.Number(), text: Type.String() }),
      async execute(params, ctx) {
        // ctx.account is the resolved record; params arrive validated.
        // Send through the Bot API and return the sent message ids.
      },
    },
  },
  async run(ctx) {
    // Open a grammY long-poll connection with ctx.account's botToken.
    // Per inbound text message:
    //   ctx.emit("message", { chatId: msg.chat.id, text: msg.text });
    // Return a disposer that stops the poller; ctx.signal aborts on reload.
    return () => {
      /* stop the poller */
    };
  },
});

export default telegram;
```

The exported value is more than configuration. It is a typed handle other files import: a workflow binds an event with `telegram.on("message", run)` and calls `sendMessage` through `ctx.integration(telegram)`.

## Accounts and onboarding

Credentials live outside the code, in `integrations.json` in the agent home. The file maps each service to its ONE account record; onboarding writes it.

`~/.wolli/agents/assistant/integrations.json`

```json
{
  "telegram": { "botToken": "$TELEGRAM_BOT_TOKEN" }
}
```

Record values may be raw secrets or `$ENV`, `${ENV}`, or `!cmd` references. wolli resolves references on read, validates the resolved record against the `account` schema, and hands it to `run` and to actions as `ctx.account`. A record that fails the schema is reported and never reaches your code. The file is written `0o600`.

A second account is a second integration file: `telegram-work.ts` is the service `telegram-work`, with its own record, its own store, and its own producer, and workflows import the instance they mean. An integration that needs dynamic multi-tenancy models it inside its own account schema — an array of tenants, `onboard` collects them, `run` opens one connection per entry.

`onboard(ctx)` is guided first-run setup. It runs on `plugins install` for an unconfigured service, or on demand via `plugins configure` (see [Plugins](./plugins.md)). It returns one account record to persist, or `undefined` to cancel. `ctx.ui` carries exactly four dialog primitives, `select`, `confirm`, `input`, and `notify`, because onboarding dialogs serialize to attached clients over the wire. The telegram service collects and verifies the token:

```typescript
async onboard(ctx) {
  const token = await ctx.ui.input("Paste the bot token from BotFather");
  if (token === undefined) return undefined; // cancelled
  // Verify with a live getMe() call before returning.
  return { botToken: token.trim() };
},
```

`ctx.resolve` resolves a `$ENV` or `!cmd` reference to its live value, so onboarding can test a credential before persisting the reference.

## Events

`events` maps each event name to a TypeBox payload schema. Inside `run`, the producer publishes with `ctx.emit("message", data)`, and wolli validates `data` against the declared schema at that boundary. An invalid payload is dropped and reported on the error sink; it is never delivered. `emit` never throws back into the producer, so no `try`/`catch` is needed around it.

The definition exposes each event two ways: `telegram.on("message", run)` binds it to a workflow directly, and `telegram.events.message` is the inert descriptor it funnels through — data carrying the service, the event name, and the payload type. Either way the handler's payload is typed from the schema. See [Workflows](./workflows.md) for triggers.

## Actions

An action is a callable request/response function: a `parameters` schema plus `execute(params, ctx)`. wolli validates `params` against the schema before `execute` runs, so the body receives checked input. `ctx` carries the resolved `account`, the durable `store`, and an abort `signal`. Return serializable data; it flows back to the caller.

Actions are not callable on the definition itself. A workflow calls them through the typed handle:

```typescript
// inside a workflow handler
const tg = ctx.integration(telegram);
await tg.sendMessage({ chatId: 123456789, text: "Deployed." });
```

Transport state that must live in memory belongs in actions too. Telegram's typing indicator expires after a few seconds, so keeping it visible for a whole turn means re-sending it on an interval. The integration owns that as a `startTyping`/`stopTyping` action pair managing the timer internally; a workflow calls `startTyping` when a turn begins and `stopTyping` when it ends, and never holds the timer itself. Workflow files must not rely on module state; in-memory coordination lands in the integration.

## The producer run(ctx)

`run` is the long-lived half. It opens a connection or a timer loop and pushes each inbound item out with `ctx.emit`. wolli calls `run` once per configured integration, after its account record validates: one producer per integration.

`run` may return a disposer. On reload or shutdown wolli aborts `ctx.signal` and calls the disposer, so wire teardown to both paths and make it idempotent; both fire on every stop. A reload stops the old producer before starting the new one, which is what keeps a single poller on the token. Do not `await` a loop that never resolves; start it fire-and-forget and keep the handle for the disposer.

## Durable state

`ctx.store` is a string-keyed key-value store scoped to the service and backed by `store/<service>.json` in the agent home. It survives reloads. `get` returns `unknown`; cast at the boundary:

```typescript
const cursor = ctx.store.get("cursor") as number | undefined;
ctx.store.set("cursor", lastUpdateId);
```

The same store is reachable from `run` and from every action, so the producer and its actions share one durable view. Use it for machine-written transport state (a resume cursor, a job list), not for routing state; routing rides session tags, which belong to workflows.

## Integration or workflow

| Need | Use |
| --- | --- |
| Hold a credential and call a platform API | An integration action |
| Turn inbound traffic into events | The integration's `run` loop |
| Decide which session receives a message | A workflow |
| Send the agent's reply back to a chat | A workflow calling an integration action |
| An in-memory timer shared across turns | An integration action pair |
| Machine-written state that survives reloads | `ctx.store` |

If the code needs a session, it is a workflow. If it needs the token, it lands in the integration.

## What to read next

- [Workflows](./workflows.md): triggers, `ctx.integration`, and routing events into sessions
- [Plugins](./plugins.md): installing packaged integrations and running onboarding
- [Tools](./tools.md): capabilities the model calls inside a session
