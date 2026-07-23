# AGENTS.md

## Cursor Cloud specific instructions

`pi-herdr-workflows` is a single TypeScript package (a workflow-engine extension for the `pi`
coding agent, dispatching agent nodes into Herdr panes). There is no build step for running: the
sources are executed directly via `tsx`. Standard commands live in `package.json` (`test`,
`typecheck`) and the README.

### Lint / test / typecheck
- Typecheck (this repo's only static check): `npm run typecheck` (`tsc --noEmit`). There is no
  separate lint tool configured.
- Tests: `npm test` (Node built-in runner over `test/*.test.ts`, loaded via `tsx`).
- The engine + result-file protocol run fully in-process; tests inject a fake `AgentStepExecutor`
  and use `writeFakeAgentResult` (see `test/engine-spawn.test.ts`). No `pi`/`herdr`/network needed.

### Running the product end to end
- Full `/workflow` usage requires the external `pi` runtime (peer dep, host-provided) **and** the
  `herdr` CLI on PATH, with `pi` running inside a Herdr session. The extension hard-fails unless
  `HERDR_ENV=1` and `HERDR_PANE_ID` are set (`src/extension/index.ts`), and agent nodes need LLM
  API access. None of these binaries/keys ship with this repo, so the live extension flow cannot
  run here without installing `pi` + `herdr` and providing model credentials.
- To exercise core engine behavior without those externals, use the library API
  (`WorkflowEngine` + a fake `AgentStepExecutor`); `compute`/`action`/`shell`/`checkpoint` nodes
  run in-process. Importing the package by its own name `pi-herdr-workflows` (self-reference) only
  resolves when the script lives inside this package directory.
- Run bundles persist under `~/.pi/agent/workflows/runs/<runId>/` (or the engine's `outputRoot`):
  `state.json`, `trace.ndjson`, `manifest.json`, `workflow.json`, and per-attempt `result.json`.

### Node version caveat
- `engines.node` is `>=22`; the VM's Node 22.14 works for typecheck/tests/library use. A few
  transitive/peer deps (`undici`, `@earendil-works/pi-tui`) emit `EBADENGINE` warnings asking for
  `>=22.19.0`. These are warnings only and do not block the above workflows.
