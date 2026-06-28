# What is my purpose?

```
$ wolli new calories
agent: What is my purpose?
you:   Help me count calories and lose weight.
```

That answer becomes the agent's purpose — for life. It doesn't reset between
conversations. It remembers, follows up, runs scheduled check-ins, and works
toward its purpose until you retire it.

## What makes an wolli agent different

- **Born with a purpose.** An agent is created *for* something, stated by its
  human at birth. Purpose is the organizing principle: it shapes what the agent
  remembers, when it speaks up, and what it does unattended.
- **Persistent.** Sessions are an append-only record tree — the agent's lifetime
  memory. Nothing is rewritten; context is reconstructed deterministically.
  An agent's lifetime is measured in months, not chat sessions.
- **Always on.** A local daemon and a cloud brain (Cloudflare) stay in full
  bidirectional sync, so the agent acts on schedules and inbound events even
  when your machine is off.
- **Its own machine, not yours.** The agent lives in its own sandboxed
  workspace (container locally, hosted sandbox in the cloud). Touching the
  user's actual machine is an explicit, approval-gated escalation.
- **Addressable.** Agents are peers with handles and hosted email identity:
  `wolli message @calories "log: two eggs, toast"`. Agent-to-agent messaging
  and A2A interop are part of the frame, not bolt-ons.
