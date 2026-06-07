# Product

## Register

product

## Users

Two audiences, one product:

- **Today — the operator/developer (Omar).** Drives Vesper through the `vesper` CLI and observes it
  through the "Vesper World" web UI (a local `Bun.serve` surface on `127.0.0.1`, hosted by the
  daemon). Technical, wants dense truth: what is running, what each pipeline did, where a run failed.
- **The target — a non-technical elder (the Desktop-phase north star).** Must be usable by a
  70-year-old who never opens a terminal. The CLI stays the developer surface; the web UI is the
  human surface. The job to be done: "let me see and steer the agents working for me, in plain
  language, without fear of breaking anything."

The UI must serve both without dumbing down the operator view or overwhelming the elder view.

## Product Purpose

Vesper is a local-first runtime for personal automation agents. It hosts independent automation
**pipelines** (career-growth, social, trading, a software-engineer cycle, and more) under one
capability-sandboxed host on the user's own machine. The brain is the user's already-installed CLI
(Claude Code / opencode / codex / gemini) or their own API key, never a bundled provider SDK; nothing
leaves the machine except calls the user explicitly opts into.

The "Vesper World" UI is the window into that runtime: chat with Vesper, watch what Vesper is doing
(its own activity rail), connect messaging channels, train and browse skills, manage semantic memory,
talk to Vesper by voice, and inspect diagnostics. Success: a non-technical person can run and observe
their personal agents with confidence, and a developer can trust the surface to tell the truth about
the system.

## Brand Personality

Premium, calm, trustworthy. Three words: **calm, premium, honest.** Voice is plain-language and
specific — no marketing buzzwords (no "supercharge / seamless / next-generation"), no jargon thrown
at the elder user, no emojis anywhere in product surfaces (a hard project rule). The look is a
deliberate **dark-glass** aesthetic (frosted, layered, OpenClaw-inspired) — this is a committed brand
identity locked by the product owner, NOT decorative glassmorphism-by-default; treat the glass system
as identity to preserve, not a tell to remove. Confidence through restraint: the work speaks; the UI
never shouts.

## Anti-references

- **AI-slop tells:** SaaS-cream/beige body backgrounds, the hero-metric template (big number + label +
  gradient), identical icon-heading-text card grids repeated endlessly, tiny uppercase tracked
  eyebrows above every section, gradient text, numbered "01 / 02 / 03" section scaffolding.
- **Generic developer-dashboard chrome** — Vesper is not a Grafana clone or a kitchen-sink admin
  panel.
- **Loud / overstimulating** — no cyberpunk neon (explored and dropped), no attention-grabbing motion.
- **Retired metaphors** — the old pixel-art creature/"world" canvas and the elder-first *visual*
  framing are superseded; do not reintroduce them.
- **Note on glass:** decorative glassmorphism applied at random is an anti-pattern, but Vesper's
  dark-glass system is the intended brand and must be preserved, not flagged as slop.

## Design Principles

1. **Show, don't tell.** The UI proves what is actually running on the machine; it never asserts
   status it cannot back with real data.
2. **Honest states over hidden ones.** Surface "not enabled yet", "degraded", or "needs setup"
   plainly with a path forward, rather than faking success or hiding a feature as a dead stub.
3. **Plain language for the human, dense truth for the operator.** Two audiences, no condescension to
   either; the elder never meets jargon, the developer never loses signal.
4. **Calm confidence.** Premium restraint; clarity and trust beat spectacle.
5. **Practice what you preach.** Vesper exists to build quality software, so its own surfaces must
   meet the bar it sets for everything else.

## Accessibility & Inclusion

Target **WCAG 2.1 AA**. Body text contrast >= 4.5:1 (large text >= 3:1) — verify against the dark-glass
backgrounds, where muted text on frosted surfaces is the most likely failure. Fully keyboard
navigable with visible focus. Because the north-star user is a non-technical elder: generous touch
targets, unambiguous affordances and labels (verb + object on buttons, standalone link text), no
reliance on color alone, and a clear no-fear path out of any state. Every animation needs a
`prefers-reduced-motion` alternative. No emojis as functional UI.
