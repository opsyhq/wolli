# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.

## Local Development

- `wolli new` from a checkout registers a real boot-persistent launchd/systemd unit pointing at the checkout; set `WOLLI_SERVICE_MANAGER=none` in dev so daemons stay unsupervised.

## Clauses

1. Ask, don't assume. if something is unclear, ask before writing a single line. Never make silent assumptuions about intent, architecture, or requirements.
2. Simplest solution first. Always implement the simplest thing that could work. Do not add abstractions or flexibility that weren't explicitly requested.
3. Don't touch unrelated code. if a file or function is not directly part of the current task, do not modify it, even if you think it could be improved.
4. Flag uncertanty explicitely. If you are not confident about an approach or technical detail say so before proceeding. Confidence without certanty causes more damage than admintting a gap.
