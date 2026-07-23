---
name: herdr
description: "Control Herdr, a terminal multiplexer for coding agents. Use only when the user explicitly mentions Herdr or asks to use Herdr to inspect or control panes, tabs, workspaces, terminals, commands, or communication with another agent. Do not use merely because a task could benefit from a background terminal, delegation, or parallel work. Requires HERDR_ENV=1."
---

# Herdr

Pi-native tools for controlling [Herdr](https://github.com/ogulcancelik/herdr) layouts, terminal panes, and coding agents.

Tools activate only when Pi runs inside a Herdr-managed pane with `HERDR_ENV=1` and `HERDR_PANE_ID` set. This skill describes the structured tools registered by this package (`herdr_layout`, `herdr_pane`, `herdr_agent`). Prefer those tools over shelling out to the `herdr` CLI.

## Execution model

Herdr exposes three distinct primitives:

- **Layout** organizes terminal locations. Workspaces contain tabs, and tabs contain panes.
- **Pane** controls a raw terminal containing a shell, test, server, build, log, or other ordinary process.
- **Agent** controls a recognized coding agent currently occupying a pane.

A pane exists independently of an agent. Starting an agent requires an existing pane at an available interactive shell prompt and never creates or changes layout.

The extension registers one tool for each primitive.

### `herdr_layout`

Inspect and create workspaces, tabs, and pane topology.

| Action | Description |
| --- | --- |
| `current` | Inspect the pane running the current Pi process |
| `workspace_list` | List workspaces |
| `workspace_create` | Create a workspace, first tab, and root pane |
| `workspace_focus` | Focus a workspace |
| `tab_list` | List tabs |
| `tab_create` | Create a tab and root pane |
| `tab_focus` | Focus a tab |
| `pane_list` | List panes in a workspace |
| `pane_layout` | Inspect pane geometry |
| `pane_split` | Split an existing pane |

Creation defaults to the caller pane's foreground working directory and preserves UI focus. When `pane_split` omits a direction, the tool chooses right for a sufficiently wide pane and down for a narrow or tall pane.

Workspace, tab, and pane IDs are opaque. Always use IDs returned by Herdr instead of constructing them.

### `herdr_pane`

Ordinary commands and intentional raw terminal control.

| Action | Description |
| --- | --- |
| `get` | Inspect a pane |
| `run` | Submit a shell command atomically with Enter |
| `read` | Read terminal output |
| `wait_output` | Wait for literal or regular-expression output |
| `send_text` | Send literal text without Enter |
| `send_keys` | Send logical terminal keys |
| `close` | Close a pane other than the pane running Pi |

`wait_output` searches existing output immediately before waiting for future output. Use `recent-unwrapped` for logs and transcripts.

Pane actions do not validate coding-agent identity or interpret agent lifecycle. Use `herdr_agent` when a pane contains a recognized coding agent.

### `herdr_agent`

Control a recognized coding agent by unique live name or by its hosting pane ID.

| Action | Description |
| --- | --- |
| `list` | List recognized agents |
| `get` | Inspect an agent |
| `start` | Start a supported agent in an existing available shell pane |
| `prompt` | Submit a prompt and optionally wait for settlement |
| `wait` | Wait for lifecycle state |
| `read` | Read the resolved agent terminal stream |
| `send_keys` | Send validated logical keys to the agent UI |
| `focus` | Focus the agent's pane |
| `rename` | Set or clear a live agent name |

Agent targets accept a unique live agent name or the pane ID currently hosting that agent. They do not accept terminal IDs or bare agent-kind labels.

Lifecycle states:

- `working`: actively processing
- `blocked`: waiting for approval or an answer
- `done`: ready after unseen background work completed
- `idle`: ready and considered seen
- `unknown`: present, but lifecycle cannot be classified confidently

`prompt` waits by default and settles on the first `idle`, `done`, or `blocked` state unless `until` narrows the accepted states. A prompt submitted from a non-working state must produce an observed lifecycle change within five seconds or Herdr returns `agent_prompt_stalled`.

## Typical workflows

Start a coding agent in a sibling pane:

1. `herdr_layout` `{ "action": "pane_split" }`
2. `herdr_agent` with the returned pane ID:

```json
{
  "action": "start",
  "name": "reviewer",
  "kind": "codex",
  "pane": "w1:p2"
}
```

3. Prompt and wait:

```json
{
  "action": "prompt",
  "target": "reviewer",
  "prompt": "Review the current diff and report only actionable findings.",
  "timeout": 120000
}
```

4. Read the result:

```json
{
  "action": "read",
  "target": "reviewer",
  "source": "recent-unwrapped",
  "lines": 120
}
```

For an ordinary command: split with `herdr_layout`, submit with `herdr_pane` `run`, then `wait_output` or `read`.

## Invocation policy

The tools are opt-in. Use them only when the user explicitly mentions Herdr or asks to inspect or control Herdr. Installing this package does not turn general background work or delegation into a Herdr workflow.

Default topology: sibling pane in the caller's current tab and working directory. Focus remains with the user. Another tab, workspace, worktree, or working directory is used only when requested.

## Output limits

Read output is truncated to the last 2,000 lines or 50KB, whichever is reached first.

Full-screen agents may render through the terminal's alternate screen. Rows that leave that screen do not enter Herdr's host scrollback. If increasing `lines` does not reveal the complete response, ask the agent to write its response to a temporary Markdown file and read that file directly.

## Requirements

- Pi 0.80 or newer
- Herdr 0.7.5 or newer
- Pi running inside a Herdr pane
