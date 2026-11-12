import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const AUTOWONDER_WORKSPACE_ID = Number(
  process.env.AUTOWONDER_WORKSPACE_ID ?? "10002",
);

export const AUTOWONDER_READ_TOOLS = [
  "autowonder_get_workitem",
  "autowonder_list_workitems",
  "autowonder_list_workitem_comments",
  "autowonder_get_agent",
  "autowonder_list_agents",
  "autowonder_list_status_templates",
  "autowonder_get_status_template",
  "autowonder_list_projects",
] as const;

export const AUTOWONDER_WRITE_TOOLS = [
  "autowonder_add_workitem_comment",
  "autowonder_transition_workitem",
  "autowonder_update_workitem",
  "autowonder_resume_workitem",
  "autowonder_pause_workitem",
] as const;

export const AUTOWONDER_COORDINATOR_TOOLS = [
  ...AUTOWONDER_READ_TOOLS,
  ...AUTOWONDER_WRITE_TOOLS,
] as const;

export function autowonderMcpUrl(): string {
  const env = process.env.AUTOWONDER_MCP_URL?.trim();
  if (env) return env;
  try {
    const text = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
    const block = /\[mcp_servers\.autowonder\]([\s\S]*?)(?:\n\[|$)/.exec(text);
    if (!block) return "";
    const match = /url\s*=\s*"([^"]+)"/.exec(block[1]);
    return match?.[1] ?? "";
  } catch {
    return "";
  }
}

export function isAutowonderSource(sourceId: string): boolean {
  return sourceId.startsWith("autowonder");
}

export function autowonderToolPolicy(
  tools: readonly string[],
): Array<{ kind: "mcp"; server: string; tool: string }> {
  return tools.map((tool) => ({ kind: "mcp" as const, server: "autowonder", tool }));
}

interface AutowonderRpcResponse {
  error?: { message?: string };
  result?: { content?: Array<{ type?: string; text?: string }> };
}

export async function autowonderRpc<T>(
  url: string,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal: controller.signal,
    });
    const payload = (await response.json()) as AutowonderRpcResponse;
    if (payload.error) throw new Error(payload.error.message || "autowonder MCP error");
    const text = payload.result?.content?.[0]?.text;
    if (!text) throw new Error("autowonder MCP returned no text");
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}
