import type { PaseoApi } from "@getpaseo/client";
import { executorPrompt } from "./prompts";
import { providerRef, type Settings, type TicketRow } from "./store";
import { executorModeId, paseoToolPolicy } from "./paseo-tools";

export interface ExecutionHandle {
  agentId: string;
  workspaceId: string;
}

export async function startExecution(
  client: PaseoApi,
  ticket: TicketRow,
  settings: Settings,
  instruction: string,
  projectId: string,
): Promise<ExecutionHandle> {
  if (!settings.repoPath.trim()) {
    throw new Error("repoPath is not configured");
  }
  const workspace = await client.workspaces.create({
    title: `sa-${ticket.id}`,
    source: {
      kind: "worktree",
      cwd: settings.repoPath,
      action: "branch-off",
      refName: settings.baseBranch || "main",
      branchName: `agent/${ticket.id}`,
      ...(projectId ? { projectId } : {}),
    },
    background: true,
  });
  const agent = await workspace.agents.create({
    config: {
      provider: providerRef(settings.executorProvider, settings.executorModel),
      thinkingOptionId: settings.executorThinking || undefined,
      modeId: executorModeId(settings.executorProvider),
      toolPolicy: { preapproved: paseoToolPolicy() },
    },
    prompt: executorPrompt(ticket, instruction),
    title: `sa-exec-${ticket.id}`,
    labels: { "superagent.ticket": ticket.id, "superagent.role": "executor" },
  });
  return { agentId: agent.id, workspaceId: workspace.id };
}
