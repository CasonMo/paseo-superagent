import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const SUPERAGENT_NOTICE_PREFIX = /^\[(新事件|工单更新|执行完成|执行失败|执行结果|人工回复|企微消息|分诊规则-必须遵守)\]/;

export const ticketStateSchema = z.enum([
  "pending",
  "waiting_human",
  "approved",
  "executing",
  "done",
  "failed",
  "ignored",
]);
export type TicketState = z.infer<typeof ticketStateSchema>;

export const riskSchema = z.enum(["comment", "code", "mutation", ""]);
export type Risk = z.infer<typeof riskSchema>;

export const sourceViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  intervalSec: z.number(),
  enabled: z.boolean(),
  approved: z.boolean(),
  scriptSha: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastOkAt: z.string().nullable(),
  failCount: z.number(),
  lastError: z.string().nullable(),
});
export type SourceView = z.infer<typeof sourceViewSchema>;

export const ticketViewSchema = z.object({
  id: z.string(),
  subject: z.string(),
  sourceId: z.string(),
  conversationId: z.string(),
  state: ticketStateSchema,
  title: z.string(),
  question: z.string(),
  plan: z.string(),
  risk: riskSchema,
  evidence: z.string(),
  result: z.string(),
  prUrl: z.string(),
  qNo: z.number(),
  agentId: z.string(),
  sourceAgentId: z.string(),
  workspaceId: z.string(),
  lastUserReply: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TicketView = z.infer<typeof ticketViewSchema>;

export const messageViewSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  sourceName: z.string(),
  content: z.string(),
  seenAt: z.string(),
  ticketId: z.string(),
  qNo: z.number(),
  ticketState: z.string(),
  ticketTitle: z.string(),
  conversationId: z.string(),
});
export type MessageView = z.infer<typeof messageViewSchema>;

export const settingsViewSchema = z.object({
  mainAgentId: z.string(),
  judgeAgentId: z.string(),
  mainProvider: z.string(),
  mainModel: z.string(),
  mainThinking: z.string(),
  executorModel: z.string(),
  executorThinking: z.string(),
  notifyOnly: z.boolean(),
  judgeProvider: z.string(),
  executorProvider: z.string(),
  repoPath: z.string(),
  baseBranch: z.string(),
  wecomEnabled: z.boolean(),
  wecomBotId: z.string(),
  wecomConfigured: z.boolean(),
  wecomConnected: z.boolean(),
  wecomError: z.string(),
});
export type SettingsView = z.infer<typeof settingsViewSchema>;

export const uiStateSchema = z.object({
  sidebarOpen: z.boolean(),
  sidebarWidth: z.number(),
});
export type UiState = z.infer<typeof uiStateSchema>;

export const statusRpc = defineRpc({
  name: "superagent.status",
  input: z.object({}),
  output: z.object({
    paused: z.boolean(),
    newEvents: z.number(),
    settings: settingsViewSchema,
    ui: uiStateSchema,
    sources: z.array(sourceViewSchema),
    tickets: z.array(ticketViewSchema),
  }),
});

export const pauseRpc = defineRpc({
  name: "superagent.pause",
  input: z.object({ paused: z.boolean() }),
  output: z.object({ paused: z.boolean() }),
});

export const sourceSaveRpc = defineRpc({
  name: "superagent.source.save",
  input: z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
    name: z.string().default(""),
    intervalSec: z.number().int().min(10).max(86400).default(300),
    script: z.string().min(1),
  }),
  output: z.object({ id: z.string(), scriptSha: z.string() }),
});

export const sourceTestRpc = defineRpc({
  name: "superagent.source.test",
  input: z.object({ id: z.string() }),
  output: z.object({
    ok: z.boolean(),
    lines: z.number(),
    preview: z.array(z.string()),
    error: z.string(),
  }),
});

export const sourceApproveRpc = defineRpc({
  name: "superagent.source.approve",
  input: z.object({ id: z.string() }),
  output: z.object({ approvedSha: z.string() }),
});

export const sourceToggleRpc = defineRpc({
  name: "superagent.source.toggle",
  input: z.object({ id: z.string(), enabled: z.boolean() }),
  output: z.object({ enabled: z.boolean() }),
});

export const sourceDeleteRpc = defineRpc({
  name: "superagent.source.delete",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const ticketDecideRpc = defineRpc({
  name: "superagent.ticket.decide",
  input: z.object({
    id: z.string(),
    action: z.enum(["approve", "reject", "stop"]),
    instruction: z.string().optional(),
  }),
  output: z.object({ state: ticketStateSchema }),
});

export const ticketReplyRpc = defineRpc({
  name: "superagent.ticket.reply",
  input: z.object({ qNo: z.number().int(), text: z.string().min(1) }),
  output: z.object({ ok: z.boolean() }),
});

export const ticketRouteRpc = defineRpc({
  name: "superagent.ticket.route",
  input: z.object({ qNo: z.number().int() }),
  output: z.object({
    agentId: z.string(),
    conversationId: z.string(),
    title: z.string(),
  }),
});

export const ticketsAckRpc = defineRpc({
  name: "superagent.tickets.ack",
  input: z.object({ reason: z.string().optional() }),
  output: z.object({ ok: z.boolean(), count: z.number() }),
});

export const messagesListRpc = defineRpc({
  name: "superagent.messages.list",
  input: z.object({ limit: z.number().int().min(1).max(200).default(80) }),
  output: z.object({ messages: z.array(messageViewSchema) }),
});

export const settingsSaveRpc = defineRpc({
  name: "superagent.settings.save",
  input: z.object({
    mainProvider: z.string().optional(),
    mainModel: z.string().optional(),
    mainThinking: z.string().optional(),
    executorModel: z.string().optional(),
    executorThinking: z.string().optional(),
    notifyOnly: z.boolean().optional(),
    judgeProvider: z.string().optional(),
    executorProvider: z.string().optional(),
    repoPath: z.string().optional(),
    baseBranch: z.string().optional(),
    wecomEnabled: z.boolean().optional(),
    wecomBotId: z.string().optional(),
    wecomSecret: z.string().optional(),
  }),
  output: z.object({ ok: z.boolean() }),
});

export const mainAgentRebuildRpc = defineRpc({
  name: "superagent.main.rebuild",
  input: z.object({}),
  output: z.object({ agentId: z.string() }),
});

export const markSeenRpc = defineRpc({
  name: "superagent.mark_seen",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

export const uiStateSaveRpc = defineRpc({
  name: "superagent.ui_state.save",
  input: uiStateSchema,
  output: z.object({ ok: z.boolean() }),
});

export const wecomTestRpc = defineRpc({
  name: "superagent.wecom.test",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), error: z.string() }),
});
