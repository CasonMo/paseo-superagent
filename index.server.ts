import type { PluginServerContext } from "@getpaseo/plugin/server";
import { Service } from "./server/service";
import {
  pauseRpc,
  settingsSaveRpc,
  mainAgentRebuildRpc,
  markSeenRpc,
  messagesListRpc,
  sourceApproveRpc,
  sourceDeleteRpc,
  sourceSaveRpc,
  sourceTestRpc,
  sourceToggleRpc,
  statusRpc,
  ticketsAckRpc,
  ticketDecideRpc,
  ticketReplyRpc,
  ticketRouteRpc,
  uiStateSaveRpc,
  wecomTestRpc,
} from "./shared/superagent";

export default function contribute(server: PluginServerContext) {
  const service = new Service();
  void service.start();
  server.handle(statusRpc, () => service.status());
  server.handle(pauseRpc, ({ paused }) => {
    service.setPaused(paused);
    return { paused };
  });
  server.handle(sourceSaveRpc, (input) => service.saveSource(input));
  server.handle(sourceTestRpc, ({ id }) => service.sourceTest(id));
  server.handle(sourceApproveRpc, ({ id }) => service.sourceApprove(id));
  server.handle(sourceToggleRpc, ({ id, enabled }) => {
    service.sourceToggle(id, enabled);
    return { enabled };
  });
  server.handle(sourceDeleteRpc, ({ id }) => service.sourceDelete(id));
  server.handle(ticketsAckRpc, ({ reason }) => ({
    ok: true,
    count: service.ackWaitingTickets(reason),
  }));
  server.handle(messagesListRpc, ({ limit }) => ({ messages: service.messagesList(limit) }));
  server.handle(ticketReplyRpc, ({ qNo, text }) => service.ticketReply(qNo, text));
  server.handle(ticketRouteRpc, ({ qNo }) => service.ticketRoute(qNo));
  server.addHook("agent.turn.before", async ({ agent }, context) => {
    await service.ackRepliesForAgent(agent, context.paseo);
  });
  server.addHook("agent.turn.after", async ({ agent, outcome }, context) => {
    if (service.consumeUserTurn(agent.id)) {
      service.ackOwnerAgentTickets(agent.id);
    } else {
      await service.ingestTurn(agent, outcome, context.paseo);
    }
    await service.ackRepliesForAgent(agent, context.paseo);
  });
  server.addHook("agent.permission.before", async ({ agent, request }) => {
    service.ingestPaseoEvent("等待权限", agent, JSON.stringify(request).slice(0, 500));
  });
  server.handle(ticketDecideRpc, async ({ id, action, instruction }) => ({
    state: (await service.decide(id, action, instruction)) as "pending" | "waiting_human" | "approved" | "executing" | "done" | "failed" | "ignored",
  }));
  server.handle(settingsSaveRpc, (patch) => {
    service.saveSettings(patch);
    return { ok: true };
  });
  server.handle(mainAgentRebuildRpc, () => service.rebuildMainAgent());
  server.handle(markSeenRpc, () => service.markSeen());
  server.handle(uiStateSaveRpc, (state) => service.saveUiState(state));
  server.handle(wecomTestRpc, () => service.wecomTest());
  return () => {
    void service.stop();
  };
}
