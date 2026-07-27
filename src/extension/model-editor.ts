import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  fuzzyFilter,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import {
  effectiveModelLabel,
  resolveModelInput,
  type WorkflowAgentStep,
  type WorkflowModelOverrides,
} from "./launch.js";

export type AgentModelEditorResult =
  | { kind: "done"; overrides: WorkflowModelOverrides }
  | { kind: "cancelled" };

type ModelEditorTheme = Pick<Theme, "bold" | "fg">;

type EditorRow =
  | {
      kind: "step";
      step: WorkflowAgentStep;
      /** Applied override. Empty means keep the authored default. */
      text: string;
    }
  | { kind: "done" }
  | { kind: "reset" };

type EditorMode =
  | { kind: "navigate" }
  | {
      kind: "edit";
      rowIndex: number;
      originalText: string;
      draft: string;
      cursor: number;
      suggestionIndex: number | undefined;
    };

type InputOutcome = "open" | "closed";

/**
 * Floating vim-style agent-model editor.
 *
 * Navigate: j/k or arrows move, Enter edits, q/Esc accepts and exits.
 * Edit: type to filter scoped models, arrows or Ctrl-j/k choose, Enter applies,
 * Esc cancels the edit while keeping the step's previous override/default.
 */
export class AgentModelEditor implements Component {
  readonly width = 78;
  focused = false;

  private selected = 0;
  private mode: EditorMode = { kind: "navigate" };
  private readonly rows: EditorRow[];
  private readonly modelSuggestions: string[];
  private readonly theme: ModelEditorTheme;
  private readonly title: string;
  private readonly done: (result: AgentModelEditorResult) => void;
  private readonly requestRender: () => void;
  private message: string | undefined;

  constructor(args: {
    theme: ModelEditorTheme;
    workflowName: string;
    steps: WorkflowAgentStep[];
    modelSuggestions: string[];
    initialOverrides?: WorkflowModelOverrides;
    done: (result: AgentModelEditorResult) => void;
    requestRender?: () => void;
  }) {
    this.theme = args.theme;
    this.title = `Agent models · ${args.workflowName}`;
    this.done = args.done;
    this.requestRender = args.requestRender ?? (() => {});
    this.modelSuggestions = [...new Set(args.modelSuggestions)];
    const initial = args.initialOverrides ?? {};
    this.rows = [
      ...args.steps.map(
        (step): EditorRow => ({
          kind: "step",
          step,
          text: initial[step.nodeId] ?? "",
        }),
      ),
      { kind: "done" },
      { kind: "reset" },
    ];
  }

  handleInput(data: string): void {
    const outcome =
      this.mode.kind === "edit"
        ? this.handleEditInput(data, this.mode)
        : this.handleNavigationInput(data);
    if (outcome === "open") this.requestRender();
  }

  private handleNavigationInput(data: string): InputOutcome {
    if (matchesKey(data, "escape") || data === "q") {
      this.done({ kind: "done", overrides: this.collectOverrides() });
      return "closed";
    }

    if (matchesKey(data, "up") || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
      this.message = undefined;
      return "open";
    }
    if (matchesKey(data, "down") || data === "j") {
      this.selected = Math.min(this.rows.length - 1, this.selected + 1);
      this.message = undefined;
      return "open";
    }

    if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      return this.activateRow();
    }
    return "open";
  }

  private handleEditInput(data: string, mode: Extract<EditorMode, { kind: "edit" }>): InputOutcome {
    if (matchesKey(data, "escape")) {
      this.mode = { kind: "navigate" };
      this.message = "Edit cancelled; previous model kept";
      return "open";
    }

    const suggestions = this.filteredSuggestions(mode.draft);
    // Ctrl-j is encoded as LF, which also matches Enter; handle it first.
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+k")) {
      if (suggestions.length > 0) {
        mode.suggestionIndex =
          mode.suggestionIndex === undefined || mode.suggestionIndex === 0
            ? suggestions.length - 1
            : mode.suggestionIndex - 1;
      }
      return "open";
    }
    if (matchesKey(data, "down") || matchesKey(data, "ctrl+j")) {
      if (suggestions.length > 0) {
        mode.suggestionIndex =
          mode.suggestionIndex === undefined || mode.suggestionIndex === suggestions.length - 1
            ? 0
            : mode.suggestionIndex + 1;
      }
      return "open";
    }

    if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      this.applyEdit(mode);
      return "open";
    }
    if (matchesKey(data, "tab")) {
      const suggestion = suggestions[mode.suggestionIndex ?? 0];
      if (suggestion) {
        mode.draft = suggestion;
        mode.cursor = suggestion.length;
        mode.suggestionIndex = 0;
      }
      return "open";
    }

    if (matchesKey(data, "backspace")) {
      if (mode.cursor > 0) {
        mode.draft = mode.draft.slice(0, mode.cursor - 1) + mode.draft.slice(mode.cursor);
        mode.cursor -= 1;
        this.updateSuggestionSelection(mode);
      }
      return "open";
    }
    if (matchesKey(data, "left")) {
      mode.cursor = Math.max(0, mode.cursor - 1);
      return "open";
    }
    if (matchesKey(data, "right")) {
      mode.cursor = Math.min(mode.draft.length, mode.cursor + 1);
      return "open";
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      mode.draft = mode.draft.slice(0, mode.cursor) + data + mode.draft.slice(mode.cursor);
      mode.cursor += 1;
      this.updateSuggestionSelection(mode);
    }
    return "open";
  }

  private updateSuggestionSelection(mode: Extract<EditorMode, { kind: "edit" }>): void {
    mode.suggestionIndex = mode.draft.trim() && this.filteredSuggestions(mode.draft).length > 0 ? 0 : undefined;
    this.message = undefined;
  }

  private activateRow(): InputOutcome {
    const row = this.rows[this.selected];
    if (!row) return "open";

    if (row.kind === "done") {
      this.done({ kind: "done", overrides: this.collectOverrides() });
      return "closed";
    }
    if (row.kind === "reset") {
      for (const candidate of this.rows) {
        if (candidate.kind === "step") candidate.text = "";
      }
      this.message = "All steps reset to workflow defaults";
      this.selected = 0;
      return "open";
    }

    this.mode = {
      kind: "edit",
      rowIndex: this.selected,
      originalText: row.text,
      draft: row.text,
      cursor: row.text.length,
      suggestionIndex: row.text ? 0 : undefined,
    };
    this.message = undefined;
    return "open";
  }

  private applyEdit(mode: Extract<EditorMode, { kind: "edit" }>): void {
    const row = this.rows[mode.rowIndex];
    if (!row || row.kind !== "step") {
      this.mode = { kind: "navigate" };
      return;
    }

    const suggestions = this.filteredSuggestions(mode.draft);
    const raw =
      mode.suggestionIndex === undefined
        ? mode.draft
        : suggestions[mode.suggestionIndex] ?? mode.draft;
    const resolved = resolveModelInput(raw, row.step.defaultModel);
    if (resolved.kind === "override") {
      row.text = resolved.model;
      this.message = `${row.step.nodeId} → ${resolved.model}`;
    } else if (resolved.kind === "default") {
      row.text = "";
      this.message = `${row.step.nodeId} → default`;
    } else {
      row.text = mode.originalText;
      this.message = `Invalid ${JSON.stringify(resolved.raw)}; previous model kept for ${row.step.nodeId}`;
    }
    this.mode = { kind: "navigate" };
  }

  private filteredSuggestions(query: string): string[] {
    const trimmed = query.trim();
    return trimmed
      ? fuzzyFilter(this.modelSuggestions, trimmed, (model) => model)
      : this.modelSuggestions;
  }

  private collectOverrides(): WorkflowModelOverrides {
    const overrides: WorkflowModelOverrides = {};
    for (const row of this.rows) {
      if (row.kind !== "step") continue;
      const resolved = resolveModelInput(row.text, row.step.defaultModel);
      if (resolved.kind === "override") overrides[row.step.nodeId] = resolved.model;
    }
    return overrides;
  }

  render(availableWidth: number): string[] {
    const th = this.theme;
    const w = Math.max(2, Math.min(this.width, availableWidth));
    const innerW = w - 2;
    const lines: string[] = [];
    const pad = (text: string, length: number) =>
      text + " ".repeat(Math.max(0, length - visibleWidth(text)));
    const bordered = (content: string) => {
      const fitted = truncateToWidth(content, innerW, "");
      return th.fg("border", "│") + pad(fitted, innerW) + th.fg("border", "│");
    };

    lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
    lines.push(bordered(` ${th.fg("accent", th.bold(this.title))}`));
    lines.push(
      bordered(
        ` ${th.fg(
          "dim",
          this.mode.kind === "navigate"
            ? "j/k move · Enter edit · q/Esc accept & exit"
            : "type to filter scoped models · ↑↓/Ctrl-j/k choose · Tab complete · Enter apply · Esc cancel edit",
        )}`,
      ),
    );
    lines.push(bordered(""));

    for (let index = 0; index < this.rows.length; index++) {
      const item = this.rows[index]!;
      const selected = index === this.selected;
      const prefix = selected ? th.fg("accent", " ▶ ") : "   ";

      if (item.kind === "done") {
        const label = selected
          ? th.fg("success", th.bold("Done — run with these models"))
          : "Done — run with these models";
        lines.push(bordered(`${prefix}${label}`));
        continue;
      }
      if (item.kind === "reset") {
        const label = selected
          ? th.fg("warning", "Reset all to defaults")
          : th.fg("dim", "Reset all to defaults");
        lines.push(bordered(`${prefix}${label}`));
        continue;
      }

      const name = selected
        ? th.fg("accent", `${item.step.label} (${item.step.nodeId})`)
        : `${item.step.label} (${item.step.nodeId})`;
      let modelCell = th.fg(
        "dim",
        effectiveModelLabel(
          item.step,
          item.text ? { [item.step.nodeId]: item.text } : {},
        ),
      );

      if (this.mode.kind === "edit" && this.mode.rowIndex === index) {
        const before = this.mode.draft.slice(0, this.mode.cursor);
        const cursorChar =
          this.mode.cursor < this.mode.draft.length ? this.mode.draft[this.mode.cursor]! : " ";
        const after = this.mode.draft.slice(this.mode.cursor + 1);
        const marker = this.focused ? CURSOR_MARKER : "";
        const input = `${before}${marker}\x1b[7m${cursorChar}\x1b[27m${after}`;
        const hint =
          this.mode.draft.length === 0
            ? th.fg(
                "dim",
                item.step.defaultModel
                  ? ` default ${item.step.defaultModel}`
                  : " Pi default",
              )
            : "";
        modelCell = input + hint;
      }

      lines.push(bordered(`${prefix}${name}`));
      lines.push(bordered(`     model: ${modelCell}`));
    }

    if (this.mode.kind === "edit") {
      lines.push(bordered(""));
      lines.push(bordered(` ${th.fg("muted", "Scoped model suggestions")}`));
      const suggestions = this.filteredSuggestions(this.mode.draft);
      const visible = visibleSuggestionSlice(suggestions, this.mode.suggestionIndex, 5);
      if (visible.length === 0) {
        lines.push(
          bordered(
            `   ${th.fg(
              "dim",
              this.modelSuggestions.length === 0
                ? "No scoped models available"
                : "No match · Enter validates provider/id",
            )}`,
          ),
        );
      } else {
        for (const suggestion of visible) {
          const suggestionIndex = suggestions.indexOf(suggestion);
          const active = suggestionIndex === this.mode.suggestionIndex;
          lines.push(
            bordered(
              active
                ? ` ${th.fg("accent", `→ ${suggestion}`)}`
                : `   ${th.fg("dim", suggestion)}`,
            ),
          );
        }
      }
    }

    if (this.message) {
      lines.push(bordered(""));
      lines.push(bordered(` ${th.fg("warning", this.message)}`));
    }

    lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
    return lines;
  }

  invalidate(): void {}
  dispose(): void {}
}

function visibleSuggestionSlice(
  suggestions: string[],
  selected: number | undefined,
  limit: number,
): string[] {
  if (suggestions.length <= limit) return suggestions;
  const center = selected ?? 0;
  const start = Math.max(
    0,
    Math.min(center - Math.floor(limit / 2), suggestions.length - limit),
  );
  return suggestions.slice(start, start + limit);
}
