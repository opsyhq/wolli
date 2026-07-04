# Providers

Add model providers the agent can run on: a proxy, a self-hosted endpoint, or an API wolli does not ship.

A provider registers models the agent can run on, beyond the built-in catalog. Use one when the models you want live behind a proxy, a self-hosted endpoint, or a provider wolli does not ship; built-in models need no provider file. Each provider is one file under `providers/` in the agent home, default-exporting `defineProvider`. The provider name comes from the filename. wolli loads providers once at startup; there is no dynamic registration.

## Defining a provider

A proxy that fronts the Anthropic API and serves one model:

`~/.wolli/agents/assistant/providers/my-proxy.ts`

```ts
import { defineProvider } from "wolli";

export default defineProvider({
  baseUrl: "https://proxy.example.com",
  apiKey: "$PROXY_API_KEY",
  api: "anthropic-messages",
  models: [
    {
      id: "claude-sonnet-4-20250514",
      name: "Claude 4 Sonnet (proxy)",
      reasoning: false,
      input: ["text", "image"],
      // Per-token cost, used for usage tracking; 0 is fine for a proxy.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384,
    },
  ],
});
```

When `models` is set, it replaces any existing models for that provider name, and `baseUrl`, `apiKey`, and `api` become required (`api` at the provider or model level). Each model carries its own `contextWindow` and `maxTokens`, so wolli sizes context and output correctly even when the endpoint is yours.

## Credentials

`apiKey` accepts three forms. `$PROXY_API_KEY` or `${PROXY_API_KEY}` reads an environment variable, a leading `!` runs a shell command and uses its output (`"!op read op://vault/proxy-key"`), and any other string passes through as a literal key. Do not put raw keys in provider files; reference the environment or a secret manager command instead.

For endpoints that expect extra request headers, set `headers`; `authHeader: true` adds an `Authorization: Bearer` header carrying the resolved key.

## Overriding an existing provider

A file that sets only `baseUrl` redirects an existing provider instead of defining a new one. The filename names the target: `providers/anthropic.ts` overrides the `anthropic` provider, and its built-in models keep their ids, costs, and limits while requests go to the new endpoint. Use this to route traffic through a gateway or a regional mirror.

`~/.wolli/agents/assistant/providers/anthropic.ts`

```ts
import { defineProvider } from "wolli";

export default defineProvider({ baseUrl: "https://proxy.example.com" });
```

## OAuth providers

A provider with an `oauth` block authenticates through a login flow instead of a static key, which is what lets you sign in to a corporate gateway with SSO rather than pasting a token. The block gives the provider a display name for the login UI and three functions: `login` runs the flow and returns credentials to persist, `refreshToken` renews them when they expire, and `getApiKey` converts the stored credentials into the key sent on each request. When `oauth` is present, `apiKey` is optional.

## What to read next

- [Introduction](./introduction.md): the agent home and how capability folders load.
- [Workflows](./workflows.md): route events into sessions and automate the agent.
- [Tools](./tools.md): author tools the agent calls during a turn.
