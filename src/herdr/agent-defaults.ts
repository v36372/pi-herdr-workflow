import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
  getAgentDir,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedAgentSpawn } from "../workflows/types.js";

export type ResolvedAgentLaunch = {
  spawn: ResolvedAgentSpawn;
  thinking?: string;
  replaceSystemPrompt?: string;
  appendSystemPrompts: string[];
  rolePrompt?: string;
};

type AgentDefinition = {
  path: string;
  source: "project" | "global";
  model?: string;
  thinking?: string;
  tools?: string;
  skills?: string;
  cwd?: string;
  systemPromptMode?: "append" | "replace";
  body?: string;
};

/** Merge explicit spawn params over project/global agent markdown defaults. */
export function resolveAgentLaunch(
  spawn: ResolvedAgentSpawn,
  projectCwd = process.cwd(),
): ResolvedAgentLaunch {
  const baseCwd = path.resolve(projectCwd);
  const definition = spawn.agent ? loadAgentDefinition(spawn.agent, baseCwd) : undefined;
  const cwd = resolveLaunchCwd(spawn.cwd, definition, baseCwd);
  const effectiveSpawn: ResolvedAgentSpawn = {
    ...spawn,
    ...(spawn.model ?? definition?.model
      ? { model: spawn.model ?? definition?.model }
      : {}),
    ...(spawn.tools ?? definition?.tools
      ? { tools: spawn.tools ?? definition?.tools }
      : {}),
    ...(spawn.skills ?? definition?.skills
      ? { skills: spawn.skills ?? definition?.skills }
      : {}),
    ...(cwd ? { cwd } : {}),
  };

  const appendSystemPrompts: string[] = [];
  let replaceSystemPrompt: string | undefined;
  let rolePrompt: string | undefined;
  if (definition?.body) {
    if (definition.systemPromptMode === "replace") {
      replaceSystemPrompt = definition.body;
    } else if (definition.systemPromptMode === "append") {
      appendSystemPrompts.push(definition.body);
    } else {
      // Match pi-interactive-subagents: without system-prompt frontmatter,
      // the agent body is delivered as role instructions in the user prompt.
      rolePrompt = definition.body;
    }
  }
  if (spawn.systemPrompt) {
    if (definition?.systemPromptMode === "replace" && !definition.body) {
      replaceSystemPrompt = spawn.systemPrompt;
    } else {
      appendSystemPrompts.push(spawn.systemPrompt);
    }
  }

  return {
    spawn: effectiveSpawn,
    ...(spawn.thinking ?? definition?.thinking
      ? { thinking: spawn.thinking ?? definition?.thinking }
      : {}),
    ...(replaceSystemPrompt ? { replaceSystemPrompt } : {}),
    appendSystemPrompts,
    ...(rolePrompt ? { rolePrompt } : {}),
  };
}

/** Expand named skills using Pi's own resource discovery and skill block format. */
export async function preloadSkills(
  prompt: string,
  skills: string | undefined,
  cwd: string,
): Promise<string> {
  const names = [...new Set(splitList(skills))];
  if (names.length === 0) return prompt;

  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const discovered = new Map(loader.getSkills().skills.map((skill) => [skill.name, skill]));
  const selected = names.map((name) => {
    const skill = discovered.get(name);
    if (!skill) throw new Error(`Skill "${name}" was not found for cwd ${cwd}`);
    return skill;
  });

  return `${selected.map(expandSkill).join("\n\n")}\n\n${prompt}`;
}

function loadAgentDefinition(name: string, projectCwd: string): AgentDefinition {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid agent name "${name}"`);
  }
  const agentDir = getAgentDir();
  const candidates: Array<{ path: string; source: AgentDefinition["source"] }> = [
    { path: path.join(projectCwd, ".pi", "agents", `${name}.md`), source: "project" },
    { path: path.join(agentDir, "agents", `${name}.md`), source: "global" },
  ];
  const candidate = candidates.find((entry) => existsSync(entry.path));
  if (!candidate) {
    throw new Error(
      `Agent "${name}" was not found in ${path.join(projectCwd, ".pi", "agents")} or ${path.join(agentDir, "agents")}`,
    );
  }

  const content = readFileSync(candidate.path, "utf8");
  const match = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`Agent definition has no YAML frontmatter: ${candidate.path}`);
  const frontmatter = match[1]!;
  const body = content.slice(match[0].length).trim();
  const systemPromptMode = frontmatterValue(frontmatter, "system-prompt");

  return {
    ...candidate,
    ...(frontmatterValue(frontmatter, "model")
      ? { model: frontmatterValue(frontmatter, "model") }
      : {}),
    ...(frontmatterValue(frontmatter, "thinking")
      ? { thinking: frontmatterValue(frontmatter, "thinking") }
      : {}),
    ...(frontmatterValue(frontmatter, "tools")
      ? { tools: frontmatterValue(frontmatter, "tools") }
      : {}),
    ...(frontmatterValue(frontmatter, "skill") ?? frontmatterValue(frontmatter, "skills")
      ? { skills: frontmatterValue(frontmatter, "skill") ?? frontmatterValue(frontmatter, "skills") }
      : {}),
    ...(frontmatterValue(frontmatter, "cwd")
      ? { cwd: frontmatterValue(frontmatter, "cwd") }
      : {}),
    ...(systemPromptMode === "append" || systemPromptMode === "replace"
      ? { systemPromptMode }
      : {}),
    ...(body ? { body } : {}),
  };
}

function resolveLaunchCwd(
  explicitCwd: string | undefined,
  definition: AgentDefinition | undefined,
  projectCwd: string,
): string | undefined {
  if (explicitCwd) return path.resolve(projectCwd, explicitCwd);
  if (!definition?.cwd) return undefined;
  const base = definition.source === "global" ? getAgentDir() : projectCwd;
  return path.resolve(base, definition.cwd);
}

function frontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim();
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function expandSkill(skill: Skill): string {
  const content = readFileSync(skill.filePath, "utf8");
  const body = content
    .replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .trim();
  return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}
