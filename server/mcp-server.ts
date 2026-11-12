import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Settings } from "./store";
import { SOURCE_CHECKLIST } from "./prompts";

export interface ToolHost {
  statusSnapshot(): unknown;
  sourcesList(): unknown;
  sourceSave(input: { id: string; name?: string; intervalSec: number; script: string }): unknown;
  sourceTest(id: string): Promise<unknown>;
  sourceApprove(id: string): unknown;
  sourceToggle(id: string, enabled: boolean): unknown;
  ticketsList(state?: string): unknown;
  ticketGet(id: string): unknown;
  autowonderHistory(workitemId: number, workspaceId?: number, limit?: number): Promise<unknown>;
  ticketDispatch(id: string, plan: string, instruction: string): unknown;
  ticketWaitHuman(id: string, question: string): unknown;
  ticketReject(id: string, reason: string): unknown;
  settingsGet(): unknown;
  settingsSet(patch: Partial<Settings>): unknown;
  mainAgentRebuild(): Promise<unknown>;
}

function result(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function buildServer(host: ToolHost): McpServer {
  const server = new McpServer({ name: "superagent", version: "0.1.0" });

  server.tool("superagent_status", "查看 Superagent 当前状态:暂停开关、消息源、工单统计", {}, async () =>
    result(host.statusSnapshot()),
  );
  server.tool("superagent_sources_list", "列出所有消息源及其启用/批准状态", {}, async () =>
    result(host.sourcesList()),
  );
  server.tool(
    "superagent_source_checklist",
    "创建消息源前必须发给用户逐项确认的清单(含会话关联、执行归属、复用策略、安全与验证)",
    {},
    async () => result(SOURCE_CHECKLIST),
  );
  server.tool(
    "superagent_source_save",
    "保存一个消息源脚本(不启用)。脚本必须能输出 NDJSON:每行 {\"id\",\"content\",\"meta\"};meta.conversationKey 是稳定的会话归并键(如工单 id / issue id / 群聊 id),meta.conversationTitle 可选,meta.ownerAgentId 可选",
    {
      id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).describe("消息源 id,字母数字_-"),
      name: z.string().optional().describe("显示名称"),
      intervalSec: z.number().int().min(10).describe("轮询间隔秒,最小 10"),
      script: z.string().describe("脚本全文,第一行应是 shebang"),
    },
    async (input) => result(host.sourceSave(input)),
  );
  server.tool(
    "superagent_source_test",
    "立即运行一次消息源脚本并返回解析结果,用于确认输出格式",
    { id: z.string() },
    async ({ id }) => result(await host.sourceTest(id)),
  );
  server.tool(
    "superagent_source_approve",
    "批准当前脚本哈希并启用消息源。只能在用户明确确认后调用",
    { id: z.string() },
    async ({ id }) => result(host.sourceApprove(id)),
  );
  server.tool(
    "superagent_source_toggle",
    "启用或停用一个消息源",
    { id: z.string(), enabled: z.boolean() },
    async ({ id, enabled }) => result(host.sourceToggle(id, enabled)),
  );
  server.tool(
    "superagent_tickets_list",
    "列出工单,可按状态过滤(pending/waiting_human/executing/done/failed/ignored)",
    { state: z.string().optional() },
    async ({ state }) => result(host.ticketsList(state)),
  );
  server.tool(
    "superagent_ticket_get",
    "读取一张工单的完整信息(标题、问题、计划、消息源、事件原文、agent)",
    { id: z.string() },
    async ({ id }) => result(host.ticketGet(id)),
  );
  server.tool(
    "superagent_autowonder_history",
    "读取 Autowonder 工单状态、状态模板、最近评论、异常评论和 AGENT authorRef→名称映射;已压缩,避免全量历史",
    {
      workitemId: z.number().int(),
      workspaceId: z.number().int().optional(),
      limit: z.number().int().min(5).max(50).optional(),
    },
    async ({ workitemId, workspaceId, limit }) =>
      result(await host.autowonderHistory(workitemId, workspaceId, limit)),
  );
  server.tool(
    "superagent_ticket_dispatch",
    "派发子 agent 执行这张工单(创建 worktree + 后台执行 agent)",
    { id: z.string(), plan: z.string().describe("具体执行步骤"), instruction: z.string().optional() },
    async ({ id, plan, instruction }) => result(host.ticketDispatch(id, plan, instruction ?? "")),
  );
  server.tool(
    "superagent_ticket_wait_human",
    "把工单转为待人工决策,并附上一个具体问题(会推送到面板/企微)",
    { id: z.string(), question: z.string() },
    async ({ id, question }) => result(host.ticketWaitHuman(id, question)),
  );
  server.tool(
    "superagent_ticket_reject",
    "忽略这张工单(无关/重复)",
    { id: z.string(), reason: z.string().optional() },
    async ({ id, reason }) => result(host.ticketReject(id, reason ?? "")),
  );
  server.tool("superagent_settings_get", "读取当前设置", {}, async () => result(host.settingsGet()));
  server.tool(
    "superagent_settings_set",
    "修改设置(仓库路径、基线分支、模型、企微凭证等)",
    {
      repoPath: z.string().optional(),
      baseBranch: z.string().optional(),
      mainProvider: z.string().optional(),
      mainModel: z.string().optional(),
      mainThinking: z.string().optional(),
      executorProvider: z.string().optional(),
      executorModel: z.string().optional(),
      executorThinking: z.string().optional(),
      notifyOnly: z.boolean().optional(),
      wecomEnabled: z.boolean().optional(),
      wecomBotId: z.string().optional(),
      wecomSecret: z.string().optional(),
    },
    async (patch) => result(host.settingsSet(patch)),
  );
  server.tool(
    "superagent_main_agent_rebuild",
    "用当前设置重建主 agent(会归档旧主 agent,聊天历史不保留)。修改主 agent 模型/思考强度后调用",
    {},
    async () => result(await host.mainAgentRebuild()),
  );
  return server;
}

export async function startMcpServer(host: ToolHost): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("allow", "POST");
      res.end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed: unknown;
    try {
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      res.statusCode = 400;
      res.end("invalid json");
      return;
    }
    const server = buildServer(host);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  });
  const preferredPort = Number(process.env.SUPERAGENT_MCP_PORT ?? 3847);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      httpServer.off("listening", onListening);
      if (error.code === "EADDRINUSE" && preferredPort !== 0) {
        httpServer.listen(0, "127.0.0.1", () => resolve());
        return;
      }
      reject(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(preferredPort, "127.0.0.1");
  });
  const address = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      }),
  };
}
