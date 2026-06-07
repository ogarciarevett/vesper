# Vendored: impeccable

This directory is a vendored copy of the **impeccable** design-quality skill.

- Upstream: https://github.com/pbakaus/impeccable
- Author: Paul Bakaus (paul@paulbakaus.com) — https://impeccable.style
- Version vendored: 3.5.0
- License: Apache License 2.0 (see `LICENSE` in this directory)

## Modifications (Apache-2.0 section 4 notice)

The upstream source places the skill at `.agents/skills/impeccable/` and its docs invoke the bundled
scripts via that path. Vesper uses `.ai/` as the single source for agent docs/skills (materialized to
`.claude/`, `.opencode/`, `.gemini/` by `bun run sync:ai`). The only change made when vendoring was a
mechanical path-token rewrite in the markdown invocation strings:

```
.agents/skills/impeccable  ->  .ai/skills/impeccable
```

across `SKILL.md` and `reference/{init,critique,polish,live}.md`. The committed `.ai/skills/impeccable/`
copy is the canonical location; the scripts are run from there regardless of which CLI loaded the
materialized SKILL.md. No script logic was changed.

## How it is used in Vesper

Wired into the Vesper cycle (`.ai/pipeline.md`): after each BUILD task whose diff touches the UI
(`packages/vesper-ui/**`), the cycle runs `$impeccable audit` + `$impeccable critique` on the changed
surface. Project context lives in `docs/PRODUCT.md` (and `docs/DESIGN.md` once generated via
`$impeccable document`). Runtime artifacts are written to `.impeccable/` at the repo root (gitignored).

To update: re-vendor from upstream at the desired tag and re-apply the path-token rewrite (do not run
the skill's built-in `npx impeccable skills update`, which expects an unmodified install).
