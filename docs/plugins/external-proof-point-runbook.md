<!--
FNXC:Plugins 2026-06-14-13:36:
Task FN-6438 requires a reusable proof-point runbook for validating that an externally authored plugin runs against a released Fusion build. Keep this document tied to task-document evidence, especially FN-6437's proof-point-report, so future agents repeat the validation from durable docs instead of task-local scratch files.
-->

# External Plugin Proof-Point Runbook

This runbook validates the v1 ecosystem signal for goal **G-MPS8FPMK-0001-SAWD**: an externally authored Fusion plugin can be scaffolded, built, tested, loaded, enabled, and listed against a **released** `@runfusion/fusion` build without using the Fusion monorepo.

Use the step-by-step authoring guide for command details: [External Plugin Authoring](./external-authoring.md). This runbook adds release selection, evidence capture, and pass/fail criteria for proof-point validation.

## Purpose & when to run

Run this proof point when Fusion claims support for external plugin authors, especially before or after a release that changes any of these surfaces:

- `fn plugin new`
- `fn plugin dev`
- `fn plugin install`
- `fn plugin enable`
- `fn plugin list`
- `@runfusion/fusion/plugin-sdk`
- bundled CLI/runtime dependencies that the released package must resolve without monorepo `workspace:*` links

The proof point must use the public release artifact. Do not validate with a local workspace build unless the task is explicitly about pre-release smoke testing.

## Prerequisites

- Node.js 18+
- `pnpm` and `npm`
- Public registry/network access for `npm view`, `npx`, and package installation
- A clean temporary workspace **outside** the Fusion repo, for example:

  ```bash
  export FUSION_PLUGIN_PROOF_DIR="$(mktemp -d)"
  cd "$FUSION_PLUGIN_PROOF_DIR"
  ```

- Do **not** start or kill anything on port 4040. Port 4040 is reserved for the production dashboard. If a command needs a server port, use a random/free port option such as `--port 0`.
- Do **not** run an unbounded recursive `find` rooted at `/tmp`, `$TMPDIR`, or macOS `/var/folders/...`. If you need to inspect the temp workspace, list only the known proof directory.

## Released version selection

Capture the released package version and integrity before running the proof point:

```bash
npm view @runfusion/fusion version
npm view @runfusion/fusion dist.integrity
```

For this runbook update, registry provenance was recaptured on 2026-06-14:

```text
@runfusion/fusion version: 0.43.0
dist.integrity: sha512-kvxicT+e8ulc7FDhBVP9NsgaioZv6NDW81N8cXNS/X8M32Eo3Y33xT6JFW2DrSiFXsJmAaib/GnpQE0nYQYApQ==
```

The proof point should target a release that includes the external-author fixes tracked by FN-6409, FN-6410, and FN-6435. Before running, confirm the release notes or consumed changeset state include `.changeset/fn-5844-external-plugin-authoring.md`; if that changeset has not been consumed into the published package, record a release-gate failure rather than patching locally.

Use the concrete release tarball URL for the version under test:

```text
https://registry.npmjs.org/@runfusion/fusion/-/fusion-<version>.tgz
```

Replace `<version>` only with the value returned by `npm view @runfusion/fusion version` for the run being reported.

## Plugin source selection

Prefer the released scaffold path because it validates the public author experience end to end:

```bash
npx @runfusion/fusion@latest plugin new proof-point-plugin
cd proof-point-plugin
```

The scaffolded package should be standalone:

- package name like `fusion-plugin-proof-point-plugin`
- imports SDK helpers from `@runfusion/fusion/plugin-sdk`
- no private `@fusion/*` imports
- no `workspace:*` dependencies
- no references to the Fusion monorepo checkout

If the task requires testing an already-authored external plugin instead of the scaffold, record its canonical repository, docs/homepage, release/download artifact, binary/CLI if any, and checksum or `upstream-pending-verification` marker before running it.

## Execution commands

Follow [External Plugin Authoring](./external-authoring.md) for detailed command behavior. The validated loop is:

```bash
fn plugin new proof-point-plugin
cd proof-point-plugin
pnpm install
pnpm build
pnpm test
fn plugin dev . --once
fn plugin list
```

If the proof point uses the packaged-install path instead of `plugin dev`, run the equivalent install/enable/list loop:

```bash
pnpm build
pnpm test
pnpm pack
fn plugin install ./fusion-plugin-proof-point-plugin-0.1.0.tgz
fn plugin enable fusion-plugin-proof-point-plugin
fn plugin list
```

Record the exact commands actually run. Do not summarize a command as successful unless its transcript shows exit code 0 or equivalent success output.

## Evidence to capture

Store evidence in a task document named `proof-point-report`. Evidence must **not** live only in task-local scratch files.

The report should start with a top-level verdict line:

```text
VERDICT: MET
```

or:

```text
VERDICT: NOT MET — <short reason>
```

Capture at least:

1. Released `@runfusion/fusion` version.
2. `dist.integrity` from `npm view @runfusion/fusion dist.integrity`.
3. The concrete release/download URL for the tested version.
4. Evidence that `.changeset/fn-5844-external-plugin-authoring.md` has been consumed into the release, or a release-gate failure if it has not.
5. Full command transcript for scaffold, install, build, test, load/install, enable, and list.
6. `fn plugin list` output proving the plugin is present and enabled.
7. Any failure signature and the follow-up task IDs filed for it.

A minimal report shape:

````markdown
VERDICT: MET

## Released package
- Package: @runfusion/fusion
- Version: <npm view version>
- dist.integrity: <npm view dist.integrity>
- Release URL: https://registry.npmjs.org/@runfusion/fusion/-/fusion-<version>.tgz

## Commands
```bash
<exact commands>
```

## Evidence
```text
<important excerpts, including fn plugin list enabled-state proof>
```

## Follow-ups
- None, or task IDs for gaps found
````

## Expected pass/fail signals

### MET

A proof point is **MET** when a standalone external plugin:

- is created or selected without monorepo-only dependencies,
- installs dependencies from the public registry,
- builds and tests successfully,
- loads/enables through the released `fn` CLI path, and
- appears in `fn plugin list` as enabled.

### NOT MET

A proof point is **NOT MET** when any required public-author step fails against the released build. File focused follow-up tasks for release-gate gaps instead of patching product code inside the validation run.

Known failure signatures to watch:

- `TS2307: Cannot find module '@fusion/core'` — private SDK typing leakage; tracked by FN-6409.
- `ERR_MODULE_NOT_FOUND` for `@earendil-works/pi-*` — released CLI dependency packaging/resolution gap; tracked by FN-6410.
- `TS2345` with `Property 'state' is missing` — scaffold or SDK type mismatch; tracked by FN-6435.

If a known signature reappears in a release that should contain its fix, file a new regression task that links the original task and includes the transcript.

## External integration evidence

This runbook installs and runs the released third-party-distributed Fusion CLI (`@runfusion/fusion`) from the public npm registry. Provenance recaptured via `npm view @runfusion/fusion version dist.integrity --json` on 2026-06-14:

- Canonical upstream repo URL: https://github.com/Runfusion/Fusion
- Docs / homepage URL: https://www.npmjs.com/package/@runfusion/fusion; in-repo author guide `docs/plugins/external-authoring.md`; in-repo SDK guide `docs/PLUGIN_AUTHORING.md`
- Release / download URL: https://registry.npmjs.org/@runfusion/fusion/-/fusion-0.43.0.tgz
- Binary / CLI name: `fn` (provided by the published `@runfusion/fusion` package; also invokable via `npx @runfusion/fusion@latest`)
- Checksum (`dist.integrity` for 0.43.0): `sha512-kvxicT+e8ulc7FDhBVP9NsgaioZv6NDW81N8cXNS/X8M32Eo3Y33xT6JFW2DrSiFXsJmAaib/GnpQE0nYQYApQ==`

For future proof-point runs, replace the release URL and checksum only with values returned by `npm view` for the tested version. If the checksum cannot be verified, write `upstream-pending-verification` and do not fabricate a hash.

## Reference: concrete validated path (FN-6437)

`upstream-pending-verification`: FN-6437 is the first proof-point validation task, but its restored `proof-point-report` was not accessible to this FN-6438 execution environment at the time this runbook was written. FN-6449 is archived as the restoration task, and follow-up FN-6452 tracks backfilling this section with the authoritative FN-6437 report contents once accessible.

Do not infer or fabricate FN-6437's outcome. When the report is available, replace this section with:

- released `@runfusion/fusion` version tested by FN-6437,
- `dist.integrity` recorded by FN-6437,
- exact commands run by FN-6437,
- captured evidence, including `fn plugin list` enabled-state output,
- the verbatim `VERDICT:` line, and
- any linked gap/follow-up task IDs.
