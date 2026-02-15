---
trigger: always_on
---

# Project Rules

1. **Package Manager**: Always use `bun` for installing dependencies and running scripts.
   - Install: `bun install`
   - Run: `bun run <script>`
   - Exec: `bunx <command>`
   - Do NOT use `npm`, `yarn`, or `pnpm`.

2. **Tech Stack**:
   - Cloudflare Workers (Hono, Durable Objects).
   - TypeScript.
   - Turborepo.

3. **Env Variable Canonicalization**:
   - Use exactly one canonical environment variable name per concept.
   - Do NOT introduce aliases, legacy names, or fallback env names for the same value.
   - If a name change is required, migrate references and docs in one pass, then remove the old name entirely.
