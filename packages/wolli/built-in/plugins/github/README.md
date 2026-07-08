# GitHub

Connect a wolli agent to GitHub. The integration **polls** GitHub's REST API (wolli has no
inbound webhook surface), gives each issue/PR conversation its own wolli session, and replies
in place as comments. Auth is a **GitHub App** — no public URL, no webhook, no TLS.

## How the bot behaves

The transport polls each watched repo on a timer and emits a generic event per new item; the
routing workflows decide what to act on based on the triggers you pick during onboarding.

| Trigger | Behavior |
|---------|----------|
| **mention** | When a comment on an issue or PR @mentions the App (`@<app-slug>`), that conversation gets a wolli session and the comment (mention stripped) is delivered to the agent. The App reacts `eyes` on the summoning comment to acknowledge it. If the mention is on a **pull request**, the PR's head commit is checked out under the agent's `workspace/` (see below) and the agent reviews the real source tree with its own file tools. |
| **auto** | When a pull request is opened or updated, the PR is checked out and a "review this PR" turn is seeded into the PR's session. Deduped on head SHA, so the same commits are reviewed once. |

The agent's reply is posted back as a comment on the same issue/PR.

### PR checkout

For a pull request, the `checkoutPullRequest` action fetches the head + base commits (`--depth 1`,
by SHA) into `workspace/reviews/<owner>__<repo>__<number>/` under the agent home, checks out the
head detached, and **configures no remote**. So the agent gets the full source tree at the head
commit — it can `read`/`grep` any file and `git diff <base> <head>` to see the change — but there
is no push target and the App token is never written to disk (it is passed only to the one `fetch`,
inside the daemon process, never to the agent). The checkout is refreshed in place on later turns.

> Note: in the default `local-os` sandbox the agent's writes are jailed to the agent home but the
> network is not restricted, and the host may carry your own git credentials. Removing the remote
> makes `push` a deliberate act rather than a footgun; a hard read-only guarantee needs a
> network-jailed sandbox (`WOLLI_SANDBOX=docker` with egress control) or a reviewer without `bash`. Comments the App itself
authored (`<app-slug>[bot]`), comments by any Bot account, and comments carrying wolli's own
`<!-- wolli:github -->` marker are ignored, so the bot never answers itself.

### What is polled

Four cheap repo-level "since"-pollable streams, each with its own cursor and a conditional
(ETag) request so an unchanged poll returns `304` and does not count against the rate limit:

| Stream | Endpoint |
|--------|----------|
| `issue_comment` | `GET /repos/{o}/{r}/issues/comments?since=` |
| `pull_request_review_comment` | `GET /repos/{o}/{r}/pulls/comments?since=` |
| `issues` | `GET /repos/{o}/{r}/issues?since=` (PRs filtered out) |
| `pull_request` | `GET /repos/{o}/{r}/pulls?sort=updated` (deduped by head SHA) |

## Session model

Each issue/PR conversation gets its **own wolli session**, bound by a `github:thread` tag of
the form `owner/repo#number`:

- **Inbound** — an @mention routes to the session tagged for that conversation. If none exists,
  one is created and tagged on the spot. Histories never bleed across conversations.
- **Outbound** — the reply rides the producing session's tag, so the answer returns to the
  conversation that started the turn.

## Setup

### 1. Create a GitHub App

Open **Settings → Developer settings → GitHub Apps → New GitHub App** (personal:
https://github.com/settings/apps/new, or your org's equivalent).

- **Webhook:** clear the **Active** checkbox — this integration polls, it does not receive webhooks.
- **Repository permissions:** **Contents** read-only, **Issues** read & write, **Pull requests**
  read & write, **Metadata** read-only.
- Create the App, then under **Private keys** generate a key and download the `.pem`.
- Note the **App ID** shown on the App's settings page.
- **Install** the App (left sidebar → *Install App*) on the account/org that owns the repos you
  want to watch, and grant it those repositories.

> **Proposed: one-click App creation from a manifest.** GitHub can pre-configure an App from a
> [manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
> — the user clicks a single link, GitHub creates the App with the exact permissions below and
> **no webhook**, and hands back the App ID + private key automatically. This would replace the
> whole manual "create App → set permissions → uncheck webhook → generate key → copy App ID"
> dance above with a guided flow. Not yet implemented; the manifest POST-back needs a transient
> local callback, so it is tracked as a future onboarding enhancement.

### 2. Install and onboard in wolli

```bash
wolli <agent> plugins install ./built-in/plugins/github
```

On an interactive terminal this runs onboarding immediately. It asks for:

1. the **App ID**,
2. the **private key** — paste the PEM, or (recommended, since a PEM is multi-line) a reference
   like `$GITHUB_APP_PRIVATE_KEY` or `!cat /path/to/key.pem`,
3. the **repositories** to watch, comma-separated as `owner/repo, owner/repo`,
4. two yes/no **trigger** questions (react to @mentions? auto-review PRs?).

Wolli verifies the credentials with a live `GET /app`, reads the App slug as the bot login, and
validates that the App is installed on each repo (dropping any it is not). If you installed
non-interactively, onboard later with `wolli <agent> plugins configure github`.

### 3. Restart the agent

```bash
wolli restart <agent>
```

The poll producer starts on the next daemon start, so restart once for the bot to come online.

## Configuration reference

Configuration lives per agent in `~/.wolli/agents/<name>/integrations.json` under `github`:

```json
{
  "github": {
    "appId": "123456",
    "privateKey": "$GITHUB_APP_PRIVATE_KEY",
    "botLogin": "my-app",
    "repositories": ["acme/widgets", "acme/docs"],
    "triggers": ["mention", "auto"],
    "pollIntervalMs": 60000
  }
}
```

| Field | Required | Default | Purpose |
|-------|----------|---------|---------|
| `appId` | Yes | — | The GitHub App ID. |
| `privateKey` | Yes | — | The App's PEM private key. A `$ENV` / `!cmd` reference resolves on read. |
| `botLogin` | Yes | — | The App slug; used for @mention detection and self/loop filtering. Set by onboarding. |
| `repositories` | Yes | — | Repos to watch, as `owner/repo`. |
| `triggers` | Yes | — | Any of `"mention"`, `"auto"`. |
| `pollIntervalMs` | No | `60000` | Poll interval floor in ms. The effective interval also honors GitHub's `X-Poll-Interval`. |

## Not supported

- **Webhooks / real-time delivery** — the transport polls, so there is up to one poll interval
  of latency, and the daemon must be running to see activity (a restart resumes from the stored
  cursor, so nothing is lost while it was up).
- **True webhook `action`s** — the `issues` and `pull_request` streams carry a *best-effort*
  `action` (`opened` / `edited` / `closed` / `synchronize`) synthesized from state and
  timestamps; polling cannot see the exact webhook action.
- **`pull_request_review` and `push`** — no clean repo-level "since" cursor, so they are not polled.
- **Multi-line PEM in the input prompt** — paste a `$ENV` / `!cmd` reference instead.

## Security

- The App's private key grants control of the App — never commit it. Prefer a `$ENV` / `!cmd`
  reference over pasting the PEM. Wolli writes `integrations.json` with mode `0600`.
- The App only sees repos it was explicitly installed on and granted, scoped to the permissions
  above. Anyone who can comment on a watched repo can drive the agent via `@mention`.
