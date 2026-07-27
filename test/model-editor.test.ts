import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentModelEditor,
  type AgentModelEditorResult,
} from "../src/extension/model-editor.ts";

const theme = {
  fg: (_color: Parameters<Theme["fg"]>[0], text: string) => text,
  bold: (text: string) => text,
} satisfies Pick<Theme, "bold" | "fg">;

const ENTER = "\r";
const ESCAPE = "\x1b";
const CTRL_J = "\n";
const CTRL_K = "\x0b";

const steps = [
  { nodeId: "scout", label: "Scout", defaultModel: "openai-codex/gpt-default" },
  { nodeId: "route", label: "Route" },
];

function type(editor: AgentModelEditor, value: string): void {
  for (const character of value) editor.handleInput(character);
}

test("vim navigation edits the selected agent and q accepts", () => {
  let result: AgentModelEditorResult | undefined;
  const editor = new AgentModelEditor({
    theme,
    workflowName: "demo",
    steps,
    modelSuggestions: ["openai-codex/gpt-luna", "cursor/composer-2.5"],
    done: (value) => {
      result = value;
    },
  });

  editor.handleInput("j");
  editor.handleInput(ENTER);
  type(editor, "cursor/composer-2.5");
  editor.handleInput(ENTER);
  editor.handleInput("q");

  assert.deepEqual(result, {
    kind: "done",
    overrides: { route: "cursor/composer-2.5" },
  });
});

test("autocomplete arrows choose a scoped model", () => {
  let result: AgentModelEditorResult | undefined;
  const editor = new AgentModelEditor({
    theme,
    workflowName: "demo",
    steps,
    modelSuggestions: [
      "openai-codex/gpt-5.6-luna",
      "openai-codex/gpt-5.6-terra",
    ],
    done: (value) => {
      result = value;
    },
  });

  editor.handleInput(ENTER);
  type(editor, "openai-codex/gpt-5.6");
  editor.handleInput(CTRL_J);
  editor.handleInput(CTRL_K);
  editor.handleInput(CTRL_J);
  editor.handleInput(ENTER);
  editor.handleInput(ESCAPE);

  assert.deepEqual(result, {
    kind: "done",
    overrides: { scout: "openai-codex/gpt-5.6-terra" },
  });
});

test("render truncates long model refs to the available width", () => {
  const editor = new AgentModelEditor({
    theme,
    workflowName: "demo",
    steps,
    modelSuggestions: [
      "provider-with-a-very-long-name/model-with-an-even-longer-name-than-the-overlay",
    ],
    done: () => {},
  });

  editor.handleInput(ENTER);
  assert.equal(editor.render(40).every((line) => visibleWidth(line) <= 40), true);
});

test("q remains printable while editing and Esc cancels only that edit", () => {
  let result: AgentModelEditorResult | undefined;
  const editor = new AgentModelEditor({
    theme,
    workflowName: "demo",
    steps,
    modelSuggestions: ["qoder/model"],
    done: (value) => {
      result = value;
    },
  });

  editor.handleInput(ENTER);
  editor.handleInput("q");
  assert.equal(result, undefined);
  editor.handleInput(ESCAPE);
  assert.equal(result, undefined);
  editor.handleInput("q");

  assert.deepEqual(result, { kind: "done", overrides: {} });
});
