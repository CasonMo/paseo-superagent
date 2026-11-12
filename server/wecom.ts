import { WSClient, type WsFrame, type WsFrameHeaders } from "@wecom/aibot-node-sdk";

export interface WecomInbound {
  frame: WsFrame;
  msgid: string;
  fromUser: string;
  chatid: string;
  text: string;
  quote?: string;
}

export class WecomChannel {
  private client: WSClient | null = null;
  private stopped = false;
  private lastError = "";

  start(input: {
    botId: string;
    secret: string;
    onMessage: (message: WecomInbound) => void;
  }): void {
    this.stop();
    this.stopped = false;
    this.lastError = "";
    console.log("[superagent] wecom connecting", { botId: `${input.botId.slice(0, 8)}...` });
    this.client = new WSClient({ botId: input.botId, secret: input.secret });
    this.client.on("connected", () => {
      console.log("[superagent] wecom websocket connected");
    });
    this.client.on("authenticated", () => {
      this.lastError = "";
      console.log("[superagent] wecom authenticated");
    });
    this.client.on("disconnected", (reason) => {
      console.warn("[superagent] wecom disconnected", reason);
    });
    this.client.on("reconnecting", (attempt) => {
      console.log("[superagent] wecom reconnecting", { attempt });
    });
    this.client.on("error", (error) => {
      this.lastError = error.message;
      console.error("[superagent] wecom error", error);
    });
    this.client.on("message.text", (frame: WsFrame) => {
      const body = frame.body as
        | {
            msgid?: string;
            chatid?: string;
            from?: { userid?: string };
            text?: { content?: string };
            quote?: { msgtype?: string; text?: { content?: string }; voice?: { content?: string } };
          }
        | undefined;
      const text = body?.text?.content ?? "";
      const quote =
        body?.quote?.text?.content ??
        body?.quote?.voice?.content ??
        (body?.quote ? `[引用的${body.quote.msgtype ?? "消息"}]` : "");
      if (!text.trim() && !quote.trim()) return;
      const fromUser = body?.from?.userid ?? "";
      const chatid = body?.chatid ?? fromUser;
      const msgid = body?.msgid ?? frame.headers.req_id;
      console.log("[superagent] wecom message", {
        msgid,
        fromUser,
        chatid,
        text: text.slice(0, 80),
        quote: quote.slice(0, 80),
      });
      input.onMessage({
        frame,
        msgid: msgid || `${fromUser}:${Date.now()}`,
        fromUser,
        chatid,
        text,
        quote: quote.trim() || undefined,
      });
    });
    this.client.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.client) {
      try {
        this.client.disconnect();
      } catch {
        // ignore
      }
      this.client = null;
    }
  }

  get connected(): boolean {
    return !this.stopped && !!this.client?.isConnected;
  }

  get error(): string {
    return this.lastError;
  }

  async send(chatid: string, markdown: string): Promise<void> {
    if (!this.client) throw new Error("wecom is not configured");
    try {
      await this.client.sendMessage(chatid, { msgtype: "markdown", markdown: { content: markdown } });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async replyStream(frame: WsFrameHeaders, streamId: string, content: string, finish: boolean): Promise<void> {
    if (!this.client) throw new Error("wecom is not configured");
    try {
      await this.client.replyStream(frame, streamId, content, finish);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

}
