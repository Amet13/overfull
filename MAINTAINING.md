# Maintaining Overfull

The repository keeps itself up to date. Workflows open pull requests for every
update, merge them when the full CI passes, release on their own, and open an
issue when something needs a person. This page lists what runs, when, and what
is still yours.

## What runs on its own

| When | Workflow | What it does |
| --- | --- | --- |
| Mondays | Dependabot | Pull requests for npm packages, GitHub Actions (also in the templates' workflows) and Docker base images, including the pinned TeX Live image. Only versions at least 7 days old are proposed (30 days for an npm major version; security updates at once), and pnpm installs nothing younger than 7 days (`minimumReleaseAge`). Patch, minor and digest updates are labelled `automerge`; major updates wait for you (npm majors come in a pull request of their own, so one major never holds back the others). |
| Tuesdays | `maintenance.yml` (update-pins) | Updates what Dependabot cannot: Node.js and veraPDF in `docker/Dockerfile` (version and SHA-256), and pnpm in `packageManager` and `docker/pnpm` together. |
| After each merge, and Wednesdays | `regenerate.yml` | Rebuilds `action/dist`, the agent files in the templates and the venue module, and opens a pull request when they changed (Dependabot cannot rebuild the bundled Action). |
| When ci or codeql finishes | `automerge.yml` | Merges a same-repository pull request labelled `automerge`, opened by you, the repository's workflows or Dependabot, once every check on its head commit has passed (anyone else's pull request is never merged automatically, label or not). A pull request behind `main` is not merged: `main` is merged into it and ci runs again. After the merge it starts ci, codeql and regenerate on `main`, and image and pages when the changed files match their path filters (a merge made by a workflow starts no workflows by itself). image publishes `edge` and `sha-*` only once ci passed on that commit. |
| Sundays | `ci.yml` | The full CI on `main`, so a change outside the repository (runner images, registries) is noticed without a commit. |
| 1st of the month | `autorelease.yml` (propose) | When shipped files changed since the last release, opens "Release vX.Y.Z": a minor bump when `[Unreleased]` has `### Added` entries, else a patch bump (never a major one); a dated CHANGELOG section from `[Unreleased]` plus the commit subjects (dependency bumps folded into one line); rebuilt `action/dist`. |
| Daily | `autorelease.yml` (publish) | When `package.json` holds a version that has no tag yet and CI passed on `main`, starts `release.yml` with publish: tag, GitHub release with executables, Homebrew and Scoop files, and the three images. Everything is built first (the images too, when `main` has none for that commit); the publishing job runs in the `release` environment, so it waits for your approval once you add a reviewer (see below), then tags the images and creates the release. |
| After each release | `release.yml` (package-manifests) | Writes `Formula/overfull.rb` (Homebrew), `bucket/overfull.json` (Scoop), `flake.nix` (Nix) and `server.json` (MCP Registry) from the release's `SHA256SUMS` with `packaging/generate.mjs`, and opens an automation pull request (`automation/packaging`). This repository is itself the tap, the bucket and the flake, so no other repository or token is needed. |
| 1st of the month | `maintenance.yml` (usage) | Records public usage counts in `metrics/usage.json`, one entry per month, and opens a pull request: downloads of each release file, stars, forks, and code-search counts of public workflows using `amet13/overfull@` and public `.bib` files with the `x-overfull` marker. Only public numbers that GitHub already shows; Overfull itself sends nothing anywhere. ghcr pull counts are not in the API without a sign-in, so they are not recorded. |
| 3rd of the month | `maintenance.yml` (bench) | Runs the reference-check benchmark against the live indexes and opens a pull request with `bench/refs/results.json`; the accuracy page renders it. |
| Wednesdays | `maintenance.yml` (sources-health) | Asks every reference source (doi.org, CrossRef, dblp, arXiv, OpenAlex, Semantic Scholar, ACL Anthology, Europe PMC) for one known work and one invented title. Sources that stop answering, answer with a bot wall, or no longer find the known work are listed in one issue: "Reference sources need a look". |
| 5th of the month | `maintenance.yml` (venues-watch) | Compares every venue profile's official pages (and arXiv's build pages) with the text stored when a person last read them, and puts the changed lines, the next edition's call for papers, and profiles not checked for a year in one issue: "Venue profiles need a look". Also checks each style file against the venue's official kit and opens a pull request when a hash changed. |
| 9th of the month | `maintenance.yml` (refresh-recordings) | Records again the live answers that the offline reference tests replay, and opens a pull request: green is merged, red means a source changed its answers or format. |
| After any of the above, and hourly | `watchdog.yml` | Opens "Automation failed: <workflow>" when a run on `main`, a scheduled run, an automation branch or a release tag fails, and closes it when the newest run of that workflow there succeeds. When a ci, image or release job never got a runner (GitHub's macOS capacity, a lost runner), it re-runs the failed jobs once; a job that ran and failed is never re-run. The hourly sweep does the same for the runs the automation starts itself (GitHub reports those to no other workflow), and cancels a run stuck in the queue for 20 minutes without a job, starts it again once and opens an issue. |

Every pull request goes through the same CI as a person's: lint, types, unit
tests on three operating systems, the image builds (full, slim, check-only, in parallel),
the corpus on TeX Live and the three templates built and checked. Nothing is
merged on a red or missing check.

## What stays with a person

- **Major updates.** Dependabot's major-version pull requests are not labelled
  `automerge`. Review the changelog of the dependency, then merge or close.
- **Venue rules.** The venues-watch task reports which official pages changed and
  shows the changed lines. Read the venue's pages and update or add the profile by
  hand (CONTRIBUTING.md, "Adding a venue"), then run
  `node scripts/venues-watch.mjs --accept <id>` in the same pull request. Page
  limits, what counts toward them, anonymity and disclosure rules are prose: no
  script and no language model extracts them, because a wrong limit would reject a
  correct paper. Only style-file hashes follow the official kit automatically.
- **Reference sources.** When "Reference sources need a look" is open, read the
  source module in `packages/core/src/refs/sources/` and the API documentation it
  links. A bot wall or a new response format needs a code change; an outage needs
  nothing.
- **Issues the automation opens.** Each links the failing run. Fix the cause in a
  pull request; the issue closes itself on the next successful run.
- **Agent evals.** They cost money and run only when you start them
  (`evals/README.md`).
- **The MCP Registry listing.** Nothing publishes to the official MCP Registry on
  its own; you decide whether to list Overfull there. To do it, run Actions →
  mcp-registry → Run workflow, first with "dry-run" ticked (it checks that
  `server.json` names a released version and that the check image carries the
  `io.modelcontextprotocol.server.name` label), then unticked. It signs in with
  the workflow's GitHub OIDC token: no account, no secret, nothing to register.
  Each version can be published once. The label is in images built from this
  change on, so the first release after it is the first that can be listed.

## Repository settings this needs

Set these once; the workflows cannot set them:

1. **Settings → Actions → General → Workflow permissions:** tick "Allow GitHub
   Actions to create and approve pull requests". Without it the maintenance
   workflows cannot open their pull requests.
2. **The `main` ruleset requires the "CI passed" check** (Settings → Rules →
   Rulesets → main → Require status checks to pass → add "CI passed", source
   GitHub Actions). That one job passes only when every CI job passed or was
   skipped on purpose, so nothing merges while a job is queued or after one
   failed, and the list never needs updating when jobs change. Do not require
   reviews: the automation's merges would be refused.

   Automation pull requests (`automation/*`, opened by GitHub Actions) get their CI
   from the workflow that opened them, and that ci run merges the pull request when
   every check passed, or opens "Automation failed: ci on automation/…" when one did
   not (GitHub starts no follow-up workflow for runs started with GITHUB_TOKEN, so
   automerge.yml never sees them; watchdog.yml finds them in its hourly sweep). The
   workflow also starts codeql on the branch, and ci waits for it before merging.
   When a job never got a runner, ci starts itself once more. GitHub also shows a pull_request run waiting for
   approval; approving it is not needed, and its jobs are skipped if you do.
3. **Packages:** make `ghcr.io/amet13/overfull` public (Package settings → Change
   visibility), so anyone can pull the images.
4. **Release approval:** Settings → Environments → `release` (created by the first
   release run) → Required reviewers → add yourself. The job that tags the images,
   creates the tag and the GitHub release and moves `v3` then waits until you
   approve it, so a
   compromised dependency cannot reach a release with no person involved. Without
   a reviewer the environment does nothing and releases run on their own.
5. **Release tags (recommended):** Settings → Rules → Rulesets → New tag
   ruleset, target `v*`, restrict creations, updates and deletions. In the bypass
   list put only you (the Repository admin role) and the GitHub Actions app,
   because `release.yml` creates `vX.Y.Z` and moves `v3` itself, after your
   approval. A pushed `vX.Y.Z` tag starts a release on its own; the ruleset keeps
   anyone else from pushing one or moving `v3`, the tag that every
   `uses: amet13/overfull@v3` reads.

The `automerge` and `maintenance` labels are created by the workflows on first
use.

## Turning it off

Disable a workflow under Actions → the workflow → "Disable workflow". The scheduled
upkeep is one workflow, `maintenance.yml`; any of its tasks can also be run by hand
(Actions → maintenance → Run workflow → task). To stop
automatic merges entirely, disable `automerge.yml`; pull requests then stay open
for you. To stop automatic releases, disable `autorelease.yml`; releasing by hand
still works (CONTRIBUTING.md, "Cutting a release").
