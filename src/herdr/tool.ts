/**
 * Herdr tool — forked from @ogulcancelik/pi-herdr into pi-herdr-workflows.
 * Registered by src/extension/index.ts alongside /workflow.
 * Disable the old package: mv ~/.pi/agent/extensions/pi-herdr{,.disabled}
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { HerdrError } from "./client.js";

type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
type ReadSource = "visible" | "recent" | "recent-unwrapped" | "detection";
type SplitDirection = "right" | "down";

interface WorkspaceInfo {
	workspace_id: string;
	number: number;
	label: string;
	focused: boolean;
	pane_count: number;
	tab_count: number;
	active_tab_id: string;
	agent_status: AgentStatus;
}

interface TabInfo {
	tab_id: string;
	workspace_id: string;
	number: number;
	label: string;
	focused: boolean;
	pane_count: number;
	agent_status: AgentStatus;
}

interface PaneInfo {
	pane_id: string;
	terminal_id?: string;
	workspace_id: string;
	tab_id: string;
	focused: boolean;
	cwd?: string;
	foreground_cwd?: string;
	label?: string;
	agent?: string;
	title?: string;
	agent_status: AgentStatus;
	revision: number;
}

interface AgentInfo {
	terminal_id: string;
	name?: string;
	agent?: string;
	display_agent?: string;
	title?: string;
	agent_status: AgentStatus;
	workspace_id: string;
	tab_id: string;
	pane_id: string;
	focused: boolean;
	cwd?: string;
	revision: number;
}

interface PaneLayoutRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface PaneLayoutSnapshot {
	workspace_id: string;
	tab_id: string;
	zoomed: boolean;
	focused_pane_id: string;
	area: PaneLayoutRect;
	panes: Array<{ pane_id: string; focused: boolean; rect: PaneLayoutRect }>;
	splits: Array<{ id: string; direction: SplitDirection; ratio: number; rect: PaneLayoutRect }>;
}

interface PaneReadResult {
	pane_id: string;
	workspace_id: string;
	tab_id: string;
	source: "visible" | "recent" | "recent_unwrapped";
	text: string;
	revision: number;
	truncated: boolean;
}

interface ManagedPane {
	paneId: string;
	workspaceId: string;
}

interface HerdrJsonEnvelope {
	id?: string;
	result?: any;
	error?: {
		code?: string;
		message?: string;
	};
}

interface HerdrToolDetails {
	action?: string;
	aliases: Record<string, ManagedPane>;
	aliasOrder: string[];
	[key: string]: unknown;
}

const ActionEnum = StringEnum(
	[
		"list",
		"current",
		"workspace_list",
		"workspace_create",
		"workspace_focus",
		"tab_list",
		"tab_create",
		"tab_focus",
		"focus",
		"pane_rename",
		"pane_split",
		"agent_list",
		"agent_get",
		"agent_start",
		"agent_prompt",
		"run",
		"read",
		"watch",
		"wait_agent",
		"send",
		"stop",
	] as const,
	{ description: "Action to perform" },
);

const StatusEnum = StringEnum(["idle", "working", "blocked", "done", "unknown"] as const, {
	description: "Agent status to wait for",
});

const SourceEnum = StringEnum(["visible", "recent", "recent-unwrapped", "detection"] as const, {
	description: "Read source for read/watch; detection is valid for read only",
});

const DirectionEnum = StringEnum(["right", "down"] as const, {
	description: "Split direction for pane_split. When omitted, Herdr chooses from the source pane geometry.",
});

const WaitModeEnum = StringEnum(["all", "any"] as const, {
	description: "How multi-pane waits should resolve",
});

export default function (pi: ExtensionAPI) {
	const herdrEnv = process.env.HERDR_ENV;
	const currentPaneTargetEnv = process.env.HERDR_PANE_ID;
	if (!herdrEnv || !currentPaneTargetEnv) {
		return;
	}
	const managedPanes = new Map<string, ManagedPane>();
	const aliasOrder: string[] = [];

	function snapshotAliases(): Record<string, ManagedPane> {
		return Object.fromEntries(managedPanes.entries());
	}

	function withSnapshot(details: Omit<HerdrToolDetails, "aliases" | "aliasOrder">): HerdrToolDetails {
		return {
			...details,
			aliases: snapshotAliases(),
			aliasOrder: [...aliasOrder],
		};
	}

	function setAliases(aliases: Record<string, ManagedPane>, order: string[]) {
		managedPanes.clear();
		aliasOrder.length = 0;
		for (const [alias, managed] of Object.entries(aliases)) {
			managedPanes.set(alias, managed);
		}
		for (const alias of order) {
			if (managedPanes.has(alias)) aliasOrder.push(alias);
		}
		for (const alias of managedPanes.keys()) {
			if (!aliasOrder.includes(alias)) aliasOrder.push(alias);
		}
	}

	function reconstructState(ctx: ExtensionContext) {
		let aliases: Record<string, ManagedPane> = {};
		let order: string[] = [];

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "toolResult" || message.toolName !== "herdr") continue;
			const details = message.details as HerdrToolDetails | undefined;
			if (!details?.aliases) continue;
			aliases = details.aliases;
			order = Array.isArray(details.aliasOrder) ? details.aliasOrder : Object.keys(details.aliases);
		}

		setAliases(aliases, order);
	}

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	function recordAlias(alias: string, paneId: string, workspaceId: string) {
		managedPanes.set(alias, { paneId, workspaceId });
		const existingIndex = aliasOrder.indexOf(alias);
		if (existingIndex !== -1) aliasOrder.splice(existingIndex, 1);
		aliasOrder.push(alias);
	}

	function forgetAlias(alias: string) {
		managedPanes.delete(alias);
		const index = aliasOrder.indexOf(alias);
		if (index !== -1) aliasOrder.splice(index, 1);
	}

	function parseHerdrFailure(output: string): { code: string; message: string; id?: string } | null {
		const trimmed = output.trim();
		if (!trimmed) return null;
		try {
			const value = JSON.parse(trimmed) as HerdrJsonEnvelope;
			if (!value.error) return null;
			const code = value.error.code?.trim() || "command_failed";
			const message = value.error.message?.trim() || code;
			return value.id ? { code, message, id: value.id } : { code, message };
		} catch {
			return { code: "command_failed", message: trimmed };
		}
	}

	function isAbortError(error: unknown, signal?: AbortSignal): boolean {
		return signal?.aborted === true || (error instanceof Error && error.message === "Aborted");
	}

	async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new Error("Aborted");
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			const onAbort = () => {
				clearTimeout(timeout);
				reject(new Error("Aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	async function execHerdr(args: string[], signal?: AbortSignal) {
		const result = await pi.exec("herdr", args, { signal });
		if (signal?.aborted || result.killed) {
			throw new Error("Aborted");
		}
		if (result.code !== 0) {
			const failure =
				parseHerdrFailure(result.stderr) ||
				parseHerdrFailure(result.stdout) ||
				{
					code: "command_failed",
					message: `herdr ${args.join(" ")} failed with exit code ${result.code}`,
				};
			throw new HerdrError(failure.code, failure.message, {
				args,
				exitCode: result.code,
				...(failure.id ? { id: failure.id } : {}),
			});
		}
		return result;
	}

	async function execHerdrJson<T = any>(args: string[], signal?: AbortSignal): Promise<T> {
		const result = await execHerdr(args, signal);
		const stdout = result.stdout.trim();
		if (!stdout) {
			throw new HerdrError("invalid_response", `Expected JSON output from herdr ${args.join(" ")}`, {
				args,
				exitCode: result.code,
			});
		}
		let value: HerdrJsonEnvelope;
		try {
			value = JSON.parse(stdout) as HerdrJsonEnvelope;
		} catch (cause) {
			throw new HerdrError("invalid_response", `Failed to parse JSON from herdr ${args.join(" ")}`, {
				args,
				exitCode: result.code,
				cause,
			});
		}
		if (value.error) {
			const code = value.error.code?.trim() || "command_failed";
			const message = value.error.message?.trim() || code;
			throw new HerdrError(code, message, {
				args,
				exitCode: result.code,
				...(value.id ? { id: value.id } : {}),
			});
		}
		return value as T;
	}

	async function execHerdrText(args: string[], signal?: AbortSignal): Promise<string> {
		const result = await execHerdr(args, signal);
		return result.stdout;
	}

	async function getCurrentPaneInfo(signal?: AbortSignal): Promise<PaneInfo> {
		const response = await execHerdrJson<{ result: { pane: PaneInfo } }>(["pane", "current", "--current"], signal);
		return response.result.pane;
	}

	async function getWorkspaceInfo(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceInfo> {
		const response = await execHerdrJson<{ result: { workspace: WorkspaceInfo } }>([
			"workspace",
			"get",
			workspaceId,
		], signal);
		return response.result.workspace;
	}

	async function getWorkspaceList(signal?: AbortSignal): Promise<WorkspaceInfo[]> {
		const response = await execHerdrJson<{ result: { workspaces: WorkspaceInfo[] } }>(["workspace", "list"], signal);
		return response.result.workspaces || [];
	}

	async function getWorkspacePanes(workspaceId: string, signal?: AbortSignal): Promise<PaneInfo[]> {
		const response = await execHerdrJson<{ result: { panes: PaneInfo[] } }>([
			"pane",
			"list",
			"--workspace",
			workspaceId,
		], signal);
		return response.result.panes || [];
	}

	async function getTabList(workspaceId?: string, signal?: AbortSignal): Promise<TabInfo[]> {
		const args = ["tab", "list"];
		if (workspaceId) args.push("--workspace", workspaceId);
		const response = await execHerdrJson<{ result: { tabs: TabInfo[] } }>(args, signal);
		return response.result.tabs || [];
	}

	async function getPaneInfo(paneId: string, signal?: AbortSignal): Promise<PaneInfo | null> {
		try {
			const response = await execHerdrJson<{ result: { pane: PaneInfo } }>(["pane", "get", paneId], signal);
			return response.result.pane;
		} catch (error) {
			if (isAbortError(error, signal)) throw error;
			return null;
		}
	}

	async function getPaneLayout(paneId: string, signal?: AbortSignal): Promise<PaneLayoutSnapshot> {
		const response = await execHerdrJson<{ result: { layout: PaneLayoutSnapshot } }>(
			["pane", "layout", "--pane", paneId],
			signal,
		);
		return response.result.layout;
	}

	async function getAgentList(signal?: AbortSignal): Promise<AgentInfo[]> {
		const response = await execHerdrJson<{ result: { agents: AgentInfo[] } }>(["agent", "list"], signal);
		return response.result.agents || [];
	}

	async function getAgentInfo(target: string, signal?: AbortSignal): Promise<AgentInfo> {
		const response = await execHerdrJson<{ result: { agent: AgentInfo } }>(["agent", "get", target], signal);
		return response.result.agent;
	}

	function chooseSplitDirection(layout: PaneLayoutSnapshot, paneId: string): SplitDirection {
		const pane = layout.panes.find((candidate) => candidate.pane_id === paneId);
		if (!pane) return "right";
		return pane.rect.width >= 80 && pane.rect.width >= pane.rect.height * 2 ? "right" : "down";
	}

	async function resolvePaneRef(
		ref: string,
		signal?: AbortSignal,
	): Promise<{ pane: PaneInfo; alias?: string } | null> {
		const managed = managedPanes.get(ref);
		if (managed) {
			const pane = await getPaneInfo(managed.paneId, signal);
			if (!pane) {
				forgetAlias(ref);
				return null;
			}
			managed.workspaceId = pane.workspace_id;
			return { pane, alias: ref };
		}

		const pane = await getPaneInfo(ref, signal);
		if (!pane) return null;
		const alias = [...managedPanes.entries()].find(([, managedPane]) => managedPane.paneId === pane.pane_id)?.[0];
		return { pane, alias };
	}

	async function requirePaneRef(
		ref: string,
		signal?: AbortSignal,
	): Promise<{ pane: PaneInfo; alias?: string }> {
		const hadAlias = managedPanes.has(ref);
		const resolved = await resolvePaneRef(ref, signal);
		if (resolved) return resolved;
		if (hadAlias) {
			throw new Error(`Pane alias '${ref}' no longer points to a live pane and was removed.`);
		}
		throw new Error(`Pane '${ref}' not found.`);
	}

	async function readPane(
		paneId: string,
		options: { source?: ReadSource; lines?: number; raw?: boolean },
		signal?: AbortSignal,
	): Promise<string> {
		const args = ["pane", "read", paneId];
		if (options.source) args.push("--source", options.source);
		if (options.lines != null) args.push("--lines", String(options.lines));
		if (options.raw) args.push("--raw");
		return execHerdrText(args, signal);
	}

	async function readAgent(
		target: string,
		options: { source?: ReadSource; lines?: number; raw?: boolean },
		signal?: AbortSignal,
	): Promise<string> {
		const args = ["agent", "read", target];
		if (options.source) args.push("--source", options.source);
		if (options.lines != null) args.push("--lines", String(options.lines));
		if (options.raw) args.push("--ansi");
		return execHerdrText(args, signal);
	}

	/** Prefer explicit agent targets; otherwise use a live agent hosted by the pane. */
	async function resolveControlTarget(
		params: { agent?: string; pane?: string },
		signal?: AbortSignal,
	): Promise<
		| { kind: "agent"; target: string; label: string; pane?: PaneInfo; alias?: string }
		| { kind: "pane"; pane: PaneInfo; alias?: string }
	> {
		if (params.agent) {
			let target = params.agent;
			if (managedPanes.has(target)) {
				target = (await requirePaneRef(target, signal)).pane.pane_id;
			}
			const agent = await getAgentInfo(target, signal);
			// Prefer a unique live name when present; pane ids remain valid targets.
			const cliTarget = agent.name || target;
			return {
				kind: "agent",
				target: cliTarget,
				label: agentDisplayName(agent),
				pane: {
					pane_id: agent.pane_id,
					workspace_id: agent.workspace_id,
					tab_id: agent.tab_id,
					focused: agent.focused,
					agent_status: agent.agent_status,
					revision: agent.revision,
					...(agent.cwd ? { cwd: agent.cwd } : {}),
					...(agent.agent ? { agent: agent.agent } : {}),
					...(agent.title ? { title: agent.title } : {}),
				},
			};
		}
		if (!params.pane) {
			throw new Error("'agent' or 'pane' is required");
		}
		const resolved = await requirePaneRef(params.pane, signal);
		if (resolved.pane.agent_status !== "unknown") {
			try {
				const agent = await getAgentInfo(resolved.pane.pane_id, signal);
				return {
					kind: "agent",
					// Pane id is a stable CLI target for the hosted agent.
					target: agent.name || resolved.pane.pane_id,
					label: agentDisplayName(agent),
					pane: resolved.pane,
					alias: resolved.alias,
				};
			} catch (error) {
				if (isAbortError(error, signal)) throw error;
				// Fall through to pane primitives for ordinary terminals.
			}
		}
		return { kind: "pane", pane: resolved.pane, alias: resolved.alias };
	}

	function formatReadOutput(output: string): string {
		const truncation = truncateTail(output, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});

		let text = truncation.content;
		if (truncation.truncated) {
			text = `[Showing last ${truncation.outputLines} of ${truncation.totalLines} lines]\n${text}`;
		}
		return text;
	}

	function summarizePane(pane: PaneInfo, alias?: string, currentPaneId?: string): string {
		const name = alias || pane.label || pane.pane_id;
		const flags = [
			pane.pane_id === currentPaneId || pane.focused ? "current" : null,
			pane.agent ? pane.agent : null,
			pane.agent_status !== "unknown" ? pane.agent_status : null,
		]
			.filter(Boolean)
			.join(", ");
		const cwd = pane.cwd ? ` ${pane.cwd}` : "";
		return `${name}: [${pane.pane_id}]${flags ? ` (${flags})` : ""}${cwd}`;
	}

	function agentDisplayName(agent: AgentInfo): string {
		return agent.name || agent.display_agent || agent.agent || agent.pane_id;
	}

	function summarizeAgent(agent: AgentInfo): string {
		const name = agentDisplayName(agent);
		const flags = [agent.focused ? "focused" : null, agent.agent_status].filter(Boolean).join(", ");
		const cwd = agent.cwd ? ` ${agent.cwd}` : "";
		return `${name}: [${agent.pane_id}] (${flags})${cwd}`;
	}

	function summarizeTab(tab: TabInfo): string {
		const flags = [tab.focused ? "focused" : null, tab.agent_status !== "unknown" ? tab.agent_status : null]
			.filter(Boolean)
			.join(", ");
		return `${tab.label}: [${tab.tab_id}]${flags ? ` (${flags})` : ""}`;
	}

	function summarizeWorkspace(workspace: WorkspaceInfo): string {
		const flags = [workspace.focused ? "focused" : null, workspace.agent_status !== "unknown" ? workspace.agent_status : null]
			.filter(Boolean)
			.join(", ");
		return `${workspace.label}: [${workspace.workspace_id}]${flags ? ` (${flags})` : ""}`;
	}

	function rejectUnexpectedParams(
		action: string,
		params: { workspace?: string; tab?: string },
		unexpected: Array<"workspace" | "tab">,
	) {
		const present = unexpected.filter((key) => params[key] != null);
		if (!present.length) return;
		throw new Error(
			`${action} targets panes, not ${present.join(" or ")}. Use a pane alias or pane id from list, or the root pane returned by tab_create/workspace_create.`,
		);
	}

	function formatStatusList(statuses: AgentStatus[]): string {
		return statuses.join("|");
	}

	function throwIfAborted(signal: AbortSignal | undefined, action: string) {
		if (signal?.aborted) {
			throw new Error(`${action} canceled.`);
		}
	}

	function statusDot(theme: any, status: AgentStatus): string {
		switch (status) {
			case "blocked":
				return theme.fg("warning", "●");
			case "working":
				return theme.fg("accent", "●");
			case "done":
				return theme.fg("success", "●");
			case "idle":
				return theme.fg("muted", "○");
			default:
				return theme.fg("dim", "·");
		}
	}

	pi.registerTool({
		name: "herdr",
		label: "herdr",
		description:
			"Structured access to Herdr's current workspace, tab, pane, and agent CLI. " +
			"Lists and creates contexts, resolves caller-owned pane state, chooses splits from pane geometry, submits atomic input, reads output, waits for output or agent status, focuses targets, and closes panes.",
		promptSnippet: "Inspect and control Herdr workspaces, tabs, panes, and agent terminals",
		promptGuidelines: [
			"Use `herdr` only when the user explicitly mentions Herdr or asks to inspect or control Herdr contexts. Do not invoke it merely because background work or delegation might help.",
			"When the user asks to use Herdr, default to a sibling pane in the current tab and cwd. Create another tab, workspace, or cwd only when the user requests that topology.",
			"Preserve the current UI focus by default. Set focus only when the user explicitly asks to switch context.",
			"Use `herdr` agent_start to start a supported interactive agent in an existing shell pane, then agent_prompt to submit work and wait for a lifecycle signal. Use run only for ordinary shell commands.",
			"For agent-hosted panes, prefer `agent` (or a pane that already hosts an agent) with read/send so keys and output use the agent facade. Raw pane controls remain for ordinary terminals.",
			"Use `herdr` watch for normal command output and `herdr` wait_agent only for recognized coding agents.",
			"Treat both `idle` and `done` as completed agent states when inspecting status. `done` means the completed result is unseen; `idle` means it is seen.",
			"Use `recent-unwrapped` for logs and transcripts, and `detection` only when agent-detection evidence is needed.",
			"Pane actions target friendly aliases or opaque pane ids, never tab ids. Read ids from Herdr responses instead of constructing them.",
			"When pane_split omits direction, the `herdr` tool chooses right or down from the source pane geometry.",
			"Use friendly aliases such as `server`, `reviewer`, or `tests` for panes created by pane_split, tab_create, or workspace_create.",
		],
		parameters: Type.Object({
			action: ActionEnum,
			pane: Type.Optional(Type.String({ description: "Friendly pane alias or explicit pane id. For pane_split, omit to split the agent's own pane." })),
			panes: Type.Optional(Type.Array(Type.String(), { description: "Pane aliases or pane ids for multi-pane waits" })),
			workspace: Type.Optional(Type.String({ description: "Workspace id for workspace or tab actions" })),
			tab: Type.Optional(Type.String({ description: "Tab id for tab actions or focus(tab) only. Pane actions must use pane ids or aliases." })),
			label: Type.Optional(Type.String({ description: "Label for create, pane_split, or pane_rename actions" })),
			newPane: Type.Optional(Type.String({ description: "Alias to remember for the pane created by pane_split" })),
			direction: Type.Optional(DirectionEnum),
			agent: Type.Optional(Type.String({ description: "Unique live agent name or pane id" })),
			name: Type.Optional(Type.String({ description: "Strict unique name for agent_start" })),
			kind: Type.Optional(Type.String({ description: "Supported agent kind for agent_start, such as pi, codex, or claude" })),
			agentArgs: Type.Optional(Type.Array(Type.String(), { description: "Native agent arguments passed after --" })),
			prompt: Type.Optional(Type.String({ description: "Prompt text for agent_prompt" })),
			wait: Type.Optional(Type.Boolean({ description: "Wait for a lifecycle signal after agent_prompt; defaults true" })),
			command: Type.Optional(Type.String({ description: "Ordinary shell command submitted atomically for run" })),
			match: Type.Optional(Type.String({ description: "Text or regex to wait for (for watch action)" })),
			regex: Type.Optional(Type.Boolean({ description: "Treat match as a regex (for watch action)" })),
			status: Type.Optional(StatusEnum),
			statuses: Type.Optional(Type.Array(StatusEnum, { description: "Accepted statuses for agent_prompt or wait_agent" })),
			mode: Type.Optional(WaitModeEnum),
			timeout: Type.Optional(Type.Number({ description: "Timeout in ms for agent_start, agent_prompt, watch, or wait_agent" })),
			lines: Type.Optional(Type.Number({ description: "Scrollback lines to capture or inspect" })),
			source: Type.Optional(SourceEnum),
			raw: Type.Optional(Type.Boolean({ description: "Disable ANSI stripping for read/watch" })),
			text: Type.Optional(Type.String({ description: "Literal text to send without Enter (for send action; pane path). Use run if you want text plus Enter atomically." })),
			keys: Type.Optional(
				Type.String({
					description: "Keys to send, space-separated (for send action). Uses agent send-keys when the target is an agent. Examples: C-c, Enter, q, y",
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory for workspace_create, tab_create, and pane_split where supported" })),
			focus: Type.Optional(Type.Boolean({ description: "Explicitly change focus for create/focus actions. Defaults should preserve current focus." })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const currentPane = await getCurrentPaneInfo(signal);
			const currentPaneId = currentPane.pane_id;
			const currentWorkspaceId = currentPane.workspace_id;

			switch (params.action) {
				case "list": {
					const panes = await getWorkspacePanes(currentWorkspaceId, signal);
					const aliasByPaneId = new Map<string, string>();
					for (const [alias, managed] of managedPanes.entries()) {
						if (managed.workspaceId === currentWorkspaceId) aliasByPaneId.set(managed.paneId, alias);
					}

					const text = panes.length
						? panes.map((pane) => summarizePane(pane, aliasByPaneId.get(pane.pane_id), currentPaneId)).join("\n")
						: "No panes in current workspace.";

					return {
						content: [{ type: "text", text }],
						details: withSnapshot({
							action: "list",
							panes,
							currentPaneId,
							workspaceId: currentWorkspaceId,
							paneAliases: Object.fromEntries(aliasByPaneId),
						}),
					};
				}

				case "current": {
					return {
						content: [{ type: "text", text: summarizePane(currentPane, undefined, currentPaneId) }],
						details: withSnapshot({ action: "current", pane: currentPane }),
					};
				}

				case "workspace_list": {
					const workspaces = await getWorkspaceList(signal);
					const text = workspaces.length
						? workspaces.map(summarizeWorkspace).join("\n")
						: "No workspaces.";
					return {
						content: [{ type: "text", text }],
						details: withSnapshot({ action: "workspace_list", workspaces }),
					};
				}

				case "workspace_create": {
					const args = ["workspace", "create"];
					if (params.cwd) args.push("--cwd", params.cwd);
					if (params.label) args.push("--label", params.label);
					if (params.focus !== true) args.push("--no-focus");
					const response = await execHerdrJson<{
						result: { workspace: WorkspaceInfo; root_pane?: PaneInfo };
					}>(args, signal);
					const workspace = response.result.workspace;
					const rootPane =
						response.result.root_pane ?? (await getWorkspacePanes(workspace.workspace_id, signal))[0] ?? null;
					if (params.pane && rootPane) {
						recordAlias(params.pane, rootPane.pane_id, workspace.workspace_id);
					}
					const aliasText = params.pane && rootPane ? `, aliased as '${params.pane}'` : "";
					const rootPaneText = rootPane ? `, root pane ${rootPane.pane_id}${aliasText}` : "";
					return {
						content: [{
							type: "text",
							text: `Created workspace '${workspace.label}' (${workspace.workspace_id})${rootPaneText}`,
						}],
						details: withSnapshot({
							action: "workspace_create",
							workspace,
							rootPaneId: rootPane?.pane_id,
							pane: params.pane,
						}),
					};
				}

				case "workspace_focus": {
					const workspaceId = params.workspace;
					if (!workspaceId) throw new Error("'workspace' is required for workspace_focus");
					const response = await execHerdrJson<{ result: { workspace: WorkspaceInfo } }>([
						"workspace",
						"focus",
						workspaceId,
					], signal);
					return {
						content: [{ type: "text", text: `Focused workspace '${response.result.workspace.label}'` }],
						details: withSnapshot({ action: "workspace_focus", workspace: response.result.workspace }),
					};
				}

				case "tab_list": {
					const workspaceId = params.workspace ?? currentWorkspaceId;
					const tabs = await getTabList(workspaceId, signal);
					const text = tabs.length ? tabs.map(summarizeTab).join("\n") : "No tabs.";
					return {
						content: [{ type: "text", text }],
						details: withSnapshot({ action: "tab_list", tabs, workspaceId }),
					};
				}

				case "tab_create": {
					const workspaceId = params.workspace ?? currentWorkspaceId;
					const args = ["tab", "create", "--workspace", workspaceId];
					if (params.cwd) args.push("--cwd", params.cwd);
					if (params.label) args.push("--label", params.label);
					if (params.focus !== true) args.push("--no-focus");
					const response = await execHerdrJson<{ result: { tab: TabInfo; root_pane?: PaneInfo } }>(args, signal);
					const tab = response.result.tab;
					const rootPane =
						response.result.root_pane ??
						(await getWorkspacePanes(tab.workspace_id, signal)).find((pane) => pane.tab_id === tab.tab_id) ??
						null;
					if (params.pane && rootPane) {
						recordAlias(params.pane, rootPane.pane_id, tab.workspace_id);
					}
					const aliasText = params.pane && rootPane ? `, aliased as '${params.pane}'` : "";
					const rootPaneText = rootPane ? `, root pane ${rootPane.pane_id}${aliasText}` : "";
					return {
						content: [{ type: "text", text: `Created tab '${tab.label}' (${tab.tab_id})${rootPaneText}` }],
						details: withSnapshot({
							action: "tab_create",
							tab,
							rootPaneId: rootPane?.pane_id,
							pane: params.pane,
						}),
					};
				}

				case "tab_focus": {
					const tabId = params.tab;
					if (!tabId) throw new Error("'tab' is required for tab_focus");
					const response = await execHerdrJson<{ result: { tab: TabInfo } }>(["tab", "focus", tabId], signal);
					return {
						content: [{ type: "text", text: `Focused tab '${response.result.tab.label}'` }],
						details: withSnapshot({ action: "tab_focus", tab: response.result.tab }),
					};
				}

				case "focus": {
					if (params.tab) {
						const response = await execHerdrJson<{ result: { tab: TabInfo } }>(["tab", "focus", params.tab], signal);
						return {
							content: [{ type: "text", text: `Focused tab '${response.result.tab.label}'` }],
							details: withSnapshot({ action: "focus", target: "tab", tab: response.result.tab }),
						};
					}
					if (params.workspace) {
						const response = await execHerdrJson<{ result: { workspace: WorkspaceInfo } }>([
							"workspace",
							"focus",
							params.workspace,
						], signal);
						return {
							content: [{ type: "text", text: `Focused workspace '${response.result.workspace.label}'` }],
							details: withSnapshot({ action: "focus", target: "workspace", workspace: response.result.workspace }),
						};
					}
					if (params.pane) {
						const resolved = await requirePaneRef(params.pane, signal);
						const response = await execHerdrJson<{ result: { agent: AgentInfo } }>(
							["agent", "focus", resolved.pane.pane_id],
							signal,
						);
						return {
							content: [{ type: "text", text: `Focused pane '${resolved.alias || resolved.pane.pane_id}'` }],
							details: withSnapshot({ action: "focus", target: "pane", agent: response.result.agent }),
						};
					}
					throw new Error("'workspace', 'tab', or 'pane' is required for focus");
				}

				case "pane_rename": {
					rejectUnexpectedParams("pane_rename", params, ["workspace", "tab"]);
					const paneRef = params.pane;
					if (!paneRef) throw new Error("'pane' is required for pane_rename");
					if (!params.label) throw new Error("'label' is required for pane_rename");
					const resolved = await requirePaneRef(paneRef, signal);
					const response = await execHerdrJson<{ result: { pane: PaneInfo } }>(
						["pane", "rename", resolved.pane.pane_id, params.label],
						signal,
					);
					return {
						content: [{ type: "text", text: `Renamed pane '${resolved.alias || paneRef}' to '${params.label}'` }],
						details: withSnapshot({ action: "pane_rename", pane: response.result.pane, alias: resolved.alias }),
					};
				}

				case "pane_split": {
					rejectUnexpectedParams("pane_split", params, ["workspace", "tab"]);
					const paneRef = params.pane ?? currentPaneId;
					const sourcePane = await requirePaneRef(paneRef, signal);
					const direction = params.direction ?? chooseSplitDirection(
						await getPaneLayout(sourcePane.pane.pane_id, signal),
						sourcePane.pane.pane_id,
					);
					const args = ["pane", "split", sourcePane.pane.pane_id, "--direction", direction];
					if (params.cwd) args.push("--cwd", params.cwd);
					if (params.focus !== true) args.push("--no-focus");

					const response = await execHerdrJson<{ result: { pane: PaneInfo } }>(args, signal);
					const splitPane = response.result.pane;
					const paneLabel = params.label ?? params.newPane;
					if (paneLabel) {
						await execHerdrJson(["pane", "rename", splitPane.pane_id, paneLabel], signal);
					}
					if (params.newPane) {
						recordAlias(params.newPane, splitPane.pane_id, splitPane.workspace_id);
					}

					const sourceLabel = sourcePane.alias || paneRef;
					const aliasText = params.newPane ? `, aliased as '${params.newPane}'` : "";
					return {
						content: [{
							type: "text",
							text: `Created pane '${splitPane.pane_id}' by splitting '${sourceLabel}' ${direction}${aliasText}`,
						}],
						details: withSnapshot({
							action: "pane_split",
							pane: sourceLabel,
							paneId: sourcePane.pane.pane_id,
							newPane: params.newPane || splitPane.pane_id,
							newPaneId: splitPane.pane_id,
							direction,
							workspaceId: splitPane.workspace_id,
						}),
					};
				}

				case "agent_list": {
					const agents = await getAgentList(signal);
					return {
						content: [{ type: "text", text: agents.length ? agents.map(summarizeAgent).join("\n") : "No agents." }],
						details: withSnapshot({ action: "agent_list", agents }),
					};
				}

				case "agent_get": {
					let target = params.agent ?? params.pane;
					if (!target) throw new Error("'agent' or 'pane' is required for agent_get");
					if (managedPanes.has(target)) {
						target = (await requirePaneRef(target, signal)).pane.pane_id;
					}
					const response = await execHerdrJson<{ result: { agent: AgentInfo } }>(["agent", "get", target], signal);
					return {
						content: [{ type: "text", text: summarizeAgent(response.result.agent) }],
						details: withSnapshot({ action: "agent_get", agent: response.result.agent }),
					};
				}

				case "agent_start": {
					rejectUnexpectedParams("agent_start", params, ["workspace", "tab"]);
					const paneRef = params.pane;
					if (!paneRef) throw new Error("'pane' is required for agent_start");
					if (!params.name) throw new Error("'name' is required for agent_start");
					if (!params.kind) throw new Error("'kind' is required for agent_start");
					const resolved = await requirePaneRef(paneRef, signal);
					const args = [
						"agent",
						"start",
						params.name,
						"--kind",
						params.kind,
						"--pane",
						resolved.pane.pane_id,
					];
					if (params.timeout != null) args.push("--timeout", String(params.timeout));
					if (params.agentArgs?.length) args.push("--", ...params.agentArgs);
					await execHerdr(args, signal);
					const agent = await getAgentInfo(params.name, signal);
					return {
						content: [{ type: "text", text: `Started ${params.kind} agent '${params.name}' in ${resolved.alias || resolved.pane.pane_id}` }],
						details: withSnapshot({ action: "agent_start", agent }),
					};
				}

				case "agent_prompt": {
					rejectUnexpectedParams("agent_prompt", params, ["workspace", "tab"]);
					let target = params.agent ?? params.pane;
					if (!target) throw new Error("'agent' or 'pane' is required for agent_prompt");
					if (!params.prompt) throw new Error("'prompt' is required for agent_prompt");
					if (managedPanes.has(target)) {
						target = (await requirePaneRef(target, signal)).pane.pane_id;
					}
					const startedAt = Date.now();
					const publishPromptUpdate = () => onUpdate?.({
						content: [{ type: "text", text: `Waiting for agent '${target}'...` }],
						details: withSnapshot({
							action: "agent_prompt",
							agentTarget: target,
							elapsed: Math.floor((Date.now() - startedAt) / 1000),
						}),
					});
					publishPromptUpdate();
					const updateTimer = onUpdate ? setInterval(publishPromptUpdate, 1000) : null;
					try {
						const args = ["agent", "prompt", target, params.prompt];
						if (params.wait !== false) args.push("--wait");
						for (const status of params.statuses ?? []) args.push("--until", status);
						if (params.timeout != null) args.push("--timeout", String(params.timeout));
						await execHerdr(args, signal);
						const agent = await getAgentInfo(target, signal);
						return {
							content: [{ type: "text", text: `Agent '${agentDisplayName(agent)}' is ${agent.agent_status}` }],
							details: withSnapshot({
								action: "agent_prompt",
								agent,
								elapsed: Math.floor((Date.now() - startedAt) / 1000),
							}),
						};
					} finally {
						if (updateTimer) clearInterval(updateTimer);
					}
				}

				case "run": {
					rejectUnexpectedParams("run", params, ["workspace", "tab"]);
					const paneRef = params.pane;
					const command = params.command;
					if (!paneRef) throw new Error("'pane' is required for run");
					if (!command) throw new Error("'command' is required for run");

					const targetPane = await requirePaneRef(paneRef, signal);
					await execHerdr(["pane", "run", targetPane.pane.pane_id, command], signal);

					await sleep(800, signal);
					const initialOutput = await readPane(
						targetPane.pane.pane_id,
						{
							source: params.source ?? "recent",
							lines: params.lines ?? 20,
							raw: params.raw,
						},
						signal,
					);

					const paneLabel = targetPane.alias || paneRef;
					return {
						content: [
							{
								type: "text",
								text: `Started '${command}' in pane '${paneLabel}' (${targetPane.pane.pane_id})\n\n${formatReadOutput(initialOutput)}`,
							},
						],
						details: withSnapshot({
							action: "run",
							pane: paneLabel,
							paneId: targetPane.pane.pane_id,
							command,
							workspaceId: targetPane.pane.workspace_id,
						}),
					};
				}

				case "read": {
					rejectUnexpectedParams("read", params, ["workspace", "tab"]);
					const target = await resolveControlTarget(
						{ agent: params.agent, pane: params.pane },
						signal,
					);
					const readOptions = {
						source: params.source ?? "recent",
						lines: params.lines ?? 20,
						raw: params.raw,
					} as const;
					const output =
						target.kind === "agent"
							? await readAgent(target.target, readOptions, signal)
							: await readPane(target.pane.pane_id, readOptions, signal);
					const label =
						target.kind === "agent"
							? target.alias || target.label
							: target.alias || params.pane || target.pane.pane_id;

					return {
						content: [{ type: "text", text: formatReadOutput(output) }],
						details: withSnapshot({
							action: "read",
							targetKind: target.kind,
							pane: label,
							paneId: target.pane?.pane_id,
							agent: target.kind === "agent" ? target.target : undefined,
							source: params.source ?? "recent",
						}),
					};
				}

				case "watch": {
					rejectUnexpectedParams("watch", params, ["workspace", "tab"]);
					const paneRef = params.pane;
					const match = params.match;
					if (!paneRef) throw new Error("'pane' is required for watch");
					if (!match) throw new Error("'match' is required for watch");
					if (params.source === "detection") throw new Error("watch does not support the detection source; use read");

					const resolved = await requirePaneRef(paneRef, signal);
					const paneLabel = resolved.alias || paneRef;
					const startTime = Date.now();

					const publishWatchUpdate = () => {
						onUpdate?.({
							content: [{ type: "text", text: `Watching ${paneLabel}...` }],
							details: withSnapshot({
								action: "watch",
								pane: paneLabel,
								paneId: resolved.pane.pane_id,
								match,
								elapsed: Math.floor((Date.now() - startTime) / 1000),
							}),
						});
					};

					publishWatchUpdate();
					const updateTimer = onUpdate ? setInterval(publishWatchUpdate, 1000) : null;

					try {
						const args = [
							"pane",
							"wait-output",
							resolved.pane.pane_id,
							params.regex ? "--regex" : "--match",
							match,
						];
						if (params.source) args.push("--source", params.source);
						if (params.lines != null) args.push("--lines", String(params.lines));
						if (params.timeout != null) args.push("--timeout", String(params.timeout));
						if (params.raw) args.push("--raw");

						const response = await execHerdrJson<{
							result: {
								type: string;
								pane_id: string;
								revision: number;
								matched_line: string;
								read: PaneReadResult;
							};
						}>(args, signal);
						const matched = response.result;
						const text = matched.read?.text ? formatReadOutput(matched.read.text) : matched.matched_line;

						return {
							content: [{ type: "text", text: `Matched: ${matched.matched_line}\n\n${text}` }],
							details: withSnapshot({
								action: "watch",
								pane: paneLabel,
								paneId: resolved.pane.pane_id,
								matchedLine: matched.matched_line,
								elapsed: Math.floor((Date.now() - startTime) / 1000),
							}),
						};
					} finally {
						if (updateTimer) clearInterval(updateTimer);
					}
				}

				case "wait_agent": {
					rejectUnexpectedParams("wait_agent", params, ["workspace", "tab"]);
					throwIfAborted(signal, "wait_agent");
					const paneRefs = params.panes?.length ? params.panes : params.pane ? [params.pane] : [];
					const statuses = params.statuses?.length ? params.statuses : params.status ? [params.status] : [];
					const mode = params.mode ?? "all";
					if (!paneRefs.length) throw new Error("'pane' or 'panes' is required for wait_agent");
					if (!statuses.length) throw new Error("'status' or 'statuses' is required for wait_agent");

					const resolvedPanes: Array<{ pane: PaneInfo; aliasOrRef: string }> = [];
					for (const paneRef of paneRefs) {
						const resolved = await requirePaneRef(paneRef, signal);
						resolvedPanes.push({ pane: resolved.pane, aliasOrRef: resolved.alias || paneRef });
					}

					const startedAt = Date.now();
					const publishWaitUpdate = () => onUpdate?.({
						content: [{ type: "text", text: `Waiting for ${resolvedPanes.map((item) => item.aliasOrRef).join(", ")}...` }],
						details: withSnapshot({
							action: "wait_agent",
							panes: resolvedPanes.map((item) => item.aliasOrRef),
							statuses,
							mode,
							elapsed: Math.floor((Date.now() - startedAt) / 1000),
						}),
					});
					publishWaitUpdate();
					const updateTimer = onUpdate ? setInterval(publishWaitUpdate, 1000) : null;
					const controllers = resolvedPanes.map(() => new AbortController());
					const abortWaits = () => controllers.forEach((controller) => controller.abort(signal?.reason));
					signal?.addEventListener("abort", abortWaits, { once: true });
					try {
						const waits = resolvedPanes.map((resolved, index) => {
							const args = ["agent", "wait", resolved.pane.pane_id];
							for (const status of statuses) args.push("--until", status);
							if (params.timeout != null) args.push("--timeout", String(params.timeout));
							return execHerdr(args, controllers[index]!.signal);
						});
						if (mode === "all") await Promise.all(waits);
						else {
							await Promise.any(waits);
							controllers.forEach((controller) => controller.abort());
						}
					} finally {
						if (updateTimer) clearInterval(updateTimer);
						signal?.removeEventListener("abort", abortWaits);
						controllers.forEach((controller) => controller.abort());
					}

					const agents = await Promise.all(
						resolvedPanes.map((resolved) => getAgentInfo(resolved.pane.pane_id, signal)),
					);
					const snapshot = agents.map((agent, index) => ({
						pane: resolvedPanes[index]!.aliasOrRef,
						paneId: agent.pane_id,
						status: agent.agent_status,
						agent: agentDisplayName(agent),
					}));
					const summary = snapshot.map((item) => `${item.pane}=${item.status}`).join(", ");
					return {
						content: [{ type: "text", text: `wait_agent satisfied (${mode}: ${formatStatusList(statuses)})\n\n${summary}` }],
						details: withSnapshot({
							action: "wait_agent",
							pane: paneRefs.length === 1 ? resolvedPanes[0]?.aliasOrRef : undefined,
							panes: snapshot.map((item) => item.pane),
							paneIds: snapshot.map((item) => item.paneId),
							status: paneRefs.length === 1 && statuses.length === 1 ? snapshot[0]?.status : undefined,
							statuses,
							mode,
							agents: snapshot.map((item) => item.agent),
							snapshot,
							elapsed: Math.floor((Date.now() - startedAt) / 1000),
						}),
					};
				}

				case "send": {
					rejectUnexpectedParams("send", params, ["workspace", "tab"]);
					if (!params.text && !params.keys) throw new Error("'text' or 'keys' is required for send");
					const target = await resolveControlTarget(
						{ agent: params.agent, pane: params.pane },
						signal,
					);
					const label =
						target.kind === "agent"
							? target.alias || target.label
							: target.alias || params.pane || target.pane.pane_id;

					if (params.text) {
						// 0.7.5 has no agent send-text; literal text always uses the pane primitive.
						const paneId = target.pane?.pane_id;
						if (!paneId) throw new Error("Unable to resolve pane for send text");
						await execHerdr(["pane", "send-text", paneId, params.text], signal);
					}
					if (params.keys) {
						const keys = params.keys.split(/\s+/).filter(Boolean);
						if (target.kind === "agent") {
							await execHerdr(["agent", "send-keys", target.target, ...keys], signal);
						} else {
							await execHerdr(["pane", "send-keys", target.pane.pane_id, ...keys], signal);
						}
					}

					const desc = [params.text && `"${params.text}"`, params.keys].filter(Boolean).join(" + ");
					return {
						content: [{
							type: "text",
							text: `Sent ${desc} to ${target.kind} '${label}'`,
						}],
						details: withSnapshot({
							action: "send",
							targetKind: target.kind,
							pane: label,
							paneId: target.pane?.pane_id,
							agent: target.kind === "agent" ? target.target : undefined,
							text: params.text,
							keys: params.keys,
						}),
					};
				}

				case "stop": {
					rejectUnexpectedParams("stop", params, ["workspace", "tab"]);
					const paneRef = params.pane;
					if (!paneRef) throw new Error("'pane' is required for stop");

					const resolved = await requirePaneRef(paneRef, signal);
					if (resolved.pane.pane_id === currentPaneId) {
						throw new Error("Refusing to close the pane pi is running in.");
					}

					await execHerdr(["pane", "close", resolved.pane.pane_id], signal);
					if (resolved.alias) forgetAlias(resolved.alias);

					return {
						content: [{ type: "text", text: `Closed pane '${resolved.alias || paneRef}'` }],
						details: withSnapshot({
							action: "stop",
							pane: resolved.alias || paneRef,
							paneId: resolved.pane.pane_id,
						}),
					};
				}

				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
		},

		renderCall(args, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

			let text = theme.fg("toolTitle", theme.bold("herdr "));
			text += theme.fg("accent", args.action || "?");
			if (args.workspace) text += theme.fg("muted", ` ${args.workspace}`);
			if (args.tab) text += theme.fg("muted", ` ${args.tab}`);
			if (args.pane) text += theme.fg("muted", ` ${args.pane}`);
			if (args.agent) text += theme.fg("muted", ` ${args.agent}`);
			if (args.name) text += theme.fg("muted", ` ${args.name}`);
			if (args.kind) text += theme.fg("dim", ` (${args.kind})`);
			if (Array.isArray(args.panes) && args.panes.length) text += theme.fg("muted", ` ${args.panes.join(",")}`);
			if (args.direction) text += theme.fg("dim", ` › ${args.direction}`);
			if (args.command) text += theme.fg("dim", ` › ${args.command}`);
			if (args.prompt) text += theme.fg("dim", ` › ${args.prompt}`);
			if (args.newPane) text += theme.fg("muted", ` ${args.newPane}`);
			if (args.label) text += theme.fg("muted", ` “${args.label}”`);
			if (args.match) text += theme.fg("dim", ` › ${args.match}`);
			if (args.status) text += theme.fg("dim", ` › ${args.status}`);
			if (Array.isArray(args.statuses) && args.statuses.length) text += theme.fg("dim", ` › ${args.statuses.join("|")}`);
			if (args.mode) text += theme.fg("dim", ` ${args.mode}`);
			if (args.text) text += theme.fg("dim", ` › \"${args.text}\"`);
			if (args.keys) text += theme.fg("dim", ` › ${args.keys}`);

			component.setText(text);
			return component;
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const details = result.details as Record<string, any> | undefined;
			const state = context.state as { watchElapsed?: number };
			if (context.args?.action === "watch") {
				if (isPartial) {
					state.watchElapsed = typeof details?.elapsed === "number" ? details.elapsed : 0;
					const pane = details?.pane || context.args?.pane || "?";
					return new Text(
						theme.fg("warning", `◌ watching ${pane}`) + theme.fg("dim", ` (${state.watchElapsed}s)`),
						0,
						0,
					);
				}
				delete state.watchElapsed;
			}
			if (!details) {
				const content = result.content?.[0];
				return new Text(content?.type === "text" ? content.text : "", 0, 0);
			}

			switch (details.action) {
				case "current": {
					const pane = details.pane as PaneInfo;
					return new Text(theme.fg("accent", `◎ ${pane.label || pane.pane_id}`), 0, 0);
				}
				case "pane_rename": {
					const pane = details.pane as PaneInfo;
					return new Text(theme.fg("accent", `✎ ${details.alias || pane.pane_id}`) + theme.fg("dim", ` › ${pane.label || "renamed"}`), 0, 0);
				}
				case "pane_split": {
					let text = theme.fg("accent", `▥ ${details.newPane || details.newPaneId}`);
					text += theme.fg("dim", ` ‹ ${details.direction} from ${details.pane}`);
					return new Text(text, 0, 0);
				}
				case "agent_start": {
					const agent = details.agent as AgentInfo;
					return new Text(`${statusDot(theme, agent.agent_status)} ${theme.fg("accent", agentDisplayName(agent))} ${theme.fg("dim", `started · ${agent.agent_status}`)}`, 0, 0);
				}
				case "agent_prompt": {
					if (isPartial) {
						return new Text(theme.fg("warning", `◌ waiting ${details.agentTarget || context.args?.agent || context.args?.pane || "agent"}`) + theme.fg("dim", ` (${details.elapsed ?? 0}s)`), 0, 0);
					}
					const agent = details.agent as AgentInfo;
					return new Text(`${statusDot(theme, agent.agent_status)} ${theme.fg("accent", agentDisplayName(agent))} ${theme.fg("dim", agent.agent_status)}`, 0, 0);
				}
				case "run": {
					let text = theme.fg("success", `▶ ${details.pane}`);
					text += theme.fg("dim", ` › ${details.command}`);
					return new Text(text, 0, 0);
				}
				case "read": {
					let text = theme.fg("accent", `📄 ${details.pane}`);
					if (expanded) {
						const content = result.content?.[0];
						if (content?.type === "text") {
							const outputLines = content.text.split("\n").slice(0, 40);
							text += "\n" + outputLines.map((line: string) => theme.fg("dim", line)).join("\n");
						}
					}
					return new Text(text, 0, 0);
				}
				case "watch": {
					let text = theme.fg("success", `✓ ${details.pane}`);
					text += theme.fg("dim", ` › ${details.matchedLine}`);
					if (typeof details.elapsed === "number") text += theme.fg("muted", ` (took ${details.elapsed}s)`);
					return new Text(text, 0, 0);
				}
				case "wait_agent": {
					const panes = Array.isArray(details.panes) && details.panes.length ? details.panes : details.pane ? [details.pane] : [];
					const statuses = Array.isArray(details.statuses) && details.statuses.length
						? details.statuses
						: details.status
							? [details.status]
							: [];
						let text = theme.fg("success", `◎ ${panes.join(", ")}`);
						if (statuses.length) text += theme.fg("dim", ` › ${statuses.join("|")}`);
						if (details.mode) text += theme.fg("muted", ` (${details.mode})`);
						return new Text(text, 0, 0);
				}
				case "send": {
					const desc = [details.text && `"${details.text}"`, details.keys].filter(Boolean).join(" + ");
					return new Text(theme.fg("accent", `⏎ ${details.pane} › ${desc}`), 0, 0);
				}
				case "stop": {
					return new Text(theme.fg("warning", `■ ${details.pane}`), 0, 0);
				}
				case "workspace_create":
				case "workspace_focus": {
					return new Text(theme.fg("accent", `▣ ${details.workspace?.label || details.workspace?.workspace_id}`), 0, 0);
				}
				case "tab_create":
				case "tab_focus": {
					return new Text(theme.fg("accent", `▤ ${details.tab?.label || details.tab?.tab_id}`), 0, 0);
				}
				case "focus": {
					return new Text(theme.fg("accent", `◎ ${details.target}`), 0, 0);
				}
				case "agent_list": {
					const agents = details.agents as AgentInfo[];
					if (!agents?.length) return new Text(theme.fg("dim", "no agents"), 0, 0);
					return new Text(
						agents.map((agent) => `${statusDot(theme, agent.agent_status)} ${theme.fg(agent.focused ? "accent" : "muted", agentDisplayName(agent))} ${theme.fg("dim", agent.agent_status)}`).join("\n"),
						0,
						0,
					);
				}
				case "agent_get": {
					const agent = details.agent as AgentInfo;
					return new Text(`${statusDot(theme, agent.agent_status)} ${theme.fg("accent", agentDisplayName(agent))} ${theme.fg("dim", agent.agent_status)}`, 0, 0);
				}
				case "workspace_list": {
					const workspaces = details.workspaces as WorkspaceInfo[];
					if (!workspaces?.length) return new Text(theme.fg("dim", "no workspaces"), 0, 0);
					const lines = workspaces.map((workspace) => {
						const dot = statusDot(theme, workspace.agent_status);
						const label = theme.fg(workspace.focused ? "accent" : "muted", workspace.label || workspace.workspace_id);
						const extra = [workspace.workspace_id, workspace.agent_status !== "unknown" ? workspace.agent_status : null]
							.filter(Boolean)
							.join(" ");
						return `${dot} ${label}${extra ? ` ${theme.fg("dim", extra)}` : ""}`;
					});
					return new Text(lines.join("\n"), 0, 0);
				}
				case "tab_list": {
					const tabs = details.tabs as TabInfo[];
					if (!tabs?.length) return new Text(theme.fg("dim", "no tabs"), 0, 0);
					const lines = tabs.map((tab) => {
						const dot = statusDot(theme, tab.agent_status);
						const label = theme.fg(tab.focused ? "accent" : "muted", tab.label || tab.tab_id);
						const extra = [tab.tab_id, tab.agent_status !== "unknown" ? tab.agent_status : null].filter(Boolean).join(" ");
						return `${dot} ${label}${extra ? ` ${theme.fg("dim", extra)}` : ""}`;
					});
					return new Text(lines.join("\n"), 0, 0);
				}
				case "list": {
					const panes = details.panes as PaneInfo[];
					if (!panes?.length) return new Text(theme.fg("dim", "no panes"), 0, 0);
					const paneAliases = (details.paneAliases || {}) as Record<string, string>;
					const lines = panes.map((pane) => {
						const dot = statusDot(theme, pane.agent_status);
						const label = paneAliases[pane.pane_id]
							? theme.fg("accent", paneAliases[pane.pane_id])
							: theme.fg("muted", pane.pane_id);
						const extra = [pane.agent, pane.agent_status !== "unknown" ? pane.agent_status : null].filter(Boolean).join(" ");
						return `${dot} ${label}${extra ? ` ${theme.fg("dim", extra)}` : ""}`;
					});
					return new Text(lines.join("\n"), 0, 0);
				}
				default: {
					const content = result.content?.[0];
					return new Text(content?.type === "text" ? content.text : "", 0, 0);
				}
			}
		},
	});
}
