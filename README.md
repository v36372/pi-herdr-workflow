# pi-herdr-workflows

One package that composes three ideas:

| From | Kept | Dropped |
|---|---|---|
| **pi-workflows** | graph engine, node types, edges, run bundles | graph widget, conversation-step executor, terminal viewer |
| **pi-interactive-subagents** | agent spawn params + result-file protocol | mux tools, `/plan` `/iterate`, status widget, actual dispatch |
| **pi-herdr** | pane/workspace dispatch **and** interactive tools vendored from `@ogulcancelik/pi-herdr` (`herdr_layout` / `herdr_pane` / `herdr_agent`) | separate package install (disable `~/.pi/agent/extensions/pi-herdr`) |

## What runs where

| Node | Runtime |
|---|---|
| `agent` / `decision` | **Herdr pane** (one pane per attempt, workspace per run) |
| `compute` / `action` / `shell` / `checkpoint` | **Orchestrator process** (main pi) |

Edge routing and validation stay in the engine. Herdr delivers prompts into panes and reports when the agent goes idle; the orchestrator then reads `result.json`.

## Agent spawn params

Same surface as interactive-subagents `subagent()` (minus mux tools):

```ts
agent({
  spawn: {
    name: "Scout: Auth",       // pane label (default: node id)
    agent: "scout",            // load ~/.pi/agent/agents/scout.md defaults
    systemPrompt: "...",       // string or (ctx) => string
    model: "…",
    skills: "foo,bar",
    tools: "read,bash,grep",
    extensions: ["/path/to/pi-ask/index.ts"], // explicit -e sources; settings stay disabled
    cwd: "./packages/api",     // string or (ctx) => string
    fork: false,
    interactive: false,
  },
  prompt: ({ input, outputs }) => `…`,
  expectedOutput: `{ "findings": [] }`,
  validate: (output) => output,
})
```

Named agents resolve from `<workflow cwd>/.pi/agents/<name>.md` first, then
`~/.pi/agent/agents/<name>.md` (or `$PI_CODING_AGENT_DIR/agents`). Explicit spawn
fields override agent frontmatter defaults. Supported defaults are `model`,
`thinking`, `tools`, `skill`/`skills`, and `cwd`; the markdown body follows the
reference implementation's `system-prompt: append|replace` behavior, or is
prepended to the task when that field is omitted.

`skills` is an eager comma-separated list, not merely a discovery filter. The
executor uses Pi's `DefaultResourceLoader` for the child cwd, resolves each name,
and prepends the same full `<skill ...>` blocks produced by `/skill:name` to the
submitted task. An unknown agent or skill fails the node before Pi starts.

`extensions` adds explicit Pi `-e` sources to the child. Workflow agents still run
with settings discovery disabled, so interactive tools such as `ask` and observers
such as a companion overlay must be listed when that node needs them.

## Orchestrator and completion model

`/workflow <name>` sends a normal user turn instructing the main pi orchestrator to call the model-visible `workflow` tool. That tool executes the graph deterministically, stays pending for the whole run, and streams node/agent progress through tool updates. The orchestrator receives the final structured result and presents it after the tool returns.

Agent nodes use Herdr **v0.7.5's live-agent facade**. `workflow_done` → `result.json` remains authoritative; the agent lifecycle is the server-owned wait signal.

| Step | action |
|---|---|
| create run workspace | `herdr workspace create` |
| pane per agent | root pane / `herdr pane split` |
| prepare child environment | source `agent-env.sh` in the pane shell |
| start interactive child | `herdr agent start <name> --kind pi --pane <id> -- <pi args>` |
| deliver and wait | `herdr agent prompt <name> <task> --wait` |
| collect output | accept `result.json` from `workflow_done` |
| update orchestrator | partial `workflow` tool results with elapsed time and current node |

Per agent attempt under `~/.pi/agent/workflows/runs/<runId>/agents/<nodeId>/<attemptId>/`:

| File | Writer | Purpose |
|---|---|---|
| `task.md` | orchestrator | exact submitted prompt, including agent role and preloaded skills |
| `result.json` | child (`workflow_done`) | structured output |
| `agent-env.sh` | orchestrator | environment inherited by the interactive child |

The child extension registers `workflow_done`, writes `result.json`, and returns a terminating tool result so pi settles. `herdr agent prompt --wait` then wakes the orchestrator. No exit-sidecar handshake or status polling is used.

## Install

```bash
pi install file:./pi-herdr-workflows
# or from this directory after npm i
```

Requires: pi ≥ 0.80 and Herdr ≥ 0.7.5 on PATH, with pi running inside a Herdr session.

```bash
/workflow                 # float menu: pick workflow, optional agent models, optional task
/workflow list
/workflow echo summarize this repo
/workflow pause | resume | cancel
```

Bare `/workflow` opens float menus: pick a discovered workflow, then a **custom overlay** listing every agent step. In the list, `j`/`k` (or ↑/↓) move, Enter edits a step, and `q`/Esc accepts the current configuration and exits. While editing, typing filters autocomplete suggestions from Pi's configured scoped models, ↑/↓ or Ctrl-j/k chooses, Tab completes, Enter applies, and Esc cancels that edit while keeping its previous override/default. Steps without an authored model show Pi's effective configured `provider/id` instead of a generic workflow-default label. Empty or invalid input keeps the step's default. Overrides are passed as `modelOverrides` into the `workflow` tool.

The visible conversation flow is: user `/workflow` request → orchestrator `workflow` tool call → streaming progress → tool result → orchestrator presentation.

## Author a workflow

```ts
// .pi/workflows/review.workflow.ts
import { agent, compute, defineWorkflow, decision, decisionEdge } from "pi-herdr-workflows";

export default defineWorkflow({
  name: "review",
  startAt: "scout",
  nodes: {
    scout: agent({
      spawn: { name: "scout", agent: "scout", tools: "read,bash,grep,find,ls" },
      prompt: ({ input }) => `Map the change: ${(input as { task: string }).task}`,
      expectedOutput: `{ "summary": "…", "paths": [] }`,
    }),
    route: decision({
      spawn: { name: "router", model: "…" },
      question: ({ outputs }) => `Risk of: ${JSON.stringify(outputs.scout)}`,
      choices: ["ship", "fix"] as const,
    }),
    note: compute({
      run: ({ outputs }) => ({ decided: outputs.route }),
    }),
  },
  edges: [
    { from: "scout", to: "route" },
    decisionEdge({ from: "route", choices: ["ship", "fix"] as const, cases: { ship: "note", fix: "note" } }),
  ],
});
```

## Library use (no pi extension)

```ts
import { WorkflowEngine, defineWorkflow, agent, HerdrStepExecutor } from "pi-herdr-workflows";

const executor = new HerdrStepExecutor({ cwd: process.cwd() });
const engine = new WorkflowEngine({ executor });
const result = await engine.run(myWorkflow, { task: "…" });
await executor.dispose();
```

Inject a fake `HerdrClient` via `new HerdrClient({ exec })` for tests. CLI failures surface as typed `HerdrError` values with machine-readable `code` fields (`protocol_mismatch`, `agent_prompt_stalled`, `agent_not_running`, …).

## Herdr tool ownership

This package vendors the interactive tools from `@ogulcancelik/pi-herdr` (source: `src/herdr/tool.ts`, skill: `skills/herdr/`):

- `herdr_layout` — workspaces, tabs, pane topology
- `herdr_pane` — ordinary commands and raw terminal control
- `herdr_agent` — start/prompt/wait/read recognized coding agents

Disable a separate install so you do not register the same tools twice:

```bash
mv ~/.pi/agent/extensions/pi-herdr ~/.pi/agent/extensions/pi-herdr.disabled
```

The deterministic `workflow` tool uses `HerdrClient` / `HerdrStepExecutor` and owns its run topology and lifecycle internally. Freeform pane and agent work goes through the three interactive tools above.

## Deliberate ceilings

1. **Workflow-owned lifecycle** — agent frontmatter fields for subagent spawning, session mode, auto-exit, and interactivity do not apply. Workflow agents are fresh ephemeral Pi sessions and must finish through `workflow_done`.
2. **Bounded completion retry** — if the agent settles without `workflow_done`, or `validate` rejects after `workflow_done`, the same live agent is re-prompted (missing-result reminder or validation error). Default ceiling is 3 submissions (`maxValidationAttempts`); rejected `result.json` files are cleared so a stale payload cannot be accepted again.
3. **No graph widget / viewer** — run bundles still write to disk; use `state.json` / `trace.ndjson` or reattach a viewer later.
4. **Agent kind** — workflow nodes currently start interactive pi agents. Override `buildAgentArgs` for pi arguments; supporting other agent kinds requires a compatible structured-result tool.
5. **No `agent.view.*` / metadata-token integration** — Herdr 0.7.5 exposes `agent.view.set`/`agent.view.clear` only on the socket API (no CLI subcommand) and `pane`/`workspace report-metadata` as display-token writers that require host UI config (`$token` rows in `config.toml`). They do not improve workflow-run correctness or lifecycle waits, so this package intentionally does not wrap them or build a custom socket client for nominal coverage. Pane labels plus `workflow` tool progress remain the run-visibility surface.

## Layout

```
src/
  workflows/     # forked engine (no UI)
  herdr/         # vendored interactive tools + client + HerdrStepExecutor + result-file protocol
  child/         # workflow_done extension for agent panes
  extension/     # thin /workflow command (no widget)
```
