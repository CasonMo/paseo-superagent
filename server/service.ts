import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PaseoApi, PaseoClient } from "@getpaseo/client";
import { connectDaemon } from "./paseo-client";
import { startExecution } from "./executor";
import { startMcpServer, type ToolHost } from "./mcp-server";
import { executorModeId, paseoToolPolicy } from "./paseo-tools";
import {
  MAIN_PROMPT,
  autowonderCoordinatorPrompt,
  executorPrompt,
  judgePrompt,
} from "./prompts";
import {
  AUTOWONDER_COORDINATOR_TOOLS,
  AUTOWONDER_READ_TOOLS,
  AUTOWONDER_WORKSPACE_ID,
  autowonderMcpUrl,
  autowonderRpc,
  autowonderToolPolicy,
  isAutowonderSource,
} from "./autowonder";
import { runSourceScript } from "./source-runner";
import { nowIso, providerRef, Store, scriptSha, toSourceView, toTicketView, type Settings, type SourceRow, type TicketRow } from "./store";
import { WecomChannel, type WecomInbound } from "./wecom";
import { SUPERAGENT_NOTICE_PREFIX, type UiState } from "../shared/superagent";

const TICK_MS = 1000;
const MONITOR_INTERVAL_MS = 10_000;
const PERMISSION_SWEEP_INTERVAL_MS = 5_000;
const CONVERSATION_REOPEN_WINDOW_MS = 30 * 60_000;
const USER_TURN_TTL_MS = 2 * 60 * 60_000;
const USER_ENGAGED_TTL_MS = 2 * 60_000;
const MAIN_LABEL = { "superagent.role": "main" } as const;
const JUDGE_LABEL = { "superagent.role": "judge" } as const;
const SHARED_JUDGE_LABEL = { "superagent.role": "judge", "superagent.judge": "shared" } as const;
const JUDGE_PROMPT_VERSION = "3";
const SOURCE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function assertSourceId(id: string): string {
  const clean = id.trim();
  if (!SOURCE_ID_RE.test(clean)) {
    throw new Error("source id must be 1-64 chars of letters, digits, _ or -, starting with a letter or digit");
  }
  return clean;
}

function eventNotice(
  sourceName: string,
  ticketId: string,
  qNo: number,
  title: string,
  content: string,
): string {
  return [
    `[新事件] 工单 T-${qNo} (${ticketId})`,
    `消息源: ${sourceName}`,
    `标题: ${title}`,
    "内容:",
    closeMarkdownFences(content.slice(0, 8000)),
    "",
    "请用 superagent_ticket_get 读详情后判断:确实需要人介入推进/决策 → superagent_ticket_wait_human;不需要人介入或无关 → 不要调用 wait_human,直接结束本轮(服务会静默归档,不发企业微信);可执行且已有明确授权 → superagent_ticket_dispatch。",
  ].join("\n");
}

function updateNotice(
  sourceName: string,
  ticketId: string,
  qNo: number,
  title: string,
  content: string,
): string {
  return [
    `[工单更新] 工单 T-${qNo} (${ticketId})`,
    `消息源: ${sourceName}`,
    `标题: ${title}`,
    "新增内容:",
    closeMarkdownFences(content.slice(0, 8000)),
    "",
    "请用 superagent_ticket_get 读详情后判断:确实需要人介入推进/决策 → superagent_ticket_wait_human;不需要人介入 → 不要调用 wait_human,直接结束本轮(服务会静默归档,不发企业微信)。",
  ].join("\n");
}

function closeMarkdownFences(text: string): string {
  const fences = (text.match(/```/g) ?? []).length;
  return fences % 2 === 1 ? `${text}\n\`\`\`` : text;
}

const TOOL_NAMES = [
  "superagent_status",
  "superagent_sources_list",
  "superagent_source_checklist",
  "superagent_source_save",
  "superagent_source_test",
  "superagent_source_approve",
  "superagent_source_toggle",
  "superagent_tickets_list",
  "superagent_ticket_get",
  "superagent_autowonder_history",
  "superagent_ticket_dispatch",
  "superagent_ticket_wait_human",
  "superagent_ticket_reject",
  "superagent_settings_get",
  "superagent_settings_set",
  "superagent_main_agent_rebuild",
] as const;

function stateDir(): string {
  return process.env.SUPERAGENT_HOME || join(homedir(), ".paseo", "superagent");
}

function redact(text: string): string {
  return text
    .replace(/\b1[3-9]\d{9}\b/g, "***")
    .replace(/\b\d{17}[\dXx]\b/g, "***")
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "***")
    .replace(/(token|secret|password)=[^\s&]+/gi, "$1=***");
}

function parseSourceAgentId(content: string): string {
  const match = /^agent:[ \t]*(\S+)[ \t]*$/m.exec(content);
  return match ? match[1] : "";
}

function splitProviderRef(ref: string): { provider: string; model: string } {
  const clean = ref.trim();
  const index = clean.indexOf("/");
  if (index <= 0) return { provider: clean, model: "" };
  return { provider: clean.slice(0, index), model: clean.slice(index + 1) };
}

function extractPrUrl(text: string): string {
  const match = /https?:\/\/[^\s)]+\/(?:pull|merge_requests)\/\d+/.exec(text);
  return match ? match[0] : "";
}

export class Service implements ToolHost {
  private store: Store;
  private client: PaseoClient | null = null;
  private connecting = false;
  private lastConnectAttempt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private runningSources = new Set<string>();
  private ownerRunActive = new Set<string>();
  private ownerRunUntil = new Map<string, number>();
  private busyEffects = new Set<string>();
  private lastMonitor = new Map<string, number>();
  private lastPermissionSweepAt = 0;
  private noticeRetryAt = new Map<string, number>();
  private userTurnUntil = new Map<string, number>();
  private userEngagedAt = new Map<string, number>();
  private noticeDeliveryActive = new Set<string>();
  private mainAgentId = "";
  private judgeAgentId = "";
  private judgeBusy = false;
  private wecom = new WecomChannel();
  private stopped = false;
  private mcp: { url: string; close: () => Promise<void> } | null = null;

  constructor() {
    this.store = new Store(join(stateDir(), "superagent.sqlite"));
  }

  get mcpUrl(): string {
    return this.mcp?.url ?? "";
  }

  async start(): Promise<void> {
    this.ensureBuiltinPaseoSource();
    if (!this.store.kvGet<string>("ui.lastSeenAt", "")) {
      this.store.markItemsSeen();
    }
    this.mcp = await startMcpServer(this);
    await this.ensureClient();
    await this.ensureMainAgent().catch((error) => console.error("[superagent] main agent init failed", error));
    await this.ensureJudgeAgent().catch((error) => console.error("[superagent] judge agent init failed", error));
    this.restartWecom();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.wecom.stop();
    await this.mcp?.close().catch(() => {});
    this.mcp = null;
    if (this.client) await this.client.close().catch(() => {});
    this.client = null;
    this.store.close();
  }

  private async ensureClient(): Promise<PaseoClient | null> {
    if (this.client) return this.client;
    if (this.connecting) return null;
    if (Date.now() - this.lastConnectAttempt < 10_000) return null;
    this.lastConnectAttempt = Date.now();
    this.connecting = true;
    try {
      this.client = await connectDaemon();
      return this.client;
    } catch (error) {
      console.error("[superagent] connect daemon failed", error);
      this.client = null;
      return null;
    } finally {
      this.connecting = false;
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      if (this.store.paused()) return;
      await this.ensureClient();
      if (!this.mainAgentId) {
        await this.ensureMainAgent().catch(() => {});
      }
      await this.runDueSources();
      await this.deliverPendingNotices();
      await this.processEffects();
      await this.approveExecutorPermissions();
      await this.monitorExecutions();
      await this.pushWaiting();
    } catch (error) {
      console.error("[superagent] tick failed", error);
    } finally {
      this.ticking = false;
    }
  }

  private async ensureMainAgent(): Promise<string> {
    const client = this.client;
    if (!client) return "";
    if (this.mainAgentId) {
      const snapshot = await client.agents
        .ref(this.mainAgentId)
        .refresh()
        .catch(() => null);
      if (snapshot && !snapshot.agent.archivedAt) return this.mainAgentId;
      this.mainAgentId = "";
    }
    const stored = this.store.kvGet<string>("agent.main", "");
    if (stored) {
      const snapshot = await client.agents
        .ref(stored)
        .refresh()
        .catch(() => null);
      if (snapshot && !snapshot.agent.archivedAt) {
        this.mainAgentId = stored;
        return stored;
      }
    }
    const listed = await client.agents
      .list({ filter: { labels: { ...MAIN_LABEL }, includeBackground: true } })
      .catch(() => null);
    const found = listed?.entries.find(({ agent }) => agent.labels?.["superagent.role"] === "main")?.agent;
    if (found) {
      this.mainAgentId = found.id;
      this.store.kvSet("agent.main", found.id);
      return found.id;
    }
    const settings = this.store.settings();
    const workspace = await this.ensureSuperagentWorkspace(client);
    const autowonderUrl = autowonderMcpUrl();
    const agent = await workspace.agents.create({
      title: "Superagent",
      config: {
        provider: providerRef(settings.mainProvider, settings.mainModel),
        thinkingOptionId: settings.mainThinking || undefined,
        systemPrompt: MAIN_PROMPT,
        mcpServers: {
          ...(this.mcpUrl
            ? { superagent: { type: "http" as const, url: this.mcpUrl } }
            : {}),
          ...(autowonderUrl
            ? { autowonder: { type: "http" as const, url: autowonderUrl } }
            : {}),
        },
        toolPolicy: {
          preapproved: [
            ...TOOL_NAMES.map((tool) => ({ kind: "mcp" as const, server: "superagent", tool })),
            ...(autowonderUrl ? autowonderToolPolicy(AUTOWONDER_READ_TOOLS) : []),
          ],
        },
      },
      labels: { ...MAIN_LABEL },
    });
    this.mainAgentId = agent.id;
    this.store.kvSet("agent.main", agent.id);
    return agent.id;
  }

  private async ensureSuperagentWorkspace(client: PaseoClient) {
    const stored = this.store.kvGet<string>("workspace.superagent", "");
    if (stored) {
      const existing = client.workspaces.ref(stored);
      const snapshot = await existing.refresh().catch(() => null);
      if (snapshot) return existing;
    }
    const path = join(stateDir(), "workspace");
    mkdirSync(path, { recursive: true });
    const created = await client.workspaces.create({
      source: { kind: "directory", path },
      background: true,
      title: "Superagent",
    });
    this.store.kvSet("workspace.superagent", created.id);
    this.store.kvSet("project.superagent", created.projectId);
    return created;
  }

  private async ensureJudgeAgent(): Promise<string> {
    const client = this.client;
    if (!client) return "";
    const promptVersionOk = () =>
      this.store.kvGet<string>("judge.prompt.version", "") === JUDGE_PROMPT_VERSION;
    const retire = async (agentId: string) => {
      if (agentId) await client.agents.ref(agentId).archive().catch(() => {});
      this.judgeAgentId = "";
      this.store.kvSet("agent.judge", "");
    };
    if (this.judgeAgentId) {
      const snapshot = await client.agents
        .ref(this.judgeAgentId)
        .refresh()
        .catch(() => null);
      if (snapshot && !snapshot.agent.archivedAt && promptVersionOk()) return this.judgeAgentId;
      if (snapshot && !snapshot.agent.archivedAt && !promptVersionOk()) {
        await retire(this.judgeAgentId);
      }
      this.judgeAgentId = "";
    }
    const stored = this.store.kvGet<string>("agent.judge", "");
    if (stored) {
      const snapshot = await client.agents.ref(stored).refresh().catch(() => null);
      if (snapshot && !snapshot.agent.archivedAt && promptVersionOk()) {
        this.judgeAgentId = stored;
        return stored;
      }
      if (snapshot && !snapshot.agent.archivedAt && !promptVersionOk()) {
        await retire(stored);
      }
    }
    const listed = await client.agents
      .list({
        filter: { labels: { ...JUDGE_LABEL }, includeBackground: true },
      })
      .catch(() => null);
    const allJudges = listed?.entries ?? [];
    const shared = allJudges.find(
      ({ agent }) => agent.labels?.["superagent.judge"] === "shared",
    )?.agent;
    if (shared) {
      if (promptVersionOk()) {
        this.judgeAgentId = shared.id;
        this.store.kvSet("agent.judge", shared.id);
        return shared.id;
      }
      await retire(shared.id);
    }
    for (const { agent } of allJudges) {
      if (agent.labels?.["superagent.conversation"]) {
        await client.agents.ref(agent.id).archive().catch(() => {});
      }
    }
    this.store.clearAllConversationJudges();
    const settings = this.store.settings();
    const judgeRef = splitProviderRef(settings.judgeProvider || "");
    const provider = judgeRef.provider || settings.mainProvider;
    const model = judgeRef.model || settings.mainModel;
    const workspace = await this.ensureSuperagentWorkspace(client);
    const autowonderUrl = autowonderMcpUrl();
    const agent = await workspace.agents.create({
      title: "sa-judge-shared",
      config: {
        provider: providerRef(provider, model),
        thinkingOptionId: settings.mainThinking || undefined,
        systemPrompt: judgePrompt(),
        mcpServers: {
          ...(this.mcpUrl
            ? { superagent: { type: "http" as const, url: this.mcpUrl } }
            : {}),
          ...(autowonderUrl
            ? { autowonder: { type: "http" as const, url: autowonderUrl } }
            : {}),
        },
        toolPolicy: {
          preapproved: [
            ...TOOL_NAMES.map((tool) => ({ kind: "mcp" as const, server: "superagent", tool })),
            ...(autowonderUrl ? autowonderToolPolicy(AUTOWONDER_READ_TOOLS) : []),
          ],
        },
      },
      labels: { ...SHARED_JUDGE_LABEL },
    });
    this.judgeAgentId = agent.id;
    this.store.kvSet("agent.judge", agent.id);
    this.store.kvSet("judge.prompt.version", JUDGE_PROMPT_VERSION);
    return agent.id;
  }

  private isJudgeAgent(agentId: string): boolean {
    return (
      Boolean(agentId) &&
      (agentId === this.judgeAgentId || agentId === this.store.kvGet<string>("agent.judge", ""))
    );
  }

  private async notifyMain(message: string): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    const id = await this.ensureMainAgent().catch(() => "");
    if (!id) return false;
    try {
      await client.agents.ref(id).send(message);
      return true;
    } catch (error) {
      console.error("[superagent] notify main failed", error);
      return false;
    }
  }

  private async deliverExecutionResultToMain(
    ticket: TicketRow,
    result: string,
    status: "completed" | "failed",
  ): Promise<void> {
    const clean = result.trim();
    if (!clean) return;
    const agentId = ticket.agentId || ticket.sourceAgentId || "";
    const message = [
      `[执行结果] T-${ticket.qNo} ${ticket.title}`,
      `执行 Agent: ${agentId || "(未记录)"}`,
      `状态: ${status === "completed" ? "完成" : "失败"}`,
      "结果:",
      clean.slice(0, 6000),
      "",
      "请把上面的结果完整汇报给用户,重点保留结论、推荐方案、用户需要执行的动作和风险。不要重新派发、不要修改工单、不要调用 wait_human。",
    ].join("\n");
    await this.notifyMain(message);
  }

  private async deliverPendingNotices(): Promise<void> {
    const client = this.client;
    if (!client || this.stopped) return;
    const notices = this.store.pendingNoticeTickets();
    if (!notices.length) return;
    let started = 0;
    for (const ticket of notices) {
      if (started >= 5) break;
      if (this.judgeBusy) break;
      if ((this.noticeRetryAt.get(ticket.id) ?? 0) > Date.now()) continue;
      const key = ticket.conversationId || "main";
      if (this.noticeDeliveryActive.has(key)) continue;
      const judgeId = await this.ensureJudgeAgent().catch(() => "");
      const agentId = judgeId || (await this.ensureMainAgent().catch(() => ""));
      if (!agentId) continue;
      const snapshot = await client.agents.ref(agentId).refresh().catch(() => null);
      if (
        !snapshot ||
        snapshot.agent.status === "running" ||
        (snapshot.agent.pendingPermissions?.length ?? 0) > 0
      ) {
        continue;
      }
      this.noticeDeliveryActive.add(key);
      this.judgeBusy = true;
      started += 1;
      void this.runNoticeDelivery(agentId, ticket).finally(() => {
        this.judgeBusy = false;
        this.noticeDeliveryActive.delete(key);
      });
    }
  }

  private async runNoticeDelivery(agentId: string, ticket: TicketRow): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const result = await client.agents.ref(agentId).run(ticket.pendingNotice, {
        activeTurnBehavior: "steer",
        timeoutMs: 5 * 60_000,
      });
      if (result.status !== "idle") {
        this.noticeRetryAt.set(ticket.id, Date.now() + 30_000);
        return;
      }
      this.store.clearPendingNotice(ticket.id, ticket.pendingNotice);
      const after = this.store.getTicket(ticket.id);
      if (after && after.state === "pending" && !after.pendingNotice.trim()) {
        this.store.updateTicket(ticket.id, {
          state: "ignored",
          evidence: "AI 判断无需人工介入(未请求人工)",
        });
      }
      this.noticeRetryAt.delete(ticket.id);
    } catch (error) {
      console.error("[superagent] deliver notice failed", ticket.id, error);
      this.noticeRetryAt.set(ticket.id, Date.now() + 30_000);
    }
  }

  private async runDueSources(): Promise<void> {
    const now = Date.now();
    for (const source of this.store.listSources()) {
      if (!source.enabled) continue;
      if (!source.scriptPath || source.scriptSha === "" || source.scriptSha !== source.approvedSha) continue;
      if (this.runningSources.has(source.id)) continue;
      const last = source.lastRunAt ? Date.parse(source.lastRunAt) : 0;
      if (now - last < source.intervalSec * 1000) continue;
      this.runningSources.add(source.id);
      void this.runSource(source).finally(() => this.runningSources.delete(source.id));
    }
  }

  private ingestConversationEvent(input: {
    sourceId: string;
    sourceName: string;
    itemId: string;
    subject: string;
    externalKey: string;
    title: string;
    conversationTitle?: string;
    content: string;
    meta: Record<string, unknown>;
    ownerAgentId?: string;
    skipIfOwnerExecuting?: boolean;
  }): void {
    if (input.skipIfOwnerExecuting) {
      const existingConversation = this.store.findConversationByKey(input.sourceId, input.externalKey);
      const active = existingConversation
        ? this.store.getActiveTicketForConversation(existingConversation.id)
        : null;
      if (active && active.state === "executing" && active.sourceAgentId) return;
    }
    const inserted = this.store.insertItem(
      input.sourceId,
      input.itemId,
      input.subject,
      input.content,
      input.meta,
    );
    if (!inserted) return;
    const conversation = this.store.getOrCreateConversation({
      sourceId: input.sourceId,
      externalKey: input.externalKey,
      title: input.conversationTitle || input.title,
      ownerAgentId: input.ownerAgentId || "",
    });
    const active = this.store.getActiveTicketForConversation(conversation.id);
    if (active) {
      this.store.attachItem(input.sourceId, input.itemId, active.id);
      this.store.appendPendingNotice(
        active.id,
        updateNotice(input.sourceName, active.id, active.qNo, input.title, input.content),
      );
      this.store.touchConversation(conversation.id, input.conversationTitle || input.title);
      return;
    }
    const latest = this.store.findLatestTicketForConversation(conversation.id);
    const canReopen =
      latest &&
      ["done", "failed", "ignored"].includes(latest.state) &&
      Date.now() - Date.parse(latest.updatedAt) <= CONVERSATION_REOPEN_WINDOW_MS;
    if (canReopen && latest) {
      this.store.updateTicket(latest.id, {
        state: "pending",
        question: "",
        plan: "",
        risk: "",
        pushedAt: "",
      });
      this.store.attachItem(input.sourceId, input.itemId, latest.id);
      this.store.appendPendingNotice(
        latest.id,
        updateNotice(input.sourceName, latest.id, latest.qNo, input.title, input.content),
      );
      this.store.touchConversation(conversation.id, input.conversationTitle || input.title);
      return;
    }
    const ticket = this.store.createTicket({
      subject: input.subject,
      sourceId: input.sourceId,
      title: input.title,
      state: "pending",
      sourceAgentId: input.ownerAgentId || "",
      conversationId: conversation.id,
    });
    this.store.appendPendingNotice(
      ticket.id,
      eventNotice(input.sourceName, ticket.id, ticket.qNo, input.title, input.content),
    );
    this.store.attachItem(input.sourceId, input.itemId, ticket.id);
    this.store.touchConversation(conversation.id, input.conversationTitle || input.title);
  }

  private async runSource(source: SourceRow): Promise<void> {
    const cwd = join(stateDir(), "sources", source.id);
    const result = await runSourceScript(source.scriptPath, cwd);
    if (!result.ok) {
      this.store.markSourceRun(source.id, false, [...result.errors, result.stderr].filter(Boolean).join("; "));
      return;
    }
    for (const item of result.items) {
      const workspaceId = Number(item.meta.workspaceId ?? 0);
      if (workspaceId > 0) {
        this.store.kvSet(`source.${source.id}.workspaceId`, String(workspaceId));
      }
      const agentId = typeof item.meta.agentId === "string" ? item.meta.agentId.trim() : "";
      const ownerAgentId =
        (typeof item.meta.ownerAgentId === "string" ? item.meta.ownerAgentId.trim() : "") ||
        agentId ||
        parseSourceAgentId(item.content);
      const externalKey =
        String(item.meta.conversationKey ?? item.meta.subject ?? item.id).trim() || item.id;
      const subject = `${source.id}:${externalKey}`;
      const title = String(item.meta.title ?? item.content.slice(0, 80)).replace(/\s+/g, " ").trim();
      const conversationTitle = String(item.meta.conversationTitle ?? title);
      this.ingestConversationEvent({
        sourceId: source.id,
        sourceName: source.name || source.id,
        itemId: item.id,
        subject,
        externalKey,
        title,
        conversationTitle,
        content: agentId ? `agent: ${agentId}\n${item.content}` : item.content,
        meta: item.meta,
        ownerAgentId,
      });
    }
    this.store.markSourceRun(source.id, true, "");
  }

  private async processEffects(): Promise<void> {
    for (const effect of this.store.dueEffects(10)) {
      if (this.busyEffects.has(effect.id)) continue;
      this.busyEffects.add(effect.id);
      try {
        const payload = JSON.parse(effect.payload || "{}") as Record<string, unknown>;
        if (effect.kind === "execute") {
          await this.handleExecute(effect.ticketId, String(payload.instruction ?? ""));
        }
        this.store.completeEffect(effect.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[superagent] effect failed", effect.kind, message);
        const exhausted = this.store.retryEffect(effect.id, message);
        if (exhausted && effect.kind === "execute") {
          const ticket = this.store.getTicket(effect.ticketId);
          if (ticket && ticket.state !== "done" && ticket.state !== "ignored") {
            this.askHuman(ticket, `执行启动失败: ${message}`);
          }
        }
      } finally {
        this.busyEffects.delete(effect.id);
      }
    }
  }

  private async approveExecutorPermissions(): Promise<void> {
    if (Date.now() - this.lastPermissionSweepAt < PERMISSION_SWEEP_INTERVAL_MS) return;
    this.lastPermissionSweepAt = Date.now();
    const client = this.client;
    if (!client) return;
    const listed = await client.agents
      .list({
        filter: { labels: { "superagent.role": "executor" }, includeBackground: true },
      })
      .catch(() => null);
    for (const { agent } of listed?.entries ?? []) {
      for (const permission of agent.pendingPermissions ?? []) {
        await client.agents
          .ref(agent.id)
          .respondToPermission({
            requestId: permission.id,
            response: { behavior: "allow" },
          })
          .catch((error) => {
            console.error(
              "[superagent] auto approve executor permission failed",
              agent.id,
              permission.id,
              error,
            );
          });
      }
    }
  }

  private askHuman(ticket: TicketRow, question: string): void {
    const conversation = ticket.conversationId
      ? this.store.findConversation(ticket.conversationId)
      : null;
    if (
      conversation?.ownerAgentId &&
      (this.isUserTurn(conversation.ownerAgentId) ||
        this.isRecentlyUserEngaged(conversation.ownerAgentId))
    ) {
      this.store.clearPendingNotice(ticket.id);
      this.store.updateTicket(ticket.id, {
        state: "ignored",
        evidence: "用户刚刚已在对应 Agent 中回复,不再重复打扰",
      });
      return;
    }
    const qNo = ticket.qNo || this.store.nextQNo();
    if (ticket.conversationId) {
      this.store.supersedeWaitingTickets(ticket.conversationId, ticket.id);
      this.store.setConversationActiveTicket(ticket.conversationId, ticket.id);
    }
    this.store.clearPendingNotice(ticket.id);
    this.store.updateTicket(ticket.id, { state: "waiting_human", question, qNo, pushedAt: "" });
  }

  private async handleExecute(ticketId: string, instruction: string): Promise<void> {
    const ticket = this.store.getTicket(ticketId);
    if (!ticket || ticket.state !== "approved") return;
    const client = this.client;
    if (!client) throw new Error("paseo daemon is not connected");
    const settings = this.store.settings();
    if (settings.notifyOnly && !ticket.lastUserReply.trim()) {
      this.askHuman(ticket, "当前为仅通知模式,请先明确指示后再执行。");
      return;
    }
    const instructionParts = [
      ticket.lastUserReply ? `用户在企业微信的原始回复:\n${ticket.lastUserReply}` : "",
      instruction ? `主 agent 补充指示:\n${instruction}` : "",
    ].filter(Boolean);
    const conversation = ticket.conversationId
      ? this.store.findConversation(ticket.conversationId)
      : null;
    if (isAutowonderSource(ticket.sourceId)) {
      const existingCoordinatorId = conversation?.executorAgentId;
      if (existingCoordinatorId) {
        const snapshot = await client.agents
          .ref(existingCoordinatorId)
          .refresh()
          .catch(() => null);
        if (snapshot && !snapshot.agent.archivedAt) {
          this.store.updateTicket(ticket.id, {
            state: "executing",
            agentId: existingCoordinatorId,
            workspaceId: snapshot.agent.workspaceId ?? "",
          });
          try {
            await client.agents.ref(existingCoordinatorId).send(
              autowonderCoordinatorPrompt(ticket, instructionParts.join("\n\n")),
              { activeTurnBehavior: "steer" },
            );
            this.lastMonitor.set(ticket.id, Date.now());
            return;
          } catch (error) {
            console.error("[superagent] reuse autowonder coordinator failed, creating new", error);
            this.store.updateTicket(ticket.id, { state: "approved", agentId: "", workspaceId: "" });
          }
        }
      }
      await this.startAutowonderCoordinator(ticket, instructionParts.join("\n\n"));
      return;
    }
    const ownerAgentId = conversation?.ownerAgentId || ticket.sourceAgentId;
    if (ownerAgentId) {
      this.store.updateTicket(ticket.id, { state: "executing", workspaceId: "" });
      void this.runOwnerAgentTicket(ticket, ownerAgentId, instructionParts.join("\n\n"));
      return;
    }
    const existingExecutorId = conversation?.executorAgentId;
    if (existingExecutorId) {
      const snapshot = await client.agents.ref(existingExecutorId).refresh().catch(() => null);
      if (snapshot && !snapshot.agent.archivedAt) {
        this.store.updateTicket(ticket.id, {
          state: "executing",
          agentId: existingExecutorId,
          workspaceId: snapshot.agent.workspaceId ?? "",
        });
        try {
          await client.agents.ref(existingExecutorId).send(
            executorPrompt(ticket, instructionParts.join("\n\n")),
            { activeTurnBehavior: "steer" },
          );
          this.lastMonitor.set(ticket.id, Date.now());
          return;
        } catch (error) {
          console.error("[superagent] reuse executor failed, creating new", error);
          this.store.updateTicket(ticket.id, { state: "approved", agentId: "", workspaceId: "" });
        }
      }
    }
    const handle = await startExecution(
      client,
      ticket,
      this.store.settings(),
      instructionParts.join("\n\n"),
      this.store.kvGet<string>("project.superagent", ""),
    );
    this.store.updateTicket(ticket.id, {
      state: "executing",
      agentId: handle.agentId,
      workspaceId: handle.workspaceId,
    });
    if (conversation) {
      this.store.setConversationExecutor(conversation.id, handle.agentId);
    }
  }

  private async startAutowonderCoordinator(ticket: TicketRow, instruction: string): Promise<void> {
    const client = this.client;
    if (!client) throw new Error("paseo daemon is not connected");
    const autowonderUrl = autowonderMcpUrl();
    if (!autowonderUrl) throw new Error("autowonder MCP url is not configured");
    const settings = this.store.settings();
    const workspace = await this.ensureSuperagentWorkspace(client);
    const agent = await workspace.agents.create({
      title: `sa-aw-${ticket.id}`,
      config: {
        provider: providerRef(settings.executorProvider, settings.executorModel),
        thinkingOptionId: settings.executorThinking || undefined,
        modeId: executorModeId(settings.executorProvider),
        mcpServers: {
          ...(this.mcpUrl
            ? { superagent: { type: "http" as const, url: this.mcpUrl } }
            : {}),
          autowonder: { type: "http" as const, url: autowonderUrl },
        },
        toolPolicy: {
          preapproved: [
            ...paseoToolPolicy(),
            ...autowonderToolPolicy(AUTOWONDER_COORDINATOR_TOOLS),
            ...(this.mcpUrl
              ? [
                  {
                    kind: "mcp" as const,
                    server: "superagent",
                    tool: "superagent_autowonder_history",
                  },
                  {
                    kind: "mcp" as const,
                    server: "superagent",
                    tool: "superagent_ticket_get",
                  },
                ]
              : []),
          ],
        },
      },
      prompt: autowonderCoordinatorPrompt(ticket, instruction),
      labels: {
        "superagent.ticket": ticket.id,
        "superagent.role": "executor",
        "superagent.kind": "autowonder-coordinator",
      },
    });
    this.store.updateTicket(ticket.id, {
      state: "executing",
      agentId: agent.id,
      workspaceId: workspace.id,
    });
    if (ticket.conversationId) {
      this.store.setConversationExecutor(ticket.conversationId, agent.id);
    }
    this.lastMonitor.set(ticket.id, Date.now());
  }

  private async runOwnerAgentTicket(ticket: TicketRow, agentId: string, instruction: string): Promise<void> {
    const client = this.client;
    if (!client) {
      this.store.updateTicket(ticket.id, { state: "failed", question: "Paseo daemon is not connected" });
      return;
    }
    this.ownerRunActive.add(agentId);
    const prompt = [
      `Superagent 工单 T-${ticket.qNo}: ${ticket.title}`,
      ticket.plan ? `已批准计划:\n${ticket.plan}` : "",
      instruction ? `补充指示:\n${instruction}` : "",
      "请基于你当前会话的上下文继续处理,不要重复已完成的工作。完成后简要说明:改了什么、验证了什么、还有什么风险。",
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      const result = await client.agents.ref(agentId).run(prompt, {
        activeTurnBehavior: "steer",
        timeoutMs: 10 * 60_000,
      });
      if (result.status === "permission") {
        this.askHuman(ticket, "来源 Agent 正在等待权限确认,请在 Paseo 里处理。");
        return;
      }
      if (result.status === "error" || result.status === "timeout") {
        const message =
          result.error || (result.status === "timeout" ? "来源 Agent 执行超时" : "来源 Agent 执行失败");
        this.store.updateTicket(ticket.id, { state: "failed", question: message });
        this.store.appendPendingNotice(ticket.id, `[执行失败] 来源 Agent:\n${message}\nagent: ${agentId}`);
        void this.deliverExecutionResultToMain(ticket, message, "failed");
        return;
      }
      const last = result.lastMessage || "已完成。";
      this.store.updateTicket(ticket.id, {
        state: "done",
        result: last.slice(0, 8000),
        prUrl: extractPrUrl(last),
      });
      this.store.appendPendingNotice(
        ticket.id,
        `[执行完成] 来源 Agent 已回复:\n${last.slice(0, 1500)}\nagent: ${agentId}`,
      );
      void this.deliverExecutionResultToMain(ticket, last, "completed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateTicket(ticket.id, { state: "failed", question: message });
      this.store.appendPendingNotice(ticket.id, `[执行失败] 来源 Agent 调用失败:\n${message}`);
      void this.deliverExecutionResultToMain(ticket, message, "failed");
    } finally {
      this.ownerRunActive.delete(agentId);
      this.ownerRunUntil.set(agentId, Date.now() + 60_000);
    }
  }

  private async lastAssistantMessage(agentId: string): Promise<string> {
    const client = this.client;
    if (!client || !agentId) return "";
    const page = await client.agents
      .ref(agentId)
      .timeline.refetch({ direction: "tail", limit: 20 })
      .catch(() => null);
    const entries = page?.entries ?? [];
    const last = [...entries].reverse().find((entry) => entry.item.type === "assistant_message");
    return last && last.item.type === "assistant_message" ? last.item.text : "";
  }

  private async monitorExecutions(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const now = Date.now();
    for (const ticket of this.store.executingTickets()) {
      if (ticket.sourceAgentId) continue;
      const last = this.lastMonitor.get(ticket.id) ?? 0;
      if (now - last < MONITOR_INTERVAL_MS) continue;
      this.lastMonitor.set(ticket.id, now);
      const agent = client.agents.ref(ticket.agentId);
      const snapshot = await agent.refresh().catch(() => null);
      if (!snapshot) {
        this.store.updateTicket(ticket.id, { state: "failed", question: "执行 agent 已不存在" });
        this.store.appendPendingNotice(
          ticket.id,
          `[执行失败] 工单 ${ticket.id},执行 agent 已不存在,请检查后决定是否重新派发。`,
        );
        void this.deliverExecutionResultToMain(ticket, "执行 Agent 已不存在", "failed");
        continue;
      }
      if (agent.pendingPermissions?.length) {
        this.askHuman(ticket, "执行 agent 正在等待权限确认,请在 Paseo 里处理该 agent。");
        continue;
      }
      if (agent.status === "idle") {
        const lastMessage = await this.lastAssistantMessage(ticket.agentId);
        this.store.updateTicket(ticket.id, {
          state: "done",
          result: lastMessage.slice(0, 8000),
          prUrl: extractPrUrl(lastMessage),
        });
        this.store.appendPendingNotice(
          ticket.id,
          `[执行完成] 工单 ${ticket.id},执行 agent 已结束。\nagent: ${ticket.agentId}\n最后回复:\n${lastMessage.slice(0, 1500)}`,
        );
        void this.deliverExecutionResultToMain(ticket, lastMessage, "completed");
      } else if (agent.status === "error") {
        const lastMessage = await this.lastAssistantMessage(ticket.agentId);
        this.store.updateTicket(ticket.id, {
          state: "failed",
          question: agent.lastError || "执行 agent 报错",
          result: lastMessage.slice(0, 8000),
          prUrl: extractPrUrl(lastMessage),
        });
        this.store.appendPendingNotice(
          ticket.id,
          `[执行失败] 工单 ${ticket.id}: ${agent.lastError || "执行 agent 报错"}\nagent: ${ticket.agentId}`,
        );
        void this.deliverExecutionResultToMain(
          ticket,
          lastMessage || agent.lastError || "执行 agent 报错",
          "failed",
        );
      }
    }
  }

  private async pushWaiting(): Promise<void> {
    const settings = this.store.settings();
    if (!settings.wecomBotId || !settings.wecomSecret) return;
    const chatid = this.store.kvGet<string>("wecom.chatid", "");
    if (!chatid) return;
    const target = this.store.waitingTickets().find((ticket) => !ticket.pushedAt);
    if (!target) return;
    const original = this.store.listTicketItems(target.id, 1)[0]?.content ?? target.title;
    const quote = redact(original)
      .split("\n")
      .slice(0, 10)
      .map((line) => `> ${line}`)
      .join("\n")
      .slice(0, 600);
    const text = [
      `【T-${target.qNo}】待你决策`,
      quote,
      "",
      `**T-${target.qNo} ${target.title}**`,
      redact(target.question).slice(0, 400),
      "",
      `回复:T-${target.qNo} 批准 / T-${target.qNo} 否决 / T-${target.qNo} <你的指示>`,
    ]
      .join("\n")
      .slice(0, 1200);
    await this.wecom.send(chatid, text);
    this.store.updateTicket(target.id, { pushedAt: new Date().toISOString() });
  }

  private restartWecom(): void {
    const settings = this.store.settings();
    if (!settings.wecomBotId || !settings.wecomSecret) {
      this.wecom.stop();
      return;
    }
    this.wecom.start({
      botId: settings.wecomBotId,
      secret: settings.wecomSecret,
      onMessage: (message) => void this.handleWecomMessage(message),
    });
  }

  private async askAgentAndReply(
    agentId: string,
    prompt: string,
  ): Promise<{
    status: "ok" | "permission" | "timeout" | "error" | "unreachable";
    ok: boolean;
    delivered: boolean;
    reply: string;
  }> {
    const client = this.client;
    if (!client) return { status: "unreachable", ok: false, delivered: false, reply: "Superagent 未连接。" };
    if (!agentId) {
      return { status: "unreachable", ok: false, delivered: false, reply: "目标 agent 不存在或已归档。" };
    }
    try {
      const result = await client.agents.ref(agentId).run(prompt, {
        activeTurnBehavior: "steer",
        timeoutMs: 5 * 60 * 1000,
      });
      if (result.status === "permission") {
        return { status: "permission", ok: false, delivered: true, reply: "需要你在 Paseo 里处理权限确认。" };
      }
      if (result.status === "timeout") {
        return { status: "timeout", ok: false, delivered: true, reply: "任务还在处理中,完成后会在面板里显示。" };
      }
      if (result.status === "error") {
        return {
          status: "error",
          ok: false,
          delivered: true,
          reply: result.error || "Superagent 执行出错。",
        };
      }
      return { status: "ok", ok: true, delivered: true, reply: result.lastMessage || "已处理完成。" };
    } catch (error) {
      return {
        status: "unreachable",
        ok: false,
        delivered: false,
        reply: `处理失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async replyWithText(message: WecomInbound, text: string): Promise<void> {
    const finalText = text.slice(0, 6000) || "已处理完成。";
    try {
      await this.wecom.replyStream(message.frame, message.msgid, finalText, true);
    } catch (error) {
      console.error("[superagent] wecom stream text failed", error);
      if (message.chatid) {
        await this.wecom.send(message.chatid, finalText.slice(0, 1200)).catch((sendError) => {
          console.error("[superagent] wecom text fallback failed", sendError);
        });
      }
    }
  }

  private async agentReachable(agentId: string): Promise<boolean> {
    const client = this.client;
    if (!client || !agentId) return false;
    const snapshot = await client.agents.ref(agentId).refresh().catch(() => null);
    return Boolean(snapshot && !snapshot.agent.archivedAt);
  }

  private async replyWithAgent(
    message: WecomInbound,
    agentId: string,
    prompt: string,
    ticket: TicketRow | null,
    fallback?: { agentId: string; prompt: string },
  ): Promise<void> {
    let streamOpen = false;
    try {
      await this.wecom.replyStream(message.frame, message.msgid, "已收到,正在处理...", false);
      streamOpen = true;
    } catch (error) {
      console.error("[superagent] wecom stream ack failed", error);
    }
    let result = await this.askAgentAndReply(agentId, prompt);
    if (fallback && (!result.delivered || result.status === "error")) {
      result = await this.askAgentAndReply(fallback.agentId, fallback.prompt);
    }
    if (ticket && result.delivered && ticket.state === "waiting_human") {
      this.store.ackWaitingTicketsForSubject(ticket.subject, "用户已在企业微信回复");
    }
    const finalText = result.reply.slice(0, 6000) || "已处理完成。";
    if (streamOpen) {
      try {
        await this.wecom.replyStream(message.frame, message.msgid, finalText, true);
      } catch (error) {
        console.error("[superagent] wecom stream final failed", error);
        if (message.chatid) {
          await this.wecom
            .send(message.chatid, finalText.slice(0, 1200))
            .catch((sendError) => console.error("[superagent] wecom reply failed", sendError));
        }
      }
    } else if (message.chatid) {
      await this.wecom
        .send(message.chatid, finalText.slice(0, 1200))
        .catch((error) => console.error("[superagent] wecom reply failed", error));
    }
  }

  private async handleWecomMessage(message: WecomInbound): Promise<void> {
    const quoteBlock = message.quote
      ? `> 引用消息:\n> ${message.quote.trim().replace(/\n/g, "\n> ")}\n\n`
      : "";
    if (!this.store.saveInbox(message.msgid, message.fromUser, quoteBlock + message.text)) return;
    if (message.chatid) this.store.kvSet("wecom.chatid", message.chatid);
    const quoteMatch = message.quote ? /【T-?(\d+)】/.exec(message.quote) : null;
    const textMatch = /T-?(\d+)/i.exec(message.text);
    const qNo = quoteMatch ? Number(quoteMatch[1]) : textMatch ? Number(textMatch[1]) : 0;
    let ticket = qNo ? this.store.findAnyTicketByQNo(qNo) : null;
    if (!ticket && !qNo) {
      const waiting = this.store.waitingTickets();
      if (waiting.length === 1) ticket = waiting[0];
    }
    if (ticket && message.text.trim()) {
      this.store.setUserReply(ticket.id, message.text.trim());
    }
    const mainId = await this.ensureMainAgent().catch(() => "");
    if (!mainId) {
      await this.replyWithText(message, "Superagent 主 agent 未就绪。");
      return;
    }
    const closed = Boolean(ticket && ["done", "failed", "ignored"].includes(ticket.state));
    const header = ticket
      ? closed
        ? `[人工回复] T-${ticket.qNo}(工单 ${ticket.id},已结束,用户追加消息)`
        : `[人工回复] T-${ticket.qNo}(工单 ${ticket.id})`
      : "[企微消息]";
    const mainPrompt = [
      quoteBlock ? `${quoteBlock}${header}` : header,
      message.text || "(无文字内容)",
      closed
        ? "这张工单已经结束,但用户仍在追问或追加需求。能回答就直接回答;需要继续执行就调用 superagent_ticket_dispatch 重新派发;需要新建工单也可以。"
        : ticket
          ? "请根据用户回复处理:用户在提问、要求查看/分析/判断/处理或批准 → 必须调用 superagent_ticket_dispatch(plan 写清调查或执行步骤),不要只在聊天里回答;只有明确否决/忽略才调用 superagent_ticket_reject。"
          : "",
    ]
      .filter(Boolean)
      .join("\n");
    await this.replyWithAgent(message, mainId, mainPrompt, ticket);
  }

  private decideTicket(id: string, action: "approve" | "reject" | "stop", instruction?: string): string {
    const ticket = this.store.getTicket(id);
    if (!ticket) throw new Error("ticket not found");
    this.store.clearPendingNotice(ticket.id);
    if (action === "approve") {
      if (!ticket.lastUserReply.trim()) {
        this.store.setUserReply(ticket.id, "用户通过面板批准执行");
      }
      this.store.updateTicket(ticket.id, { state: "approved" });
      this.store.enqueueEffect(ticket.id, "execute", `execute:${ticket.id}:${Date.now()}`, {
        instruction: instruction ?? "",
      });
      return "approved";
    }
    this.store.updateTicket(ticket.id, { state: "ignored" });
    if (ticket.agentId && this.client) {
      void this.client.agents.ref(ticket.agentId).archive().catch(() => {});
    }
    return "ignored";
  }

  saveSource(input: { id: string; name?: string; intervalSec: number; script: string }): { id: string; scriptSha: string } {
    const id = assertSourceId(input.id);
    if (id === "paseo") {
      throw new Error("source id 'paseo' is reserved for the built-in Paseo listener");
    }
    const dir = join(stateDir(), "sources", id);
    mkdirSync(dir, { recursive: true });
    const scriptPath = join(dir, "run");
    writeFileSync(scriptPath, input.script, "utf8");
    chmodSync(scriptPath, 0o755);
    const sha = scriptSha(input.script);
    this.store.upsertSource({
      id,
      name: input.name || id,
      intervalSec: input.intervalSec,
      scriptPath,
      scriptSha: sha,
    });
    return { id, scriptSha: sha };
  }

  sourceSave(input: { id: string; name?: string; intervalSec: number; script: string }) {
    return this.saveSource(input);
  }

  async sourceTest(id: string): Promise<{ ok: boolean; lines: number; preview: string[]; error: string }> {
    const sourceId = assertSourceId(id);
    const source = this.store.getSource(sourceId);
    if (!source) return { ok: false, lines: 0, preview: [], error: "source not found" };
    if (!source.scriptPath) return { ok: false, lines: 0, preview: [], error: "script not saved" };
    const result = await runSourceScript(source.scriptPath, join(stateDir(), "sources", sourceId));
    return {
      ok: result.ok,
      lines: result.items.length,
      preview: result.items.slice(0, 5).map((item) => `${item.id}: ${item.content.slice(0, 120)}`),
      error: [...result.errors, result.stderr].filter(Boolean).join("; "),
    };
  }

  sourceApprove(id: string): { approvedSha: string } {
    const source = this.store.getSource(assertSourceId(id));
    if (!source) throw new Error("source not found");
    this.store.approveSource(source.id, source.scriptSha);
    return { approvedSha: source.scriptSha };
  }

  sourceToggle(id: string, enabled: boolean): { enabled: boolean } {
    this.store.setSourceEnabled(assertSourceId(id), enabled);
    return { enabled };
  }

  sourceDelete(id: string): { ok: boolean } {
    const sourceId = assertSourceId(id);
    const source = this.store.getSource(sourceId);
    if (!source) return { ok: false };
    if (source.scriptPath) {
      rmSync(join(stateDir(), "sources", sourceId), { recursive: true, force: true });
    }
    this.store.deleteSource(sourceId);
    return { ok: true };
  }

  private ensureBuiltinPaseoSource(): void {
    if (this.store.kvGet<boolean>("builtin.paseo.initialized", false)) return;
    this.store.upsertBuiltinSource({ id: "paseo", name: "Paseo Agent 监听" });
    this.store.kvSet("builtin.paseo.initialized", true);
  }

  ingestPaseoEvent(kind: string, agent: { id: string; title?: string | null; provider: string }, detail: string): void {
    const source = this.store.getSource("paseo");
    if (!source || !source.enabled) return;
    if (agent.id === this.mainAgentId || agent.id === this.store.kvGet<string>("agent.main", "")) return;
    if (this.isJudgeAgent(agent.id)) return;
    if (this.isUserTurn(agent.id)) return;
    if (this.store.hasTicketForAgent(agent.id)) return;
    if (this.ownerRunActive.has(agent.id) || (this.ownerRunUntil.get(agent.id) ?? 0) > Date.now()) return;
    const title = agent.title || agent.id;
    const itemId = `paseo:${kind}:${agent.id}:${Date.now()}`;
    const content = [`[${kind}] ${title}`, `agent: ${agent.id}`, `provider: ${agent.provider}`, detail]
      .filter(Boolean)
      .join("\n");
    this.ingestConversationEvent({
      sourceId: "paseo",
      sourceName: "Paseo Agent 监听",
      itemId,
      subject: `paseo-agent-${agent.id}`,
      externalKey: agent.id,
      title: `${kind}: ${title}`,
      conversationTitle: title,
      content,
      meta: {
        subject: agent.id,
        title: `${kind}: ${title}`,
        url: "",
        at: new Date().toISOString(),
      },
      ownerAgentId: agent.id,
      skipIfOwnerExecuting: true,
    });
  }

  async ingestTurn(
    agent: { id: string; title?: string | null; provider: string; cwd?: string },
    outcome: { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled"; reason: string },
    paseo: PaseoApi,
  ): Promise<void> {
    if (agent.id === this.mainAgentId || agent.id === this.store.kvGet<string>("agent.main", "")) return;
    if (this.isJudgeAgent(agent.id)) return;
    if (this.store.hasTicketForAgent(agent.id)) return;
    let summary = "";
    try {
      const page = await paseo.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: 12 });
      const last = [...(page.entries ?? [])].reverse().find((entry) => entry.item.type === "assistant_message");
      if (last && last.item.type === "assistant_message") {
        summary = last.item.text.includes("```mermaid")
          ? last.item.text
          : last.item.text.slice(0, 8000);
      }
    } catch {
      // timeline may be unavailable; the event is still useful without it
    }
    const kind =
      outcome.kind === "failed" ? "执行失败" : outcome.kind === "canceled" ? "会话取消" : "会话完成";
    const detail =
      outcome.kind === "failed"
        ? `结果: failed\n错误: ${outcome.error.message}\n最后回复: ${summary}`
        : outcome.kind === "canceled"
          ? `结果: canceled\n原因: ${outcome.reason}\n最后回复: ${summary}`
          : `结果: completed\n最后回复: ${summary || "(无文本回复)"}`;
    this.ingestPaseoEvent(kind, agent, detail);
  }

  ackWaitingTickets(reason = "用户已在主对话回复"): number {
    return this.store.ackWaitingTickets(reason);
  }

  async ackRepliesForAgent(agent: { id: string }, paseo: PaseoApi): Promise<boolean> {
    let entries: Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["refetch"]>>["entries"];
    try {
      const page = await paseo.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: 500 });
      entries = page.entries ?? [];
    } catch {
      return false;
    }
    const last = entries[entries.length - 1];
    const mainId = this.mainAgentId || this.store.kvGet<string>("agent.main", "");
    const isMain = agent.id === mainId;
    const subject = `paseo-agent-${agent.id}`;
    const judgeConversation = this.store.findConversationByJudgeAgent(agent.id);
    const userTurn =
      last?.item.type === "user_message" &&
      !SUPERAGENT_NOTICE_PREFIX.test(last.item.text.trimStart());
    if (userTurn) {
      this.userTurnUntil.set(agent.id, Date.now() + USER_TURN_TTL_MS);
      this.userEngagedAt.set(agent.id, Date.now());
      this.store.ackWaitingTicketsForOwnerAgent(agent.id, "用户已在对应 Agent 中回复");
      if (judgeConversation) {
        this.store.ackWaitingTicketsForConversation(
          judgeConversation.id,
          "用户已在该会话的研判 Agent 中回复",
        );
      }
    }
    const waiting = isMain
      ? this.store.waitingTickets()
      : judgeConversation
        ? this.store.waitingTicketsForConversation(judgeConversation.id)
        : this.store.waitingTicketsForSubject(subject);
    if (!waiting.length) return userTurn;
    const lastUser = [...entries].reverse().find((entry) => entry.item.type === "user_message");
    if (!lastUser || lastUser.item.type !== "user_message") return userTurn;
    if (SUPERAGENT_NOTICE_PREFIX.test(lastUser.item.text.trimStart())) return userTurn;
    const at = lastUser.timestamp || nowIso();
    if (isMain) {
      this.store.ackWaitingTickets("用户已在主对话回复", at);
    } else if (judgeConversation) {
      this.store.ackWaitingTicketsForConversation(
        judgeConversation.id,
        "用户已在会话研判 Agent 中回复",
        at,
      );
    } else {
      this.store.ackWaitingTicketsForSubject(subject, "用户已在对应 Agent 中回复", at);
    }
    return userTurn;
  }

  consumeUserTurn(agentId: string): boolean {
    const until = this.userTurnUntil.get(agentId) ?? 0;
    this.userTurnUntil.delete(agentId);
    return until > Date.now();
  }

  isUserTurn(agentId: string): boolean {
    return (this.userTurnUntil.get(agentId) ?? 0) > Date.now();
  }

  private isRecentlyUserEngaged(agentId: string): boolean {
    return (this.userEngagedAt.get(agentId) ?? 0) > Date.now() - USER_ENGAGED_TTL_MS;
  }

  ackOwnerAgentTickets(agentId: string): number {
    return this.store.ackWaitingTicketsForOwnerAgent(agentId, "用户已在对应 Agent 中回复");
  }

  status() {
    const settings = this.store.settings();
    return {
      paused: this.store.paused(),
      newEvents: this.store.countNewItems(),
      ui: this.store.uiState(),
      settings: {
        mainAgentId: this.mainAgentId,
        judgeAgentId: this.judgeAgentId || this.store.kvGet<string>("agent.judge", ""),
        mainProvider: settings.mainProvider,
        mainModel: settings.mainModel,
        mainThinking: settings.mainThinking,
        executorModel: settings.executorModel,
        executorThinking: settings.executorThinking,
        notifyOnly: settings.notifyOnly,
        judgeProvider: settings.judgeProvider,
        executorProvider: settings.executorProvider,
        repoPath: settings.repoPath,
        baseBranch: settings.baseBranch,
        wecomEnabled: settings.wecomEnabled,
        wecomBotId: settings.wecomBotId,
        wecomConfigured: Boolean(settings.wecomBotId && settings.wecomSecret),
        wecomConnected: this.wecom.connected,
        wecomError: this.wecom.error,
      },
      sources: this.store.listSources().map(toSourceView),
      tickets: this.store.listTickets().map(toTicketView),
    };
  }

  settings(): Settings {
    return this.store.settings();
  }

  saveSettings(patch: Partial<Settings>): { ok: boolean } {
    this.store.saveSettings(patch);
    this.restartWecom();
    return { ok: true };
  }

  setPaused(paused: boolean): { paused: boolean } {
    this.store.setPaused(paused);
    return { paused };
  }

  decide(id: string, action: "approve" | "reject" | "stop", instruction?: string): string {
    return this.decideTicket(id, action, instruction);
  }

  wecomTest(): { ok: boolean; error: string } {
    if (!this.wecom.connected) return { ok: false, error: this.wecom.error || "wecom is not connected" };
    return { ok: true, error: "" };
  }

  statusSnapshot() {
    const status = this.status();
    return {
      paused: status.paused,
      mainAgentId: status.settings.mainAgentId,
      sources: status.sources.map((source) => ({
        id: source.id,
        name: source.name,
        enabled: source.enabled,
        approved: source.approved,
        intervalSec: source.intervalSec,
        lastError: source.lastError,
      })),
      tickets: status.tickets.slice(0, 20).map((ticket) => ({
        id: ticket.id,
        state: ticket.state,
        title: ticket.title,
        qNo: ticket.qNo,
      })),
    };
  }

  sourcesList() {
    return this.store.listSources().map(toSourceView);
  }

  ticketsList(state?: string) {
    const tickets = this.store.listTickets(200);
    return (state ? tickets.filter((ticket) => ticket.state === state) : tickets).map(toTicketView);
  }

  messagesList(limit = 80) {
    const sourceNames = new Map(
      this.store.listSources().map((source) => [source.id, source.name || source.id]),
    );
    return this.store.listMessageFeed(limit).map((message) => ({
      id: `${message.sourceId}:${message.itemId}`,
      sourceId: message.sourceId,
      sourceName: sourceNames.get(message.sourceId) || message.sourceId,
      content: message.content,
      seenAt: message.seenAt,
      ticketId: message.ticketId,
      qNo: message.qNo,
      ticketState: message.ticketState,
      ticketTitle: message.ticketTitle,
      conversationId: message.conversationId,
    }));
  }

  async autowonderHistory(
    workitemId: number,
    workspaceId = AUTOWONDER_WORKSPACE_ID,
    limit = 20,
  ) {
    const url = autowonderMcpUrl();
    if (!url) return { error: "Autowonder MCP url is not configured" };
    const workitem = await autowonderRpc<Record<string, unknown>>(
      url,
      "autowonder.get_workitem",
      { workspaceId, id: workitemId },
    );
    const commentPayload = await autowonderRpc<{ items?: Array<Record<string, unknown>> }>(
      url,
      "autowonder.list_workitem_comments",
      { workspaceId, id: workitemId },
    );
    const workType = String(workitem.workType ?? "");
    let statusTemplate: Record<string, unknown> | null = null;
    if (workType) {
      const templates = await autowonderRpc<{ items?: Array<Record<string, unknown>> }>(
        url,
        "autowonder.list_status_templates",
        { workspaceId, workType },
      ).catch(() => ({ items: [] }));
      const selected =
        templates.items?.find((item) => Boolean(item.isDefault)) ?? templates.items?.[0];
      const templateId = Number(selected?.id ?? 0);
      if (templateId > 0) {
        statusTemplate = await autowonderRpc<Record<string, unknown>>(
          url,
          "autowonder.get_status_template",
          { workspaceId, id: templateId },
        ).catch(() => null);
      }
    }

    const allComments = (commentPayload.items ?? [])
      .map((comment) => {
        const content = String(comment.contentMd ?? "");
        const heading = content.trimStart().slice(0, 120);
        return {
          id: Number(comment.id ?? 0),
          authorType: String(comment.authorType ?? ""),
          authorRef: Number(comment.authorRef ?? 0),
          content,
          gmtCreate: Number(comment.gmtCreate ?? 0),
          isBlocker:
            String(comment.authorType ?? "") === "AGENT" &&
            /^【(需要人处理|需要人决策|需要人工|无法推进|阻断|需要用户决策|需要你处理)/.test(heading),
        };
      })
      .sort((a, b) => a.gmtCreate - b.gmtCreate);
    const recent = allComments.slice(-Math.max(5, Math.min(50, limit)));
    const blockers = allComments.filter((comment) => comment.isBlocker).slice(-10);
    const selected = new Map<number, (typeof allComments)[number]>();
    for (const comment of [...blockers, ...recent]) selected.set(comment.id, comment);
    const comments = [...selected.values()].sort((a, b) => a.gmtCreate - b.gmtCreate);

    const authorNames = new Map<number, string>();
    for (const ref of new Set(comments.filter((item) => item.authorType === "AGENT").map((item) => item.authorRef))) {
      if (!ref) continue;
      const cacheKey = `autowonder.agentName.${ref}`;
      let name = this.store.kvGet<string>(cacheKey, "");
      if (!name) {
        const agent = await autowonderRpc<Record<string, unknown>>(url, "autowonder.get_agent", {
          workspaceId,
          id: ref,
        }).catch(() => null);
        name = String(agent?.name ?? "");
        if (name) this.store.kvSet(cacheKey, name);
      }
      authorNames.set(ref, name || `AGENT#${ref}`);
    }

    return {
      workitem: {
        id: Number(workitem.id ?? workitemId),
        title: String(workitem.title ?? ""),
        workType,
        statusNodeId: Number(workitem.statusNodeId ?? 0),
        statusName: String(workitem.statusName ?? ""),
        assigneeDisplayName: String(workitem.assigneeDisplayName ?? ""),
        assigneeName: String(workitem.assigneeName ?? ""),
        gmtModified: Number(workitem.gmtModified ?? 0),
      },
      statusTemplate: statusTemplate
        ? {
            id: Number(statusTemplate.id ?? 0),
            name: String(statusTemplate.name ?? ""),
            nodes: statusTemplate.nodes ?? [],
            transitions: statusTemplate.transitions ?? [],
          }
        : null,
      comments: comments.map((comment) => ({
        id: comment.id,
        authorType: comment.authorType,
        authorRef: comment.authorRef,
        authorName: authorNames.get(comment.authorRef) ?? "",
        content: comment.content.slice(0, comment.isBlocker ? 3000 : 1200),
        gmtCreate: comment.gmtCreate,
        isBlocker: comment.isBlocker,
      })),
    };
  }

  ticketGet(id: string) {
    const ticket = this.store.getTicket(id);
    return ticket
      ? { ...toTicketView(ticket), items: this.store.listTicketItems(ticket.id) }
      : { error: "ticket not found" };
  }

  ticketReply(qNo: number, text: string) {
    const ticket = this.store.findAnyTicketByQNo(qNo);
    if (!ticket) return { ok: false };
    this.store.setUserReply(ticket.id, text);
    if (ticket.conversationId) {
      this.store.ackWaitingTicketsForConversation(ticket.conversationId, "用户已在面板回复");
    }
    return { ok: true };
  }

  async ticketRoute(qNo: number) {
    const ticket = this.store.findAnyTicketByQNo(qNo);
    const conversation = ticket?.conversationId
      ? this.store.findConversation(ticket.conversationId)
      : null;
    if (!conversation) return { agentId: "", conversationId: "", title: "" };
    const agentId = await this.ensureJudgeAgent().catch(() => "");
    return {
      agentId,
      conversationId: conversation.id,
      title: conversation.title || conversation.externalKey,
    };
  }

  ticketDispatch(id: string, plan: string, instruction: string) {
    const ticket = this.store.getTicket(id);
    if (!ticket) return { error: "ticket not found" };
    if (!plan.trim()) return { error: "plan is required" };
    const settings = this.store.settings();
    if (settings.notifyOnly && !ticket.lastUserReply.trim()) {
      return {
        error:
          "当前为仅通知模式:请先让用户明确指示后再派发。可以先用 superagent_ticket_wait_human 把摘要/问题通知用户。",
      };
    }
    this.store.clearPendingNotice(ticket.id);
    this.store.updateTicket(ticket.id, { state: "approved", plan, risk: ticket.risk || "code" });
    this.store.enqueueEffect(ticket.id, "execute", `execute:${ticket.id}:${Date.now()}`, { instruction });
    return { ok: true, ticket: ticket.id, state: "approved" };
  }

  ticketWaitHuman(id: string, question: string) {
    const ticket = this.store.getTicket(id);
    if (!ticket) return { error: "ticket not found" };
    if (!question.trim()) return { error: "question is required" };
    this.askHuman(ticket, question);
    return { ok: true, ticket: ticket.id, state: "waiting_human" };
  }

  ticketReject(id: string, reason: string) {
    const ticket = this.store.getTicket(id);
    if (!ticket) return { error: "ticket not found" };
    const settings = this.store.settings();
    if (settings.notifyOnly && !ticket.lastUserReply.trim()) {
      return {
        error: "当前为仅通知模式:不要自动忽略工单;请先通知用户并等待明确指示。",
      };
    }
    this.store.clearPendingNotice(ticket.id);
    this.store.updateTicket(ticket.id, { state: "ignored", evidence: reason || ticket.evidence });
    return { ok: true, ticket: ticket.id, state: "ignored" };
  }

  settingsGet() {
    const settings = this.store.settings();
    return {
      mainProvider: settings.mainProvider,
      mainModel: settings.mainModel,
      mainThinking: settings.mainThinking,
      executorProvider: settings.executorProvider,
      executorModel: settings.executorModel,
      executorThinking: settings.executorThinking,
      notifyOnly: settings.notifyOnly,
      repoPath: settings.repoPath,
      baseBranch: settings.baseBranch,
      wecomEnabled: settings.wecomEnabled,
      wecomConfigured: Boolean(settings.wecomBotId && settings.wecomSecret),
      wecomConnected: this.wecom.connected,
      wecomError: this.wecom.error,
    };
  }

  settingsSet(patch: Partial<Settings>) {
    this.saveSettings(patch);
    return this.settingsGet();
  }

  async rebuildMainAgent(): Promise<{ agentId: string }> {
    const client = this.client;
    if (!client) return { agentId: "" };
    if (this.mainAgentId) {
      await client.agents.ref(this.mainAgentId).archive().catch(() => {});
    }
    this.mainAgentId = "";
    this.store.kvSet("agent.main", "");
    const id = await this.ensureMainAgent();
    return { agentId: id };
  }

  mainAgentRebuild(): Promise<unknown> {
    return this.rebuildMainAgent();
  }

  markSeen(): { ok: boolean } {
    this.store.markItemsSeen();
    return { ok: true };
  }

  saveUiState(state: UiState): { ok: boolean } {
    this.store.saveUiState(state);
    return { ok: true };
  }
}
