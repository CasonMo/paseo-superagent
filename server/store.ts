import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Risk, SourceView, TicketState, TicketView, UiState } from "../shared/superagent";

export interface Settings {
  mainProvider: string;
  mainModel: string;
  mainThinking: string;
  judgeProvider: string;
  executorProvider: string;
  executorModel: string;
  executorThinking: string;
  notifyOnly: boolean;
  repoPath: string;
  baseBranch: string;
  wecomEnabled: boolean;
  wecomBotId: string;
  wecomSecret: string;
}

export const DEFAULT_SETTINGS: Settings = {
  mainProvider: "codex",
  mainModel: "",
  mainThinking: "high",
  judgeProvider: "codex",
  executorProvider: "codex",
  executorModel: "",
  executorThinking: "high",
  notifyOnly: true,
  repoPath: "",
  baseBranch: "main",
  wecomEnabled: false,
  wecomBotId: "",
  wecomSecret: "",
};

export interface SourceRow {
  id: string;
  name: string;
  scriptPath: string;
  scriptSha: string;
  approvedSha: string;
  intervalSec: number;
  enabled: boolean;
  lastRunAt: string;
  lastOkAt: string;
  failCount: number;
  lastError: string;
}

export interface TicketRow {
  id: string;
  subject: string;
  sourceId: string;
  conversationId: string;
  state: TicketState;
  title: string;
  question: string;
  plan: string;
  risk: Risk;
  evidence: string;
  result: string;
  prUrl: string;
  qNo: number;
  agentId: string;
  sourceAgentId: string;
  workspaceId: string;
  pushedAt: string;
  pendingNotice: string;
  notifiedAt: string;
  lastUserReply: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationRow {
  id: string;
  sourceId: string;
  externalKey: string;
  title: string;
  ownerAgentId: string;
  executorAgentId: string;
  judgeAgentId: string;
  activeTicketId: string;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRow {
  sourceId: string;
  itemId: string;
  content: string;
  seenAt: string;
  ticketId: string;
  qNo: number;
  ticketState: string;
  ticketTitle: string;
  conversationId: string;
}

export interface EffectRow {
  id: string;
  ticketId: string;
  kind: string;
  idemKey: string;
  payload: string;
  status: string;
  attempts: number;
  nextAt: string;
  lastError: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function providerRef(provider: string, model: string): string {
  const cleanProvider = provider.trim().replace(/\/+$/, "");
  const cleanModel = model.trim().replace(/^\/+/, "");
  if (!cleanProvider) return cleanModel;
  if (!cleanModel) return cleanProvider;
  return `${cleanProvider}/${cleanModel}`;
}

function normalizeSettings(settings: Settings): Settings {
  return {
    ...settings,
    wecomEnabled: Boolean(settings.wecomBotId?.trim() && settings.wecomSecret?.trim()),
  };
}

export function scriptSha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function asBool(value: unknown): boolean {
  return Number(value) === 1;
}

function asString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

export class Store {
  readonly db: DatabaseSync;

  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists kv (key text primary key, value text not null);
      create table if not exists sources (
        id text primary key, name text not null default '', script_path text not null default '',
        script_sha text not null default '', approved_sha text not null default '',
        interval_sec integer not null default 300, enabled integer not null default 1,
        last_run_at text not null default '', last_ok_at text not null default '',
        fail_count integer not null default 0, last_error text not null default ''
      );
      create table if not exists items (
        source_id text not null, item_id text not null, subject text not null,
        content text not null, meta text not null default '{}', seen_at text not null,
        ticket_id text not null default '', primary key (source_id, item_id)
      );
      create table if not exists tickets (
        id text primary key, subject text not null, source_id text not null,
        conversation_id text not null default '',
        state text not null, title text not null default '', question text not null default '',
        plan text not null default '', risk text not null default '', evidence text not null default '',
        result text not null default '', pr_url text not null default '',
        q_no integer not null default 0, agent_id text not null default '',
        source_agent_id text not null default '',
        workspace_id text not null default '', pushed_at text not null default '',
        pending_notice text not null default '', notified_at text not null default '',
        last_user_reply text not null default '',
        created_at text not null, updated_at text not null
      );
      create table if not exists conversations (
        id text primary key,
        source_id text not null,
        external_key text not null,
        title text not null default '',
        owner_agent_id text not null default '',
        executor_agent_id text not null default '',
        judge_agent_id text not null default '',
        active_ticket_id text not null default '',
        last_activity_at text not null,
        created_at text not null,
        updated_at text not null
      );
      create unique index if not exists conversation_external_key
        on conversations(source_id, external_key);
      create unique index if not exists live_ticket_per_subject
        on tickets(subject) where state not in ('done','failed','ignored');
      create table if not exists effects (
        id text primary key, ticket_id text not null, kind text not null,
        idem_key text not null unique, payload text not null default '{}',
        status text not null default 'pending', attempts integer not null default 0,
        next_at text not null default '', last_error text not null default ''
      );
      create table if not exists inbox (
        msgid text primary key, from_user text not null default '', text text not null default '',
        ticket_id text not null default '', at text not null
      );
    `);
    this.migrate();
  }

  private migrate(): void {
    const columns = new Set(
      (this.db.prepare("pragma table_info(tickets)").all() as { name: string }[]).map((row) => row.name),
    );
    if (!columns.has("pending_notice")) {
      this.db.exec("alter table tickets add column pending_notice text not null default ''");
    }
    if (!columns.has("notified_at")) {
      this.db.exec("alter table tickets add column notified_at text not null default ''");
    }
    if (!columns.has("last_user_reply")) {
      this.db.exec("alter table tickets add column last_user_reply text not null default ''");
    }
    if (!columns.has("result")) {
      this.db.exec("alter table tickets add column result text not null default ''");
    }
    if (!columns.has("pr_url")) {
      this.db.exec("alter table tickets add column pr_url text not null default ''");
    }
    if (!columns.has("source_agent_id")) {
      this.db.exec("alter table tickets add column source_agent_id text not null default ''");
    }
    if (!columns.has("conversation_id")) {
      this.db.exec("alter table tickets add column conversation_id text not null default ''");
    }
    const conversationColumns = new Set(
      (this.db.prepare("pragma table_info(conversations)").all() as { name: string }[]).map(
        (row) => row.name,
      ),
    );
    if (!conversationColumns.has("judge_agent_id")) {
      this.db.exec("alter table conversations add column judge_agent_id text not null default ''");
    }
    this.backfillConversations();
  }

  private backfillConversations(): void {
    const rows = this.db
      .prepare("select id, source_id, subject, source_agent_id, title, state from tickets where conversation_id = ''")
      .all() as Record<string, unknown>[];
    for (const row of rows) {
      const id = asString(row.id);
      const sourceId = asString(row.source_id);
      const subject = asString(row.subject);
      const sourceAgentId = asString(row.source_agent_id);
      const externalKey =
        sourceId === "paseo" && subject.startsWith("paseo-agent-")
          ? subject.slice("paseo-agent-".length)
          : subject;
      const conversation = this.getOrCreateConversation({
        sourceId,
        externalKey,
        title: asString(row.title),
        ownerAgentId: sourceAgentId,
      });
      this.db.prepare("update tickets set conversation_id = ? where id = ?").run(conversation.id, id);
      const state = asString(row.state);
      if (!["done", "failed", "ignored"].includes(state)) {
        this.db
          .prepare("update conversations set active_ticket_id = ? where id = ? and active_ticket_id = ''")
          .run(id, conversation.id);
      }
    }
    this.db.exec(`
      update conversations
      set executor_agent_id = coalesce(
        (select agent_id from tickets
         where tickets.conversation_id = conversations.id and agent_id != ''
         order by updated_at desc limit 1),
        ''
      )
      where executor_agent_id = ''
    `);
  }

  close(): void {
    this.db.close();
  }

  kvGet<T>(key: string, fallback: T): T {
    const row = this.db.prepare("select value from kv where key = ?").get(key) as { value: string } | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  kvSet(key: string, value: unknown): void {
    this.db
      .prepare("insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value")
      .run(key, JSON.stringify(value));
  }

  settings(): Settings {
    const saved = this.kvGet<Partial<Settings>>("settings", {});
    return normalizeSettings({ ...DEFAULT_SETTINGS, ...saved });
  }

  saveSettings(patch: Partial<Settings>): Settings {
    const cleanPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as Partial<Settings>;
    const next = normalizeSettings({ ...this.settings(), ...cleanPatch });
    this.kvSet("settings", next);
    return next;
  }

  paused(): boolean {
    return this.kvGet<boolean>("paused", false);
  }

  setPaused(paused: boolean): void {
    this.kvSet("paused", paused);
  }

  uiState(): UiState {
    return this.kvGet<UiState>("ui.state", { sidebarOpen: true, sidebarWidth: 0 });
  }

  saveUiState(state: UiState): void {
    this.kvSet("ui.state", {
      sidebarOpen: Boolean(state.sidebarOpen),
      sidebarWidth: Math.max(0, Math.min(2000, Number(state.sidebarWidth) || 0)),
    });
  }

  listSources(): SourceRow[] {
    const rows = this.db.prepare("select * from sources order by id").all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: asString(row.id),
      name: asString(row.name),
      scriptPath: asString(row.script_path),
      scriptSha: asString(row.script_sha),
      approvedSha: asString(row.approved_sha),
      intervalSec: Number(row.interval_sec ?? 300),
      enabled: asBool(row.enabled),
      lastRunAt: asString(row.last_run_at),
      lastOkAt: asString(row.last_ok_at),
      failCount: Number(row.fail_count ?? 0),
      lastError: asString(row.last_error),
    }));
  }

  getSource(id: string): SourceRow | null {
    const row = this.db.prepare("select * from sources where id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.listSources().find((source) => source.id === id) ?? null;
  }

  upsertSource(input: { id: string; name: string; intervalSec: number; scriptPath: string; scriptSha: string }): void {
    this.db
      .prepare(
        `insert into sources(id, name, script_path, script_sha, interval_sec)
         values(?, ?, ?, ?, ?)
         on conflict(id) do update set name = excluded.name, script_path = excluded.script_path,
           script_sha = excluded.script_sha, interval_sec = excluded.interval_sec, enabled = 1`,
      )
      .run(input.id, input.name, input.scriptPath, input.scriptSha, input.intervalSec);
  }

  upsertBuiltinSource(input: { id: string; name: string }): void {
    this.db
      .prepare(
        `insert into sources(id, name, script_path, script_sha, approved_sha, interval_sec)
         values(?, ?, '', 'builtin', 'builtin', 0)
         on conflict(id) do nothing`,
      )
      .run(input.id, input.name);
  }

  approveSource(id: string, sha: string): void {
    this.db.prepare("update sources set approved_sha = ? where id = ?").run(sha, id);
  }

  setSourceEnabled(id: string, enabled: boolean): void {
    this.db.prepare("update sources set enabled = ? where id = ?").run(enabled ? 1 : 0, id);
  }

  deleteSource(id: string): void {
    this.db.prepare("delete from sources where id = ?").run(id);
  }

  markSourceRun(id: string, ok: boolean, error: string): void {
    const at = nowIso();
    if (ok) {
      this.db
        .prepare("update sources set last_run_at = ?, last_ok_at = ?, fail_count = 0, last_error = '' where id = ?")
        .run(at, at, id);
    } else {
      this.db
        .prepare("update sources set last_run_at = ?, fail_count = fail_count + 1, last_error = ? where id = ?")
        .run(at, error.slice(0, 2000), id);
    }
  }

  getOrCreateConversation(input: {
    sourceId: string;
    externalKey: string;
    title?: string;
    ownerAgentId?: string;
  }): ConversationRow {
    const sourceId = input.sourceId.trim();
    const externalKey = input.externalKey.trim() || "default";
    const existing = this.db
      .prepare("select * from conversations where source_id = ? and external_key = ?")
      .get(sourceId, externalKey) as Record<string, unknown> | undefined;
    if (existing) {
      const id = asString(existing.id);
      if (input.title && !asString(existing.title)) {
        this.db.prepare("update conversations set title = ?, updated_at = ? where id = ?").run(input.title, nowIso(), id);
      }
      if (input.ownerAgentId && !asString(existing.owner_agent_id)) {
        this.db
          .prepare("update conversations set owner_agent_id = ?, updated_at = ? where id = ?")
          .run(input.ownerAgentId, nowIso(), id);
      }
      return this.getConversation(id)!;
    }
    const id = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const at = nowIso();
    this.db
      .prepare(
        `insert into conversations(id, source_id, external_key, title, owner_agent_id, last_activity_at, created_at, updated_at)
         values(?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sourceId, externalKey, input.title ?? "", input.ownerAgentId ?? "", at, at, at);
    return this.getConversation(id)!;
  }

  getConversation(id: string): ConversationRow | null {
    const row = this.db.prepare("select * from conversations where id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toConversation(row) : null;
  }

  findConversation(id: string): ConversationRow | null {
    return this.getConversation(id);
  }

  findConversationByKey(sourceId: string, externalKey: string): ConversationRow | null {
    const row = this.db
      .prepare("select * from conversations where source_id = ? and external_key = ?")
      .get(sourceId, externalKey) as Record<string, unknown> | undefined;
    return row ? toConversation(row) : null;
  }

  getActiveTicketForConversation(conversationId: string): TicketRow | null {
    const row = this.db
      .prepare(
        "select * from tickets where conversation_id = ? and state not in ('done','failed','ignored') order by updated_at desc, rowid desc limit 1",
      )
      .get(conversationId) as Record<string, unknown> | undefined;
    return row ? toTicket(row) : null;
  }

  findLatestTicketForConversation(conversationId: string): TicketRow | null {
    const row = this.db
      .prepare("select * from tickets where conversation_id = ? order by created_at desc, rowid desc limit 1")
      .get(conversationId) as Record<string, unknown> | undefined;
    return row ? toTicket(row) : null;
  }

  setConversationActiveTicket(conversationId: string, ticketId: string): void {
    this.db
      .prepare("update conversations set active_ticket_id = ?, last_activity_at = ?, updated_at = ? where id = ?")
      .run(ticketId, nowIso(), nowIso(), conversationId);
  }

  setConversationExecutor(conversationId: string, agentId: string): void {
    this.db
      .prepare("update conversations set executor_agent_id = ?, updated_at = ? where id = ?")
      .run(agentId, nowIso(), conversationId);
  }

  setConversationJudge(conversationId: string, agentId: string): void {
    this.db
      .prepare("update conversations set judge_agent_id = ?, updated_at = ? where id = ?")
      .run(agentId, nowIso(), conversationId);
  }

  findConversationByJudgeAgent(agentId: string): ConversationRow | null {
    const row = this.db
      .prepare("select * from conversations where judge_agent_id = ? limit 1")
      .get(agentId) as Record<string, unknown> | undefined;
    return row ? toConversation(row) : null;
  }

  listConversations(limit = 200): ConversationRow[] {
    const rows = this.db
      .prepare("select * from conversations order by last_activity_at desc limit ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map(toConversation);
  }

  clearConversationJudge(conversationId: string): void {
    this.db
      .prepare("update conversations set judge_agent_id = '', updated_at = ? where id = ?")
      .run(nowIso(), conversationId);
  }

  clearAllConversationJudges(): void {
    this.db
      .prepare("update conversations set judge_agent_id = '', updated_at = ? where judge_agent_id != ''")
      .run(nowIso());
  }

  touchConversation(conversationId: string, title?: string): void {
    if (title) {
      this.db
        .prepare("update conversations set title = ?, last_activity_at = ?, updated_at = ? where id = ?")
        .run(title, nowIso(), nowIso(), conversationId);
      return;
    }
    this.db
      .prepare("update conversations set last_activity_at = ?, updated_at = ? where id = ?")
      .run(nowIso(), nowIso(), conversationId);
  }

  insertItem(sourceId: string, itemId: string, subject: string, content: string, meta: unknown): boolean {
    const result = this.db
      .prepare(
        `insert into items(source_id, item_id, subject, content, meta, seen_at)
         values(?, ?, ?, ?, ?, ?) on conflict(source_id, item_id) do nothing`,
      )
      .run(sourceId, itemId, subject, content, JSON.stringify(meta ?? {}), nowIso()) as { changes: number };
    return Number(result.changes) > 0;
  }

  attachItem(sourceId: string, itemId: string, ticketId: string): void {
    this.db
      .prepare("update items set ticket_id = ? where source_id = ? and item_id = ?")
      .run(ticketId, sourceId, itemId);
  }

  listTicketItems(ticketId: string, limit = 20): Array<{
    itemId: string;
    sourceId: string;
    content: string;
    seenAt: string;
  }> {
    const rows = this.db
      .prepare(
        "select item_id, source_id, content, seen_at from items where ticket_id = ? order by seen_at limit ?",
      )
      .all(ticketId, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      itemId: asString(row.item_id),
      sourceId: asString(row.source_id),
      content: asString(row.content),
      seenAt: asString(row.seen_at),
    }));
  }

  findLiveTicket(subject: string): TicketRow | null {
    const row = this.db
      .prepare("select * from tickets where subject = ? and state not in ('done','failed','ignored') limit 1")
      .get(subject) as Record<string, unknown> | undefined;
    return row ? toTicket(row) : null;
  }

  findLatestTicketForSubject(subject: string): TicketRow | null {
    const row = this.db
      .prepare("select * from tickets where subject = ? order by created_at desc, rowid desc limit 1")
      .get(subject) as Record<string, unknown> | undefined;
    return row ? toTicket(row) : null;
  }

  createTicket(input: {
    subject: string;
    sourceId: string;
    title: string;
    state?: TicketState;
    sourceAgentId?: string;
    conversationId?: string;
  }): TicketRow {
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const at = nowIso();
    const qNo = this.nextQNo();
    this.db
      .prepare(
        `insert into tickets(id, subject, source_id, conversation_id, state, title, q_no, source_agent_id, pending_notice, created_at, updated_at)
         values(?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
      )
      .run(
        id,
        input.subject,
        input.sourceId,
        input.conversationId ?? "",
        input.state ?? "pending",
        input.title,
        qNo,
        input.sourceAgentId ?? "",
        at,
        at,
      );
    if (input.conversationId) {
      this.setConversationActiveTicket(input.conversationId, id);
    }
    return this.getTicket(id)!;
  }

  getTicket(id: string): TicketRow | null {
    const row = this.db.prepare("select * from tickets where id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toTicket(row) : null;
  }

  findAnyTicketByQNo(qNo: number): TicketRow | null {
    const row = this.db
      .prepare("select * from tickets where q_no = ? order by created_at desc limit 1")
      .get(qNo) as Record<string, unknown> | undefined;
    return row ? toTicket(row) : null;
  }

  waitingTickets(): TicketRow[] {
    const rows = this.db
      .prepare("select * from tickets where state = 'waiting_human' order by updated_at desc")
      .all() as Record<string, unknown>[];
    return rows.map(toTicket);
  }

  waitingTicketsForSubject(subject: string): TicketRow[] {
    const rows = this.db
      .prepare("select * from tickets where state = 'waiting_human' and subject = ? order by updated_at desc")
      .all(subject) as Record<string, unknown>[];
    return rows.map(toTicket);
  }

  waitingTicketsForConversation(conversationId: string): TicketRow[] {
    const rows = this.db
      .prepare(
        "select * from tickets where state = 'waiting_human' and conversation_id = ? order by updated_at desc",
      )
      .all(conversationId) as Record<string, unknown>[];
    return rows.map(toTicket);
  }

  waitingTicketsForOwnerAgent(agentId: string): TicketRow[] {
    if (!agentId) return [];
    const rows = this.db
      .prepare(
        `select * from tickets
         where state = 'waiting_human'
           and (source_agent_id = ?
             or conversation_id in (select id from conversations where owner_agent_id = ?))
         order by updated_at desc`,
      )
      .all(agentId, agentId) as Record<string, unknown>[];
    return rows.map(toTicket);
  }

  supersedeWaitingTickets(conversationId: string, exceptTicketId: string): void {
    if (!conversationId) return;
    this.db
      .prepare(
        `update tickets set state = 'ignored',
           evidence = case when evidence = '' then ? else evidence || '\n\n' || ? end,
           updated_at = ?
         where conversation_id = ? and state = 'waiting_human' and id != ?`,
      )
      .run(
        "被同会话更新的待决策取代",
        "被同会话更新的待决策取代",
        nowIso(),
        conversationId,
        exceptTicketId,
      );
  }

  ackWaitingTickets(reason: string, beforeIso?: string): number {
    const at = nowIso();
    const result = beforeIso
      ? this.db
          .prepare(
            `update tickets set state = 'ignored',
               evidence = case when evidence = '' then ? else evidence || '\n\n' || ? end,
               updated_at = ?
             where state = 'waiting_human' and updated_at <= ?`,
          )
          .run(reason, reason, at, beforeIso)
      : this.db
          .prepare(
            `update tickets set state = 'ignored',
               evidence = case when evidence = '' then ? else evidence || '\n\n' || ? end,
               updated_at = ?
             where state = 'waiting_human'`,
          )
          .run(reason, reason, at);
    return Number(result.changes);
  }

  ackWaitingTicketsForSubject(subject: string, reason: string, beforeIso?: string): number {
    const at = nowIso();
    const result = beforeIso
      ? this.db
          .prepare(
            `update tickets set state = 'ignored',
               evidence = case when evidence = '' then ? else evidence || '\n\n' || ? end,
               updated_at = ?
             where state = 'waiting_human' and subject = ? and updated_at <= ?`,
          )
          .run(reason, reason, at, subject, beforeIso)
      : this.db
          .prepare(
            `update tickets set state = 'ignored',
               evidence = case when evidence = '' then ? else evidence || '\n\n' || ? end,
               updated_at = ?
             where state = 'waiting_human' and subject = ?`,
          )
          .run(reason, reason, at, subject);
    return Number(result.changes);
  }

  ackWaitingTicketsForConversation(
    conversationId: string,
    reason: string,
    beforeIso?: string,
  ): number {
    const at = nowIso();
    const result = beforeIso
      ? this.db
          .prepare(
            `update tickets set state = 'ignored',
               evidence = case when evidence = '' then ? else evidence || '\n\n' || ? end,
               updated_at = ?
             where state = 'waiting_human' and conversation_id = ? and updated_at <= ?`,
          )
          .run(reason, reason, at, conversationId, beforeIso)
      : this.db
          .prepare(
            `update tickets set state = 'ignored',
               evidence = case when evidence = '' then ? else evidence || '\n\n' || ? end,
               updated_at = ?
             where state = 'waiting_human' and conversation_id = ?`,
          )
          .run(reason, reason, at, conversationId);
    return Number(result.changes);
  }

  ackWaitingTicketsForOwnerAgent(agentId: string, reason: string): number {
    if (!agentId) return 0;
    const at = nowIso();
    const result = this.db
      .prepare(
        `update tickets set state = 'ignored',
           evidence = case when evidence = '' then ? else evidence || '\n\n' || ? end,
           updated_at = ?
         where state = 'waiting_human'
           and (source_agent_id = ?
             or conversation_id in (select id from conversations where owner_agent_id = ?))`,
      )
      .run(reason, reason, at, agentId, agentId);
    return Number(result.changes);
  }

  listTickets(limit = 100): TicketRow[] {
    const rows = this.db
      .prepare("select * from tickets order by updated_at desc limit ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map(toTicket);
  }

  listMessageFeed(limit = 80): MessageRow[] {
    const rows = this.db
      .prepare(
        `select i.source_id, i.item_id, i.content, i.seen_at, i.ticket_id,
                t.q_no, t.state as ticket_state, t.title as ticket_title, t.conversation_id
         from items i
         left join tickets t on t.id = i.ticket_id
         order by i.seen_at desc
         limit ?`,
      )
      .all(Math.max(1, Math.min(200, limit))) as Record<string, unknown>[];
    return rows.map((row) => ({
      sourceId: asString(row.source_id),
      itemId: asString(row.item_id),
      content: asString(row.content),
      seenAt: asString(row.seen_at),
      ticketId: asString(row.ticket_id),
      qNo: Number(row.q_no ?? 0),
      ticketState: asString(row.ticket_state),
      ticketTitle: asString(row.ticket_title),
      conversationId: asString(row.conversation_id),
    }));
  }

  executingTickets(): TicketRow[] {
    const rows = this.db
      .prepare("select * from tickets where state = 'executing'")
      .all() as Record<string, unknown>[];
    return rows.map(toTicket);
  }

  hasTicketForAgent(agentId: string): boolean {
    if (!agentId) return false;
    const row = this.db.prepare("select 1 as hit from tickets where agent_id = ? limit 1").get(agentId) as
      | { hit: number }
      | undefined;
    return Boolean(row);
  }

  pendingNoticeTickets(limit = 20): TicketRow[] {
    const rows = this.db
      .prepare(
        "select * from tickets where pending_notice != '' and state != 'ignored' order by created_at limit ?",
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map(toTicket);
  }

  appendPendingNotice(ticketId: string, notice: string): void {
    if (!notice.trim()) return;
    this.db
      .prepare(
        `update tickets set pending_notice = case when pending_notice = '' then ? else pending_notice || '\n\n' || ? end,
           notified_at = '', updated_at = ? where id = ?`,
      )
      .run(notice, notice, nowIso(), ticketId);
  }

  clearPendingNotice(ticketId: string, expectedNotice?: string): void {
    if (expectedNotice === undefined) {
      this.db
        .prepare("update tickets set pending_notice = '', notified_at = ? where id = ?")
        .run(nowIso(), ticketId);
      return;
    }
    this.db
      .prepare("update tickets set pending_notice = '', notified_at = ? where id = ? and pending_notice = ?")
      .run(nowIso(), ticketId, expectedNotice);
  }

  setUserReply(ticketId: string, text: string): void {
    this.db
      .prepare("update tickets set last_user_reply = ?, updated_at = ? where id = ?")
      .run(text.slice(0, 4000), nowIso(), ticketId);
  }

  updateTicket(id: string, patch: Partial<Pick<TicketRow, "state" | "title" | "question" | "plan" | "risk" | "evidence" | "result" | "prUrl" | "qNo" | "agentId" | "workspaceId" | "pushedAt">>): void {
    const columns: string[] = [];
    const values: (string | number | null)[] = [];
    const mapping: Record<string, string> = {
      state: "state",
      title: "title",
      question: "question",
      plan: "plan",
      risk: "risk",
      evidence: "evidence",
      result: "result",
      prUrl: "pr_url",
      qNo: "q_no",
      agentId: "agent_id",
      workspaceId: "workspace_id",
      pushedAt: "pushed_at",
    };
    for (const [key, column] of Object.entries(mapping)) {
      const value = (patch as Record<string, string | number | null | undefined>)[key];
      if (value !== undefined) {
        columns.push(`${column} = ?`);
        values.push(value);
      }
    }
    columns.push("updated_at = ?");
    const at = nowIso();
    values.push(at);
    values.push(id);
    this.db.prepare(`update tickets set ${columns.join(", ")} where id = ?`).run(...values);
    if (patch.state) {
      if (["done", "failed", "ignored"].includes(patch.state)) {
        this.db.prepare("update conversations set active_ticket_id = '' where active_ticket_id = ?").run(id);
      } else {
        const row = this.db.prepare("select conversation_id from tickets where id = ?").get(id) as
          | { conversation_id: string }
          | undefined;
        if (row?.conversation_id) {
          this.db
            .prepare(
              "update conversations set active_ticket_id = ?, last_activity_at = ?, updated_at = ? where id = ? and active_ticket_id = ''",
            )
            .run(id, at, at, row.conversation_id);
        }
      }
    }
  }

  nextQNo(): number {
    const next = this.kvGet<number>("q_no", 100) + 1;
    this.kvSet("q_no", next);
    return next;
  }

  enqueueEffect(ticketId: string, kind: string, idemKey: string, payload: unknown): void {
    const id = `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare(
        `insert into effects(id, ticket_id, kind, idem_key, payload, next_at) values(?, ?, ?, ?, ?, ?)
         on conflict(idem_key) do nothing`,
      )
      .run(id, ticketId, kind, idemKey, JSON.stringify(payload ?? {}), nowIso());
  }

  dueEffects(limit = 10): EffectRow[] {
    const rows = this.db
      .prepare("select * from effects where status = 'pending' and next_at <= ? order by next_at limit ?")
      .all(nowIso(), limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: asString(row.id),
      ticketId: asString(row.ticket_id),
      kind: asString(row.kind),
      idemKey: asString(row.idem_key),
      payload: asString(row.payload),
      status: asString(row.status),
      attempts: Number(row.attempts ?? 0),
      nextAt: asString(row.next_at),
      lastError: asString(row.last_error),
    }));
  }

  completeEffect(id: string): void {
    this.db.prepare("update effects set status = 'done' where id = ?").run(id);
  }

  retryEffect(id: string, error: string): boolean {
    const row = this.db.prepare("select attempts from effects where id = ?").get(id) as { attempts: number } | undefined;
    const attempts = Number(row?.attempts ?? 0) + 1;
    if (attempts >= 3) {
      this.db
        .prepare("update effects set status = 'failed', attempts = ?, last_error = ? where id = ?")
        .run(attempts, error.slice(0, 2000), id);
      return true;
    }
    const delayMs = attempts === 1 ? 5000 : 30000;
    this.db
      .prepare("update effects set attempts = ?, last_error = ?, next_at = ? where id = ?")
      .run(attempts, error.slice(0, 2000), new Date(Date.now() + delayMs).toISOString(), id);
    return false;
  }

  saveInbox(msgid: string, fromUser: string, text: string): boolean {
    const result = this.db
      .prepare("insert into inbox(msgid, from_user, text, at) values(?, ?, ?, ?) on conflict(msgid) do nothing")
      .run(msgid, fromUser, text, nowIso()) as { changes: number };
    return Number(result.changes) > 0;
  }

  countNewItems(): number {
    const lastSeen = this.kvGet<string>("ui.lastSeenAt", "");
    const row = this.db
      .prepare("select count(*) as n from items where seen_at > ?")
      .get(lastSeen) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  markItemsSeen(): void {
    this.kvSet("ui.lastSeenAt", nowIso());
  }
}

function toTicket(row: Record<string, unknown>): TicketRow {
  return {
    id: asString(row.id),
    subject: asString(row.subject),
    sourceId: asString(row.source_id),
    conversationId: asString(row.conversation_id),
    state: asString(row.state) as TicketState,
    title: asString(row.title),
    question: asString(row.question),
    plan: asString(row.plan),
    risk: asString(row.risk) as Risk,
    evidence: asString(row.evidence),
    result: asString(row.result),
    prUrl: asString(row.pr_url),
    qNo: Number(row.q_no ?? 0),
    agentId: asString(row.agent_id),
    sourceAgentId: asString(row.source_agent_id),
    workspaceId: asString(row.workspace_id),
    pushedAt: asString(row.pushed_at),
    pendingNotice: asString(row.pending_notice),
    notifiedAt: asString(row.notified_at),
    lastUserReply: asString(row.last_user_reply),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function toConversation(row: Record<string, unknown>): ConversationRow {
  return {
    id: asString(row.id),
    sourceId: asString(row.source_id),
    externalKey: asString(row.external_key),
    title: asString(row.title),
    ownerAgentId: asString(row.owner_agent_id),
    executorAgentId: asString(row.executor_agent_id),
    judgeAgentId: asString(row.judge_agent_id),
    activeTicketId: asString(row.active_ticket_id),
    lastActivityAt: asString(row.last_activity_at),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

export function toSourceView(source: SourceRow): SourceView {
  return {
    id: source.id,
    name: source.name,
    intervalSec: source.intervalSec,
    enabled: source.enabled,
    approved: source.scriptSha !== "" && source.scriptSha === source.approvedSha,
    scriptSha: source.scriptSha || null,
    lastRunAt: source.lastRunAt || null,
    lastOkAt: source.lastOkAt || null,
    failCount: source.failCount,
    lastError: source.lastError || null,
  };
}

export function toTicketView(ticket: TicketRow): TicketView {
  return {
    id: ticket.id,
    subject: ticket.subject,
    sourceId: ticket.sourceId,
    conversationId: ticket.conversationId,
    state: ticket.state,
    title: ticket.title,
    question: ticket.question,
    plan: ticket.plan,
    risk: ticket.risk,
    evidence: ticket.evidence,
    result: ticket.result,
    prUrl: ticket.prUrl,
    qNo: ticket.qNo,
    agentId: ticket.agentId,
    sourceAgentId: ticket.sourceAgentId,
    workspaceId: ticket.workspaceId,
    lastUserReply: ticket.lastUserReply,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}
