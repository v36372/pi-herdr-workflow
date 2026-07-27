import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DONE_AGENT_MODELS_OPTION,
  RESET_AGENT_MODELS_OPTION,
  applyModelOverrides,
  buildAgentModelMenuOptions,
  buildWorkflowLaunchPrompt,
  effectiveModelLabel,
  filterModelRefsByScope,
  formatAgentStepOption,
  formatModelRef,
  formatWorkflowOption,
  isDoneAgentModelsOption,
  isResetAgentModelsOption,
  isValidModelRef,
  listAgentSteps,
  modelInputHint,
  modelInputTitle,
  parseAgentStepOption,
  parseWorkflowOption,
  resolveModelInput,
} from "../src/extension/launch.ts";
import { agent, compute, decision, defineWorkflow } from "../src/index.ts";

const workflow = defineWorkflow({
  name: "launch-demo",
  startAt: "scout",
  nodes: {
    scout: agent({
      statusDetail: "Scout code",
      spawn: { name: "scout", model: "openai-codex/gpt-5.6-luna", tools: "read" },
      prompt: () => "scout",
    }),
    route: decision({
      statusDetail: "Pick route",
      spawn: { name: "router", tools: "workflow_done" },
      question: () => "ship or fix?",
      choices: ["ship", "fix"] as const,
    }),
    pack: compute({ run: () => ({ ok: true }) }),
  },
  edges: [
    { from: "scout", to: "route" },
    {
      from: "route",
      switch: { on: "$.route", cases: { ship: "pack", fix: "pack" } },
    },
  ],
});

test("workflow option labels round-trip the discover name", () => {
  const option = formatWorkflowOption({
    name: "risk-route",
    path: "/tmp/risk-route.workflow.ts",
    source: "project",
  });
  assert.equal(option, "risk-route  · project");
  assert.equal(parseWorkflowOption(option), "risk-route");
});

test("listAgentSteps includes agent and decision nodes only", () => {
  const steps = listAgentSteps(workflow);
  assert.deepEqual(
    steps.map((step) => step.nodeId),
    ["scout", "route"],
  );
  assert.equal(steps[0]?.label, "Scout code");
  assert.equal(steps[0]?.defaultModel, "openai-codex/gpt-5.6-luna");
  assert.equal(steps[1]?.label, "Pick route");
  assert.equal(steps[1]?.defaultModel, undefined);

  const withPiDefault = listAgentSteps(workflow, "openai-codex/gpt-5.6-sol");
  assert.equal(withPiDefault[0]?.defaultModel, "openai-codex/gpt-5.6-luna");
  assert.equal(withPiDefault[1]?.defaultModel, "openai-codex/gpt-5.6-sol");
});

test("applyModelOverrides only rewrites named agent nodes", () => {
  const next = applyModelOverrides(workflow, {
    scout: "anthropic/claude-sonnet-4-5",
    pack: "should-ignore",
    missing: "should-ignore",
  });
  assert.notEqual(next, workflow);
  assert.equal(next.nodes.scout?.nodeType, "agent");
  if (next.nodes.scout?.nodeType === "agent") {
    assert.equal(next.nodes.scout.spawn?.model, "anthropic/claude-sonnet-4-5");
    assert.equal(next.nodes.scout.spawn?.name, "scout");
    assert.equal(next.nodes.scout.spawn?.tools, "read");
  }
  if (workflow.nodes.scout?.nodeType === "agent") {
    assert.equal(workflow.nodes.scout.spawn?.model, "openai-codex/gpt-5.6-luna");
  }
  assert.equal(next.nodes.pack?.nodeType, "compute");
});

test("agent model menu lists steps with live overrides and action rows", () => {
  const steps = listAgentSteps(workflow);
  const overrides = { scout: "anthropic/claude-sonnet-4-5" };
  const options = buildAgentModelMenuOptions(steps, overrides);

  assert.equal(options.at(-2), DONE_AGENT_MODELS_OPTION);
  assert.equal(options.at(-1), RESET_AGENT_MODELS_OPTION);
  assert.equal(isDoneAgentModelsOption(DONE_AGENT_MODELS_OPTION), true);
  assert.equal(isResetAgentModelsOption(RESET_AGENT_MODELS_OPTION), true);

  assert.equal(
    formatAgentStepOption(steps[0]!, {}),
    "scout  · Scout code  · openai-codex/gpt-5.6-luna (default)",
  );
  assert.equal(
    formatAgentStepOption(steps[0]!, overrides),
    "scout  · Scout code  · anthropic/claude-sonnet-4-5",
  );
  assert.equal(
    formatAgentStepOption(steps[1]!, {}),
    "route  · Pick route  · (workflow default)",
  );
  assert.equal(parseAgentStepOption(options[0]!), "scout");
  assert.equal(effectiveModelLabel(steps[0]!, overrides), "anthropic/claude-sonnet-4-5");
  assert.equal(formatModelRef({ provider: "anthropic", id: "claude-sonnet-4-5" }), "anthropic/claude-sonnet-4-5");
});

test("filterModelRefsByScope preserves configured scope order and globs", () => {
  const models = [
    { provider: "openai-codex", id: "gpt-5.6-luna" },
    { provider: "openai-codex", id: "gpt-5.6-terra" },
    { provider: "cursor", id: "composer-2.5" },
  ];

  assert.deepEqual(filterModelRefsByScope(models, undefined), [
    "openai-codex/gpt-5.6-luna",
    "openai-codex/gpt-5.6-terra",
    "cursor/composer-2.5",
  ]);
  assert.deepEqual(
    filterModelRefsByScope(models, ["cursor/composer-2.5", "openai-codex/gpt-5.6-*:high"]),
    [
      "cursor/composer-2.5",
      "openai-codex/gpt-5.6-luna",
      "openai-codex/gpt-5.6-terra",
    ],
  );
});

test("resolveModelInput treats empty, cancel, and invalid as default", () => {
  assert.deepEqual(resolveModelInput(undefined, "a/b"), { kind: "default" });
  assert.deepEqual(resolveModelInput("", "a/b"), { kind: "default" });
  assert.deepEqual(resolveModelInput("   ", "a/b"), { kind: "default" });
  assert.deepEqual(resolveModelInput("a/b", "a/b"), { kind: "default" });
  assert.deepEqual(resolveModelInput("not-a-model", "a/b"), {
    kind: "invalid",
    raw: "not-a-model",
  });
  assert.deepEqual(resolveModelInput("anthropic/claude-sonnet-4-5", "a/b"), {
    kind: "override",
    model: "anthropic/claude-sonnet-4-5",
  });
  assert.equal(isValidModelRef("openai-codex/gpt-5.6-luna"), true);
  assert.equal(isValidModelRef("nope"), false);
  assert.equal(
    modelInputTitle({ nodeId: "scout", label: "Scout code", defaultModel: "x/y" }),
    "Model for Scout code (scout)",
  );
  assert.match(modelInputHint({ nodeId: "scout", label: "Scout", defaultModel: "x/y" }), /x\/y/);
  assert.match(modelInputHint({ nodeId: "route", label: "Pick" }), /provider\/model/);
});

test("launch prompt asks for one workflow tool call with overrides", () => {
  const prompt = buildWorkflowLaunchPrompt({
    name: "echo",
    input: { task: "hi" },
    modelOverrides: { reply: "anthropic/claude-sonnet-4-5" },
  });
  assert.match(prompt, /Call the `workflow` tool exactly once/);
  assert.match(prompt, /"name":"echo"/);
  assert.match(prompt, /"modelOverrides":\{"reply":"anthropic\/claude-sonnet-4-5"\}/);
});
