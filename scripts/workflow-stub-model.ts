/**
 * Offline stub model for exercising workflow spawn without provider credentials.
 *
 * Registers `workflow-stub/echo`. When the `workflow` tool is present it calls
 * that tool from a `/workflow` launch prompt. When `workflow_done` is present
 * it submits a JSON payload guessed from the step contract.
 *
 *   pi -ne -e ./src/extension/index.ts -e ./scripts/workflow-stub-model.ts \
 *     --model workflow-stub/echo -p "/workflow examples/hello.workflow.ts"
 */
import {
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: ZERO_COST,
};

export default function (pi: ExtensionAPI) {
  pi.registerProvider("workflow-stub", {
    name: "Workflow stub",
    baseUrl: "http://127.0.0.1:0",
    apiKey: "stub",
    api: "workflow-stub",
    models: [
      {
        id: "echo",
        name: "Workflow stub echo",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ],
    streamSimple(model, context, options) {
      return streamStub(model, context, options);
    },
  });
}

function streamStub(
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    if (options?.signal?.aborted) {
      const aborted = assistantMessage(model, [], "aborted");
      aborted.errorMessage = "aborted";
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end();
      return;
    }
    const output = respond(model, context);
    stream.push({ type: "start", partial: output });
    for (const [contentIndex, block] of output.content.entries()) {
      if (block.type === "toolCall") {
        stream.push({ type: "toolcall_start", contentIndex, partial: output });
        stream.push({
          type: "toolcall_end",
          contentIndex,
          toolCall: block,
          partial: output,
        });
      } else if (block.type === "text") {
        stream.push({ type: "text_start", contentIndex, partial: output });
        stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: output });
        stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
      }
    }
    stream.push({
      type: "done",
      reason: output.stopReason === "toolUse" ? "toolUse" : "stop",
      message: output,
    });
    stream.end();
  })();
  return stream;
}

function respond(model: Model<string>, context: Context): AssistantMessage {
  const toolNames = new Set((context.tools ?? []).map((tool) => tool.name));
  const last = context.messages.at(-1);

  if (last?.role === "toolResult") {
    const text = last.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    return assistantMessage(model, [{ type: "text", text: text.trim() || "done" }], "stop");
  }

  const userText = lastUserText(context);

  if (toolNames.has("workflow") && /Call the `workflow` tool/.test(userText)) {
    const args = parseWorkflowInvocation(userText);
    return assistantMessage(
      model,
      [{ type: "toolCall", id: "stub-workflow", name: "workflow", arguments: args }],
      "toolUse",
    );
  }

  if (toolNames.has("workflow_done")) {
    return assistantMessage(
      model,
      [
        {
          type: "toolCall",
          id: "stub-done",
          name: "workflow_done",
          arguments: { output: guessWorkflowOutput(userText) },
        },
      ],
      "toolUse",
    );
  }

  return assistantMessage(model, [{ type: "text", text: "ok" }], "stop");
}

function assistantMessage(
  model: Model<string>,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

function lastUserText(context: Context): string {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
  }
  return "";
}

function parseWorkflowInvocation(text: string): Record<string, unknown> {
  const match = text.match(/with these arguments:\s*(\{[\s\S]*\})/);
  if (!match?.[1]) return { name: "hello", input: {} };
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to a named-workflow guess.
  }
  const named = text.match(/Run the deterministic workflow "([^"]+)"/);
  return { name: named?.[1] ?? "hello", input: {} };
}

export function guessWorkflowOutput(prompt: string): unknown {
  const quotedEcho = prompt.match(
    /Echo (?:seed |this exact string in the echo field: )("(?:\\.|[^"\\])*")/,
  );
  if (quotedEcho?.[1]) {
    return { echo: JSON.parse(quotedEcho[1]) };
  }
  const seedEcho = prompt.match(/Echo seed ("(?:\\.|[^"\\])*") in the echo field/);
  if (seedEcho?.[1]) {
    return { echo: JSON.parse(seedEcho[1]) };
  }
  const picked = prompt.match(/Previous node picked the word: ([A-Za-z]+)/);
  if (picked?.[1]) {
    return { shout: picked[1].toUpperCase() };
  }
  const listed = prompt.match(/exactly one of:\s*((?:"[^"]+"\s*(?:\||,)\s*)*"[^"]+")/i);
  if (listed?.[1]) {
    const choices = [...listed[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    if (choices[0]) {
      return { route: choices[0], reason: "stub" };
    }
  }
  const concise = prompt.match(/Answer concisely:\s*([\s\S]+?)(?:\n---|\nExpected output:|$)/);
  if (concise?.[1]?.trim()) {
    return { reply: concise[1].trim().slice(0, 200) };
  }
  const fromExpected = guessFromExpected(prompt);
  if (fromExpected) return fromExpected;
  return { reply: "stub", echo: "stub", ok: true };
}

function guessFromExpected(prompt: string): Record<string, unknown> | null {
  const expected = prompt.match(/Expected output:\s*`?(\{[\s\S]*?\})`?/);
  if (!expected?.[1]) return null;
  const keys = [...expected[1].matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g)].map(
    (match) => match[1]!,
  );
  if (keys.length === 0) return null;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key === "ok" || key === "retry") out[key] = true;
    else if (key === "reason") out[key] = "stub";
    else out[key] = "stub";
  }
  return out;
}
