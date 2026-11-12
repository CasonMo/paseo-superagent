import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import { Service } from "../server/service";
import { parseNdjson } from "../server/source-runner";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function testConversationLifecycle(): void {
  const store = new Store(join(tempDir("sa-conv-"), "db.sqlite"));
  const conversation = store.getOrCreateConversation({
    sourceId: "demo-source",
    externalKey: "workitem:1",
    title: "工单 1",
  });
  const first = store.createTicket({
    subject: "demo-source:workitem:1",
    sourceId: "demo-source",
    title: "第一次",
    conversationId: conversation.id,
  });
  assert.equal(store.getActiveTicketForConversation(conversation.id)?.id, first.id);
  store.updateTicket(first.id, { state: "done" });
  assert.equal(store.getActiveTicketForConversation(conversation.id), null);
  const second = store.createTicket({
    subject: "demo-source:workitem:1",
    sourceId: "demo-source",
    title: "第二次",
    conversationId: conversation.id,
  });
  assert.equal(store.getActiveTicketForConversation(conversation.id)?.id, second.id);
  assert.equal(store.findLatestTicketForConversation(conversation.id)?.id, second.id);
  store.setConversationJudge(conversation.id, "judge-test");
  assert.equal(store.findConversationByJudgeAgent("judge-test")?.id, conversation.id);
  store.clearConversationJudge(conversation.id);
  assert.equal(store.findConversationByJudgeAgent("judge-test"), null);
  store.close();
  console.log("ok conversation lifecycle");
}

function testNotifyOnlyGate(): void {
  process.env.SUPERAGENT_HOME = tempDir("sa-notify-");
  const service = new Service() as any;
  const ticket = service.store.createTicket({ subject: "notify", sourceId: "demo", title: "gate" });
  assert.match(service.ticketDispatch(ticket.id, "plan", "").error ?? "", /仅通知模式/);
  service.store.setUserReply(ticket.id, "T-100 处理");
  assert.equal(service.ticketDispatch(ticket.id, "plan", "").ok, true);
  service.store.close();
  console.log("ok notifyOnly gate");
}

function testTicketReply(): void {
  process.env.SUPERAGENT_HOME = tempDir("sa-reply-");
  const service = new Service() as any;
  const conversation = service.store.getOrCreateConversation({
    sourceId: "demo",
    externalKey: "reply-conversation",
    title: "reply",
  });
  const ticket = service.store.createTicket({
    subject: "reply",
    sourceId: "demo",
    title: "reply",
    state: "waiting_human",
    conversationId: conversation.id,
  });
  assert.equal(service.ticketReply(ticket.qNo, "T-101 批准").ok, true);
  assert.equal(service.store.getTicket(ticket.id)?.lastUserReply, "T-101 批准");
  assert.equal(service.store.getTicket(ticket.id)?.state, "ignored");
  service.store.close();
  console.log("ok ticket reply");
}

function testResultFields(): void {
  const store = new Store(join(tempDir("sa-result-"), "db.sqlite"));
  const ticket = store.createTicket({ subject: "result", sourceId: "demo", title: "result" });
  store.updateTicket(ticket.id, {
    state: "done",
    result: "改完了",
    prUrl: "https://github.com/example/repo/pull/1",
  });
  const updated = store.getTicket(ticket.id);
  assert.equal(updated?.result, "改完了");
  assert.equal(updated?.prUrl, "https://github.com/example/repo/pull/1");
  store.close();
  console.log("ok result fields");
}

function testAckOwnerAgent(): void {
  const store = new Store(join(tempDir("sa-ack-"), "db.sqlite"));
  const conversation = store.getOrCreateConversation({
    sourceId: "paseo",
    externalKey: "agent-1",
    title: "Agent 1",
    ownerAgentId: "agent-1",
  });
  const ticket = store.createTicket({
    subject: "paseo-agent-agent-1",
    sourceId: "paseo",
    title: "等待处理",
    state: "waiting_human",
    sourceAgentId: "agent-1",
    conversationId: conversation.id,
  });
  const other = store.createTicket({
    subject: "paseo-agent-agent-2",
    sourceId: "paseo",
    title: "另一个 Agent",
    state: "waiting_human",
    sourceAgentId: "agent-2",
  });
  assert.equal(store.waitingTicketsForOwnerAgent("agent-1").length, 1);
  assert.equal(store.ackWaitingTicketsForOwnerAgent("agent-1", "用户已回复"), 1);
  assert.equal(store.getTicket(ticket.id)?.state, "ignored");
  assert.equal(store.getTicket(other.id)?.state, "waiting_human");
  store.close();
  console.log("ok ack owner agent");
}

function testMessageFeed(): void {
  const store = new Store(join(tempDir("sa-feed-"), "db.sqlite"));
  const ticket = store.createTicket({ subject: "feed", sourceId: "demo", title: "消息流" });
  store.insertItem("demo", "msg-1", "feed", "原始消息内容", {});
  store.attachItem("demo", "msg-1", ticket.id);
  const messages = store.listMessageFeed(10);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.content, "原始消息内容");
  assert.equal(messages[0]?.ticketId, ticket.id);
  assert.equal(messages[0]?.qNo, ticket.qNo);
  store.close();
  console.log("ok message feed");
}

async function testUserTurnSkipsTicket(): Promise<void> {
  process.env.SUPERAGENT_HOME = tempDir("sa-user-turn-");
  const service = new Service() as any;
  const conversation = service.store.getOrCreateConversation({
    sourceId: "paseo",
    externalKey: "agent-user",
    title: "用户自己的 Agent",
    ownerAgentId: "agent-user",
  });
  const ticket = service.store.createTicket({
    subject: "paseo-agent-agent-user",
    sourceId: "paseo",
    title: "用户回复后不应保留",
    state: "waiting_human",
    sourceAgentId: "agent-user",
    conversationId: conversation.id,
  });
  const userPaseo = {
    agents: {
      ref: () => ({
        timeline: {
          refetch: async () => ({
            entries: [
              { item: { type: "assistant_message", text: "旧回复" }, timestamp: "2026-01-01T00:00:00Z" },
              { item: { type: "user_message", text: "我在 Agent 里处理了" }, timestamp: "2026-01-01T00:01:00Z" },
            ],
          }),
        },
      }),
    },
  } as any;
  assert.equal(await service.ackRepliesForAgent({ id: "agent-user" }, userPaseo), true);
  assert.equal(service.consumeUserTurn("agent-user"), true);
  assert.equal(service.store.getTicket(ticket.id)?.state, "ignored");
  const stale = service.store.createTicket({
    subject: "paseo-agent-agent-user-stale",
    sourceId: "paseo",
    title: "旧通知不应该重新拉起待处理",
    state: "pending",
    sourceAgentId: "agent-user",
    conversationId: conversation.id,
  });
  service.ticketWaitHuman(stale.id, "旧通知里的问题");
  assert.equal(service.store.getTicket(stale.id)?.state, "ignored");

  const next = service.store.createTicket({
    subject: "paseo-agent-agent-user",
    sourceId: "paseo",
    title: "后台完成仍要通知",
    state: "waiting_human",
    sourceAgentId: "agent-user",
    conversationId: conversation.id,
  });
  const backgroundPaseo = {
    agents: {
      ref: () => ({
        timeline: {
          refetch: async () => ({
            entries: [{ item: { type: "assistant_message", text: "后台完成" }, timestamp: "2026-01-01T00:02:00Z" }],
          }),
        },
      }),
    },
  } as any;
  assert.equal(await service.ackRepliesForAgent({ id: "agent-user" }, backgroundPaseo), false);
  assert.equal(service.store.getTicket(next.id)?.state, "waiting_human");
  service.store.close();
  console.log("ok user turn skips ticket");
}

function testNdjson(): void {
  const parsed = parseNdjson(
    [
      '{"id":"a","content":"one","meta":{"conversationKey":"issue:1"}}',
      '{"id":"b","content":"two","meta":{}}',
      "not-json",
    ].join("\n"),
  );
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.items[0]?.id, "a");
  console.log("ok ndjson");
}

testConversationLifecycle();
testNotifyOnlyGate();
testTicketReply();
testResultFields();
testAckOwnerAgent();
testMessageFeed();
testNdjson();
void testUserTurnSkipsTicket().then(() => {
  console.log("self-test ok");
});
