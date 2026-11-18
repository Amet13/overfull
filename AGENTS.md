# AGENTS.md

Instructions for agents working on the Overfull repository itself. The
`AGENTS.md` that paper and thesis projects get is `shared/agents/AGENTS.md`.

## Layout

- `packages/core`: the checks (log, PDF, references, venue rules).
- `packages/cli`: the `overfull` command; `action/`: the GitHub Action.
- `templates/`: the thesis, paper and slides templates.
- `skills/` and `shared/agents/`: the agent skills and agent files that are
  copied into every template. Edit them there, never the copies in
  `templates/*/.agents/`, `templates/*/AGENTS.md` or the other synced files.
  Then run `pnpm templates:sync` and commit the copies.
- `venues/`: venue profiles; `node scripts/build-venues.mjs` regenerates
  `packages/core/src/venue/venues.generated.ts` (never edit it by hand).
- `docs/guide/`: the user documentation; `CHANGELOG.md`: add a line under
  `## [Unreleased]` for every user-visible change.

## Before you commit

```sh
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm templates:check && pnpm venues:check
```

Add or update tests (Vitest, next to the existing ones) for every behaviour
change. Never skip or loosen a test to get green. If you change anything that
ships in `action/dist`, run `pnpm --filter overfull-action build` and commit it.

A template change must still build in the slim image and pass its own check
(veraPDF included): `bash scripts/e2e-templates.sh <image> out` with Docker.

## Style

Plain, short English in docs, messages and comments. Biome formats the code
(`pnpm fmt`). See `CONTRIBUTING.md` for the rest.
