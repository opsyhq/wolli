# Integration

> An opsy agent is not a chat session (MISSION). It does not sit waiting for a
> human to speak. It is *woken* — by an integration — runs headless, acts, and
> goes back to sleep. It speaks to a human only if it decides to, in a session
> it opens itself.

This doc designs **how an agent is reached and woken** — the concrete shape of
"always on," "addressable," and "proactive" (README) and of pluggable
integrations (MISSION, Belief #5/#6/#8). It does not design the memory model
(the append-only record tree) or the agent loop; it designs the *source* of the
events those react to.

## 1. Two primitives

- **Integration** — the always-on transport. It lives in the always-on plane
  (the local daemon and the Cloudflare cloud brain that stays up when your
  machine is off), not inside any agent session. It holds the credentials,
  faces the network, owns the hosted email identity, and *makes sounds*: email,
  WhatsApp, a webhook, a peer message, the clock. It delivers; it does not
  interpret.

- **Extension** — the agent's own ear. **You must listen with an extension to be
  woken by an integration**, and the extension is where the agent *defines how
  it wakes*: which integration it cares about, into which session the signal
  lands, how that signal becomes the event the agent acts on. Ships as a default
  per integration; the agent rewrites it the same way it builds any other
  extension (Belief #5).

```
integration ──makes a sound──▶ a session is born ──▶ extension turns the signal
 (always-on plane:             (a node in the          into the event the agent acts on
  daemon / cloud brain)         record tree)                     │
                                      │                           ▼
                                      └──────────▶ agent acts, records, sleeps
                                                        │
                                                        └─ may open a human-facing
                                                           session, if it chooses
```

## 2. There is no lifecycle gap

The objection that sinks naive designs: *the extension only exists inside a
session, but the integration fires when no session is running.* False
dichotomy. The firing **is** what creates the session. A sound arrives → the
agent is reconstituted from its record tree into a fresh session → the
extension, alive in that session from birth, turns the signal into the event.
There was never a gap to bridge: **an inbound event is a session being born.**

## 3. Integration — the always-on half

A durable, credentialed, network-facing transport. The platform runs it; the
agent plugs into it. Properties that matter:

- It is the **only** always-on, internet-facing component, and the **only**
  holder of network secrets (HMAC, OAuth tokens, the hosted mailbox). The agent
  isn't running until a sound has already been received and authenticated — so
  the model never sits on the network edge.
- It **makes sounds and nothing more.** It does not route by purpose, decide
  which agent cares, or shape payloads. Delivery, not judgment.
- It belongs in the always-on plane by definition: the cloud brain holds it open
  so the agent reacts to inbound events *even when your machine is off* (README,
  Belief #8).
- **Curated, small, shipped.** Email (the hosted identity) · WhatsApp · peer/A2A
  messages · time (a schedule integration whose "sound" is the clock) · and the
  **generic webhook** — anything that can POST. The generic one is the escape
  hatch: it keeps the set small while the long tail of "I need a new trigger"
  lands in *extensions*, not new transports.

## 4. Extension — the agent-owned ear

An agent-authored adapter that subscribes to an integration and defines the
wake. It plays **two roles against one integration**:

1. **At configure-time** (running in a session): it *declares its subscription*
   — which integration, what to wake on, into which session/handle, how to shape
   the signal. The declaration persists; it is part of the agent, versioned with
   it inside the agent-owned workspace.
2. **At wake-time**: the *same* extension is the code that turns the delivered
   payload into the event the agent acts on.

It ships as a sensible default per integration, and the agent customizes it
through the ordinary extension mechanism. **There is no second plugin system** —
reachability is configured the same way as everything else the agent builds
about itself. Without a subscribed extension, an integration's sounds are inert:
you must listen to be woken.

## 5. Headless is the default; human contact is chosen

- **Default path: woken → act → sleep.** No human in the loop, start to finish.
  This is the normal case (Belief #6: act unattended; "not only respond to
  prompts"), not a special one.
- A **human-facing session is an output the agent chooses**, downstream of its
  own reasoning — never a precondition for it to run. If, mid-task, it decides it
  needs a person, *it* opens a human-facing session and starts that conversation.
- So the direction of initiation **flips** from the chatbot default. Not "human
  opens a session → agent answers." Instead: "**integration wakes the agent →
  agent acts → agent may wake a human.**" The agent is the active party in both
  directions: it gets woken, and it decides whether to wake anyone else.

## 6. The boundary is drawn by ownership

The split between the two primitives is **ownership**, not lifecycle:

| | Integration | Extension |
|---|---|---|
| owned by | platform | agent |
| lives in | always-on plane (daemon / cloud brain) | the agent's sandboxed workspace |
| lifetime | always on | born with the session |
| on the network edge | yes — holds secrets + mailbox | no — runs inside the sandbox |
| changes how? | curated, shipped, pluggable | agent-authored, versioned, revertable |

A free consequence: because the agent only ever authors the *extension*, its
self-modification **cannot reach the credentialed network edge** — by
construction, not by discipline. The dangerous, vetting-worthy surface stays
platform-owned; the infinitely-customizable surface stays with the agent.

## 7. Where this sits

This is the mechanism beneath three things the mission already asserts —
*always on*, *addressable*, *proactive* — made into one model. An integration is
how the agent is addressable (the hosted email identity is just the email
integration); the always-on plane is where integrations live; reacting to their
sounds is what proactive means. Agent-to-agent messaging (README: "part of the
frame, not bolt-ons") is then **just one more integration** — peer↔peer — under
this same split. None of it touches the memory model or the agent loop.

## 8. Deferred (explicitly not designed here)

- **Authorable integrations** — whether an agent may build a *new* always-on
  transport, not just customize extensions on shipped ones. Default stance:
  **no** — integrations stay curated; a new transport is a durable, credentialed
  daemon, and making those agent-authored drags the always-on / secret-holding /
  bootstrap problem back inside the trust line. The generic webhook covers the
  long tail. Revisit only if it actually bites.
- **Delivery mechanics** — queue, at-least-once, dedup, backpressure between an
  integration's sound and the session being born. Engineering, not design; its
  own doc when it bites.
- **Concurrency** — two sounds for one agent while a session is live. Lean:
  serialize per handle (one live session per handle at a time), consistent with
  deterministic reconstruction from the record tree. Detail deferred.

**Non-goals:** inventing a transport protocol · multi-tenant routing/fairness ·
putting the model on the network edge · designing the memory model or agent loop.

---
*Open: the minimal contract an extension declares at configure-time — the
smallest stable shape of "wake me, like this, into here" that survives the agent
rewriting everything around it. The next thing to nail.*
