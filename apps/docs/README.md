# docs

The documentation site served at [wolli.dev/docs](https://wolli.dev/docs) — a
TanStack Start app with Fumadocs, deployed as the `wolli-docs` Cloudflare
worker on zone routes (`wolli.dev/docs*`), next to the marketing worker that
owns the rest of the domain.

Content is not authored here: `content/docs/` holds thin `.mdx` stubs
(frontmatter + `<include>`) around `packages/wolli/docs/*.md`, the docs that
ship inside the wolli npm package. Edit those files to change the site;
`meta.json` controls the sidebar order. A remark plugin in `source.config.ts`
adapts the on-disk Markdown for the web (rewrites relative `.md` links, strips
the hand-written ToC sections).

Everything this worker serves must stay under `/docs/*` — assets
(`build.assetsDir`), server functions (`serverFns.base`), and the search API
route — or the request would land on the marketing worker instead.

```sh
pnpm dev      # dev server on http://localhost:3001/docs
pnpm build    # build + prerender all pages
pnpm deploy   # build + wrangler deploy
```

Deploys run from `.github/workflows/deploy-docs.yml` on pushes to main that
touch this app or `packages/wolli/docs/`.
