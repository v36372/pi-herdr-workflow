# Workflow examples

Friendly names match the `/workflow <name>` command (file stem = discover name).

All agent demos pin the cheap model:

```ts
spawn: { model: "openai-codex/gpt-5.6-luna", thinking: "low", ... }
```

| Command | Nodes | Shows |
|---|---|---|
| `/workflow hello` | compute | Pure transform, no Herdr |
| `/workflow shell-stats` | shell → compute | Deterministic CLI facts |
| `/workflow echo` | agent | Minimal `workflow_done` |
| `/workflow coin-flip` | decision → compute | Closed choice + branch rejoin |
| `/workflow relay` | agent → agent → compute | Two trivial agent steps |
| `/workflow mood-route` | agent → decision → compute | Agent then decision routing |
| `/workflow repo-scout` | agent | Read-only tools + JSON contract |
| `/workflow risk-route` | agent → decision → compute | Scout + ship/fix |
| `/workflow test-then-judge` | shell → agent → compute | Facts first, model second |
| `/workflow repair-on-fail` | shell ↔ repair agent | `$result.outcome` failure routing |
| `/workflow plan-checkpoint` | agent → checkpoint | Human gate (`waiting`) |

## Graded engine demos

Levels 1–8 under [`examples/demo/`](demo/) exercise the engine with increasing complexity (compute → shell → functional `timeoutMs` → full spawn → switch rejoin → checkpoint `continueRun` → repair routing → park/resume). See [`demo/README.md`](demo/README.md).

```bash
npm run demo:workflows
npm test   # includes test/demo-workflows.test.ts
```

Standalone vanilla pi (no Herdr) can run the same files through `/workflow` after loading the extension with `--extension`:

```bash
pi -p --no-session --no-extensions --extension ./src/extension/index.ts \
  "/workflow examples/hello.workflow.ts"
```

Agent examples need a model, or the stub provider in `scripts/workflow-stub-model.ts` (see README).

## Run

From a Herdr session with this package installed:

```bash
/workflow list
/workflow hello
/workflow coin-flip
/workflow relay ocean
/workflow mood-route rainy monday
/workflow shell-stats
/workflow echo say hi
/workflow repo-scout map the engine
/workflow risk-route should we ship
/workflow test-then-judge
/workflow repair-on-fail {"mode":"fail"}
/workflow plan-checkpoint one week plan
```

Agent demos need Herdr (`HERDR_ENV=1`). Compute/shell-only graphs still go through the `workflow` tool but do not open agent panes.

## Cheap model helper

`_cheap.ts` exports `CHEAP` for demos. Import it from sibling workflows:

```ts
import { CHEAP } from "./_cheap.js";

spawn: { name: "scout", ...CHEAP, tools: "read" }
```
