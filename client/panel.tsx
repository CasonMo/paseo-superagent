import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, Markdown, Modal } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { attachResizeHandle } from "./web";
import { SUPERAGENT_LOGO_SVG } from "./logo";
import {
  mainAgentRebuildRpc,
  pauseRpc,
  settingsSaveRpc,
  sourceApproveRpc,
  sourceDeleteRpc,
  sourceTestRpc,
  sourceToggleRpc,
  statusRpc,
  SUPERAGENT_NOTICE_PREFIX,
  ticketDecideRpc,
  ticketReplyRpc,
  uiStateSaveRpc,
  type TicketView,
} from "../shared/superagent";

interface SelectOption {
  value: string;
  label: string;
}

function splitQuotedMessage(text: string): { quote: string; body: string } | null {
  const lines = text.split("\n");
  if (!lines[0]?.startsWith("> ")) return null;
  const quoteLines: string[] = [];
  let index = 0;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("> ")) quoteLines.push(line.slice(2));
    else if (line === ">") quoteLines.push("");
    else break;
  }
  while (index < lines.length && lines[index].trim() === "") index += 1;
  return quoteLines.length ? { quote: quoteLines.join("\n"), body: lines.slice(index).join("\n") } : null;
}

function stripTriageGate(text: string): string {
  if (!text.startsWith("[分诊规则-必须遵守]")) return text;
  const split = text.indexOf("\n\n");
  return split >= 0 ? text.slice(split + 2) : "";
}

function ticketStateLabel(state: string): string {
  if (state === "waiting_human") return "待处理";
  if (state === "pending") return "研判中";
  if (state === "approved") return "已批准";
  if (state === "executing") return "执行中";
  if (state === "done") return "完成";
  if (state === "failed") return "失败";
  if (state === "ignored") return "已忽略";
  return state;
}

function extractAgentId(text: string): string {
  return /^agent:\s*([^\s]+)\s*$/m.exec(text)?.[1] ?? "";
}

function normalizeMarkdown(text: string): string {
  const fences = (text.match(/```/g) ?? []).length;
  if (fences % 2 === 0) return text;
  const marker = "\n请用 superagent_ticket_get";
  const markerIndex = text.indexOf(marker);
  if (markerIndex >= 0) {
    return `${text.slice(0, markerIndex)}\n\`\`\`${text.slice(markerIndex)}`;
  }
  return `${text}\n\`\`\``;
}

function quoteDisplayName(from: "user" | "assistant" | "source"): string {
  if (from === "user") return "我的消息";
  if (from === "assistant") return " Superagent 的回复";
  return "消息源";
}

function SelectField({
  label,
  value,
  placeholder,
  options,
  onChange,
  theme,
}: {
  label: string;
  value: string;
  placeholder: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  theme: PluginScreenProps["theme"];
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 10,
          paddingHorizontal: 10,
          paddingVertical: 9,
          backgroundColor: theme.colors.surface0,
        }}
        onPress={() => setOpen((current) => !current)}
      >
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 13, flex: 1 }}>
          {selected?.label || placeholder}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{open ? "▴" : "▾"}</Text>
      </Pressable>
      {open ? (
        <View
          style={{
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 10,
            overflow: "hidden",
            backgroundColor: theme.colors.surface1,
          }}
        >
          {options.map((option) => (
            <Pressable
              key={option.value}
              style={{ paddingHorizontal: 10, paddingVertical: 8 }}
              onPress={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <Text
                numberOfLines={1}
                style={{
                  color: option.value === value ? theme.colors.accent : theme.colors.foreground,
                  fontSize: 12,
                }}
              >
                {option.label}
              </Text>
            </Pressable>
          ))}
          {options.length === 0 ? (
            <Text style={{ padding: 10, color: theme.colors.foregroundMuted, fontSize: 12 }}>暂无可选项</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function SuperagentScreen({ theme, layout, navigation, params }: PluginScreenProps) {
  const paseo = usePaseo();
  const fetchStatus = useRpc(statusRpc);
  const setPaused = useRpc(pauseRpc);
  const decideTicket = useRpc(ticketDecideRpc);
  const testSource = useRpc(sourceTestRpc);
  const approveSource = useRpc(sourceApproveRpc);
  const toggleSource = useRpc(sourceToggleRpc);
  const deleteSource = useRpc(sourceDeleteRpc);
  const saveSettings = useRpc(settingsSaveRpc);
  const rebuildMain = useRpc(mainAgentRebuildRpc);
  const markTicketReply = useRpc(ticketReplyRpc);
  const saveUiState = useRpc(uiStateSaveRpc);

  const [draft, setDraft] = useState("");
  const [quoted, setQuoted] = useState<{
    text: string;
    from: "user" | "assistant" | "source";
  } | null>(null);
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(0);
  const [uiReady, setUiReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [executorsOpen, setExecutorsOpen] = useState(false);
  const [feedTab, setFeedTab] = useState<"all" | "waiting" | "dispatched" | "ignored">("all");
  const [mobilePane, setMobilePane] = useState<"feed" | "chat">("feed");
  const dragStart = useRef(0);
  const messagesRef = useRef<ScrollView>(null);
  const feedRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);
  const atBottomRef = useRef(true);
  const { width: windowWidth } = useWindowDimensions();
  const closeThreshold = 8;
  const minFeed = 260;
  const maxFeed = Math.max(minFeed, Math.min(windowWidth * 0.68, windowWidth - 340));
  const defaultFeedWidth = Math.max(minFeed, Math.round((windowWidth - 7) / 2));
  const resolvedFeedWidth =
    sidebarWidth > 0 ? Math.min(Math.max(sidebarWidth, minFeed), maxFeed) : defaultFeedWidth;
  const widthRef = useRef(resolvedFeedWidth);
  widthRef.current = resolvedFeedWidth;
  const maxRef = useRef(maxFeed);
  maxRef.current = maxFeed;
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,
        onPanResponderGrant: () => {
          dragStart.current = widthRef.current;
        },
        onPanResponderMove: (_event, gesture) => {
          const raw = dragStart.current + gesture.dx;
          if (raw <= closeThreshold) {
            setSidebarWidth(0);
            setSidebarOpen(false);
            return;
          }
          setSidebarWidth(Math.max(minFeed, Math.min(maxRef.current, raw)));
        },
      }),
    [closeThreshold, minFeed],
  );
  const handleRef = useRef<View>(null);
  useEffect(() => {
    if (!sidebarOpen || layout.compact) return;
    return attachResizeHandle(handleRef.current, {
      onStart: () => {
        dragStart.current = widthRef.current;
      },
      onDelta: (totalDx) => {
        const raw = dragStart.current + totalDx;
        if (raw <= closeThreshold) {
          setSidebarWidth(0);
          setSidebarOpen(false);
          return;
        }
        setSidebarWidth(Math.max(minFeed, Math.min(maxRef.current, raw)));
      },
    });
  }, [sidebarOpen, layout.compact, closeThreshold, minFeed]);

  const status = useQuery({
    queryKey: ["superagent", "status"],
    queryFn: () => fetchStatus({}),
    refetchInterval: 3000,
  });
  const catalog = useQuery({
    queryKey: ["superagent", "providers"],
    queryFn: () => paseo.providers.snapshot(),
    refetchInterval: 60000,
  });
  const providerEntries = (catalog.data?.entries ?? []).filter(
    (entry) => entry.enabled && entry.status === "ready",
  );
  const providerOptions: SelectOption[] = providerEntries.map((entry) => ({
    value: entry.provider,
    label: entry.provider,
  }));
  const modelsFor = (provider: string): SelectOption[] =>
    (providerEntries.find((entry) => entry.provider === provider)?.models ?? [])
      .filter((model) => model.isSelectable !== false)
      .map((model) => ({ value: model.id, label: model.label }));
  const thinkingFor = (provider: string, model: string): SelectOption[] => {
    const entry = providerEntries.find((item) => item.provider === provider);
    const found = entry?.models?.find((item) => item.id === model);
    return [
      { value: "", label: "默认" },
      ...(found?.thinkingOptions ?? []).map((option) => ({ value: option.id, label: option.label })),
    ];
  };
  const defaultModelFor = (provider: string): string => {
    const models = providerEntries.find((entry) => entry.provider === provider)?.models ?? [];
    return (models.find((model) => model.isDefault) ?? models[0])?.id ?? "";
  };
  const defaultThinkingFor = (provider: string, model: string): string => {
    const entry = providerEntries.find((item) => item.provider === provider);
    return entry?.models?.find((item) => item.id === model)?.defaultThinkingOptionId ?? "";
  };

  const mainAgentId = status.data?.settings.mainAgentId ?? "";
  const judgeAgentId = status.data?.settings.judgeAgentId ?? "";
  const chatAgentId = mainAgentId;
  const timeline = useQuery({
    queryKey: ["superagent", "timeline", chatAgentId],
    queryFn: () => paseo.agents.ref(chatAgentId).timeline.refetch({ direction: "tail", limit: 200 }),
    enabled: Boolean(chatAgentId),
    refetchInterval: 2500,
  });
  const judgeTimeline = useQuery({
    queryKey: ["superagent", "judge-timeline", judgeAgentId],
    queryFn: () => paseo.agents.ref(judgeAgentId).timeline.refetch({ direction: "tail", limit: 300 }),
    enabled: Boolean(judgeAgentId),
    refetchInterval: 2500,
  });
  const subagents = useQuery({
    queryKey: ["superagent", "subagents"],
    queryFn: () =>
      paseo.agents.list({
        filter: { labels: { "superagent.role": "executor" }, includeBackground: true },
      }),
    refetchInterval: 5000,
  });

  const refresh = () => {
    void status.refetch();
    void timeline.refetch();
    void judgeTimeline.refetch();
  };
  const [repoPath, setRepoPath] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [mainProvider, setMainProvider] = useState("");
  const [mainModel, setMainModel] = useState("");
  const [mainThinking, setMainThinking] = useState("");
  const [executorProvider, setExecutorProvider] = useState("");
  const [executorModel, setExecutorModel] = useState("");
  const [executorThinking, setExecutorThinking] = useState("");
  const [notifyOnly, setNotifyOnly] = useState(true);
  const [wecomBotId, setWecomBotId] = useState("");
  const [wecomSecret, setWecomSecret] = useState("");
  const settingsInitialized = useRef(false);
  const uiInitialized = useRef(false);

  const sendMessage = useMutation({
    mutationFn: async (input: { text: string; quote: string }) => {
      if (!chatAgentId) throw new Error("Superagent 正在初始化,请稍后");
      const match = /T-?(\d+)/i.exec(`${input.quote}\n${input.text}`);
      if (match) {
        await markTicketReply({ qNo: Number(match[1]), text: input.text }).catch(() => {});
      }
      const header = match ? `[人工回复] T-${Number(match[1])}(面板)\n` : "";
      await paseo.agents.ref(chatAgentId).send(`${input.quote}${header}${input.text}`);
    },
    onSuccess: () => {
      setDraft("");
      setQuoted(null);
      atBottomRef.current = true;
      setTimeout(() => {
        refresh();
        messagesRef.current?.scrollToEnd({ animated: true });
      }, 800);
    },
    onError: (error) => setNotice(String((error as Error).message ?? error)),
  });
  const pauseMutation = useMutation({
    mutationFn: (paused: boolean) => setPaused({ paused }),
    onSuccess: refresh,
  });
  const decideMutation = useMutation({
    mutationFn: (input: { id: string; action: "approve" | "reject" | "stop" }) => decideTicket(input),
    onSuccess: refresh,
  });
  const testMutation = useMutation({
    mutationFn: (id: string) => testSource({ id }),
    onSuccess: (result) => {
      setNotice(result.ok ? `测试通过:${result.lines} 条\n${result.preview.join("\n")}` : `测试失败:${result.error}`);
      refresh();
    },
  });
  const approveMutation = useMutation({
    mutationFn: (id: string) => approveSource({ id }),
    onSuccess: refresh,
  });
  const toggleMutation = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) => toggleSource(input),
    onSuccess: refresh,
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteSource({ id }),
    onSuccess: refresh,
  });
  const settingsMutation = useMutation({
    mutationFn: () =>
      saveSettings({
        repoPath,
        baseBranch,
        mainProvider,
        mainModel,
        mainThinking,
        executorProvider,
        executorModel,
        executorThinking,
        notifyOnly,
        wecomBotId,
        wecomSecret: wecomSecret || undefined,
      }),
    onSuccess: () => {
      setNotice("设置已保存");
      refresh();
    },
  });
  const rebuildMutation = useMutation({
    mutationFn: () => rebuildMain({}),
    onSuccess: () => {
      setNotice("主 agent 已重建,新模型已生效");
      refresh();
    },
  });

  useEffect(() => {
    const settings = status.data?.settings;
    if (!settings || settingsInitialized.current) return;
    settingsInitialized.current = true;
    setRepoPath(settings.repoPath);
    setBaseBranch(settings.baseBranch);
    setMainProvider(settings.mainProvider);
    setMainModel(settings.mainModel);
    setMainThinking(settings.mainThinking);
    setExecutorProvider(settings.executorProvider);
    setExecutorModel(settings.executorModel);
    setExecutorThinking(settings.executorThinking);
    setNotifyOnly(settings.notifyOnly);
    setWecomBotId(settings.wecomBotId);
  }, [status.data]);

  useEffect(() => {
    if (!status.data || uiInitialized.current) return;
    uiInitialized.current = true;
    setSidebarOpen(status.data.ui.sidebarOpen);
    setSidebarWidth(status.data.ui.sidebarWidth === 320 ? 0 : status.data.ui.sidebarWidth);
    setUiReady(true);
  }, [status.data]);

  useEffect(() => {
    if (!uiInitialized.current) return;
    const timer = setTimeout(() => {
      void saveUiState({ sidebarOpen, sidebarWidth }).catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [sidebarOpen, sidebarWidth]);

  const styles = useMemo(() => {
    const pad = layout.compact ? 12 : 18;
    return {
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      row: { flex: 1, flexDirection: layout.compact ? ("column" as const) : ("row" as const) },
      mobileSwitch: {
        flexDirection: "row" as const,
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      },
      mobileSwitchButton: {
        flex: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        paddingVertical: 8,
        borderRadius: 8,
      },
      mobileSwitchButtonActive: { backgroundColor: theme.colors.surface2 },
      mobileSwitchText: { color: theme.colors.foregroundMuted, fontSize: 12 },
      mobileSwitchTextActive: {
        color: theme.colors.accent,
        fontSize: 12,
        fontWeight: "600" as const,
      },
      chat: { flex: 1, minWidth: 0 },
      feed: {
        minWidth: 0,
        minHeight: 0,
        borderRightWidth: layout.compact ? 0 : 1,
        borderBottomWidth: layout.compact ? 1 : 0,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      },
      feedHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
        paddingHorizontal: 12,
        paddingTop: layout.compact ? 10 : 16,
        paddingBottom: 10,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
      },
      feedTitleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 7 },
      feedTabs: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 3,
        paddingHorizontal: 8,
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
      },
      feedTab: { paddingHorizontal: 7, paddingVertical: 4, borderRadius: 7 },
      feedTabActive: { backgroundColor: theme.colors.surface2 },
      feedTabText: { color: theme.colors.foregroundMuted, fontSize: 10 },
      feedTabTextActive: {
        color: theme.colors.accent,
        fontSize: 10,
        fontWeight: "600" as const,
      },
      feedEmpty: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        lineHeight: 18,
        padding: 12,
      },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        flexWrap: "wrap" as const,
        rowGap: 8,
        gap: 12,
        paddingHorizontal: pad,
        paddingTop: layout.compact ? 10 : 16,
        paddingBottom: 10,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
      },
      brandRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 10,
        flex: 1,
        minWidth: 170,
      },
      brandMark: {
        width: 34,
        height: 34,
        borderRadius: 10,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: "transparent",
        flexShrink: 0,
      },
      brandMarkText: { color: theme.colors.accentForeground, fontSize: 16, fontWeight: "700" as const },
      title: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 17 : 19,
        fontWeight: "600" as const,
        flexShrink: 1,
      },
      subtitleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 5, marginTop: 1 },
      dot: { width: 7, height: 7, borderRadius: 4, flexShrink: 0 },
      subtitle: { color: theme.colors.foregroundMuted, fontSize: 11, flexShrink: 1 },
      headerActions: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        flexWrap: "wrap" as const,
        justifyContent: "flex-end" as const,
        gap: 6,
        marginLeft: "auto" as const,
      },
      messages: { flex: 1 },
      messagesContent: { padding: pad, gap: 10 },
      thread: { gap: 6, marginBottom: 6 },
      threadMetaRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        flexWrap: "wrap" as const,
        gap: 7,
        paddingHorizontal: 4,
      },
      threadMetaText: { color: theme.colors.foregroundMuted, fontSize: 10 },
      threadAgentLink: { color: theme.colors.accent, fontSize: 10, fontWeight: "600" as const },
      dispatchRecord: {
        borderWidth: 1,
        borderStyle: "dashed" as const,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: 10,
        gap: 4,
        backgroundColor: theme.colors.surface0,
      },
      dispatchRecordLabel: {
        color: theme.colors.foregroundMuted,
        fontSize: 9,
        fontWeight: "600" as const,
        letterSpacing: 0.4,
      },
      threadReplies: {
        marginLeft: 34,
        paddingLeft: 10,
        borderLeftWidth: 2,
        borderLeftColor: theme.colors.border,
        gap: 8,
        marginTop: 2,
      },
      threadReplyLabel: { color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "600" as const },
      messageRow: { flexDirection: "row" as const, gap: 8, alignItems: "flex-start" as const },
      messageRowUser: { justifyContent: "flex-end" as const },
      avatar: {
        width: 26,
        height: 26,
        borderRadius: 9,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
        marginTop: 6,
      },
      avatarStatus: {
        position: "absolute" as const,
        right: -1,
        bottom: -1,
        width: 7,
        height: 7,
        borderRadius: 4,
        borderWidth: 1.5,
        borderColor: theme.colors.surface0,
      },
      bubbleStack: { maxWidth: "82%" as const, alignItems: "flex-end" as const, gap: 3 },
      bubble: { maxWidth: "100%" as const, paddingHorizontal: 12, paddingVertical: 9 },
      messageActions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      quoteAction: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
      quoteActionText: { color: theme.colors.foregroundMuted, fontSize: 10 },
      expandText: { color: theme.colors.accent, fontSize: 11, fontWeight: "600" as const },
      expandTextUser: {
        color: theme.colors.accentForeground,
        fontSize: 11,
        fontWeight: "600" as const,
        opacity: 0.9,
      },
      collapseRow: { flexDirection: "row" as const, justifyContent: "flex-end" as const, marginTop: 4 },
      bubbleUser: { backgroundColor: theme.colors.accent, borderRadius: 14, borderBottomRightRadius: 4 },
      bubbleAgent: {
        backgroundColor: theme.colors.surface1,
        borderRadius: 14,
        borderBottomLeftRadius: 4,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      bubbleUserText: { color: theme.colors.accentForeground, fontSize: 14, lineHeight: 20 },
      bubbleQuote: {
        borderLeftWidth: 3,
        borderLeftColor: theme.colors.accentForeground,
        backgroundColor: "rgba(0,0,0,0.12)",
        borderRadius: 6,
        padding: 6,
        marginBottom: 6,
        gap: 2,
      },
      bubbleQuoteLabel: {
        color: theme.colors.accentForeground,
        fontSize: 9,
        fontWeight: "600" as const,
        opacity: 0.75,
      },
      bubbleQuoteText: {
        color: theme.colors.accentForeground,
        fontSize: 11,
        lineHeight: 15,
        opacity: 0.9,
      },
      empty: { alignItems: "center" as const, justifyContent: "center" as const, gap: 10, paddingVertical: 48 },
      emptyMark: {
        width: 44,
        height: 44,
        borderRadius: 14,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: theme.colors.surface2,
      },
      emptyMarkText: { color: theme.colors.foregroundMuted, fontSize: 18, fontWeight: "700" as const },
      emptyTitle: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      emptyHint: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        lineHeight: 18,
        textAlign: "center" as const,
        maxWidth: 360,
      },
      quoteBar: {
        flexDirection: "row" as const,
        alignItems: "flex-start" as const,
        gap: 8,
        marginHorizontal: pad,
        marginTop: 8,
        padding: 8,
        borderRadius: 10,
        borderLeftWidth: 3,
        borderLeftColor: theme.colors.accent,
        backgroundColor: theme.colors.surface1,
      },
      quoteLabel: { color: theme.colors.accent, fontSize: 10, fontWeight: "600" as const },
      quoteText: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 },
      composer: {
        flexDirection: "row" as const,
        gap: 8,
        alignItems: "flex-end" as const,
        paddingHorizontal: pad,
        paddingBottom: pad,
        paddingTop: 8,
      },
      composerInput: {
        flex: 1,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 14,
        lineHeight: 20,
        minHeight: 42,
        maxHeight: 140,
      },
      sendButton: {
        paddingHorizontal: 16,
        paddingVertical: 11,
        borderRadius: 12,
        backgroundColor: theme.colors.accent,
      },
      sendButtonDisabled: { opacity: 0.45 },
      sendButtonText: { color: theme.colors.accentForeground, fontSize: 13, fontWeight: "600" as const },
      notice: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        lineHeight: 16,
        paddingHorizontal: pad,
        paddingBottom: 8,
      },
      subagentsBar: {
        borderTopWidth: 1,
        borderColor: theme.colors.border,
        paddingHorizontal: pad,
        paddingTop: 8,
        paddingBottom: 4,
        gap: 6,
      },
      subagentsHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
      },
      subagentChip: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 5,
        paddingHorizontal: 8,
        paddingVertical: 5,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        maxWidth: 180,
      },
      subagentText: { color: theme.colors.foreground, fontSize: 11 },
      sidebar: {
        borderLeftWidth: layout.compact ? 0 : 1,
        borderTopWidth: layout.compact ? 1 : 0,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      },
      pendingDrawer: {
        width: 200,
        borderLeftWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      },
      pendingQuestion: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        lineHeight: 15,
      },
      sidebarContent: { padding: pad, gap: 10, paddingBottom: 24 },
      sidebarHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
      },
      sidebarTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      actionsRow: { flexDirection: "row" as const, gap: 6, flexWrap: "wrap" as const },
      sectionRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        marginTop: 6,
      },
      sectionTitle: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" as const, letterSpacing: 0.4 },
      countChip: {
        minWidth: 18,
        height: 18,
        borderRadius: 9,
        paddingHorizontal: 5,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: theme.colors.surface2,
      },
      countChipText: { color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "600" as const },
      card: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 12,
        padding: 11,
        gap: 6,
        backgroundColor: theme.colors.surface1,
      },
      cardTop: { flexDirection: "row" as const, alignItems: "center" as const, gap: 7 },
      cardTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const, flex: 1 },
      cardMeta: { color: theme.colors.foregroundMuted, fontSize: 11 },
      cardActions: { flexDirection: "row" as const, gap: 6, flexWrap: "wrap" as const, marginTop: 2 },
      primarySmall: {
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      primarySmallText: { color: theme.colors.accentForeground, fontSize: 12, fontWeight: "600" as const },
      ghostSmall: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      ghostSmallText: { color: theme.colors.foreground, fontSize: 12 },
      dangerSmall: { paddingHorizontal: 10, paddingVertical: 6 },
      dangerSmallText: { color: theme.colors.statusDanger, fontSize: 12 },
      chip: {
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
      },
      chipText: { color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "600" as const },
      qChip: {
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: 6,
        backgroundColor: theme.colors.accent,
      },
      qChipText: { color: theme.colors.accentForeground, fontSize: 10, fontWeight: "700" as const },
      input: {
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface0,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: 12,
      },
      settingsHint: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 },
      handle: {
        width: 7,
        justifyContent: "center" as const,
        alignItems: "center" as const,
        backgroundColor: theme.colors.surface0,
      },
      grip: { width: 3, height: 32, borderRadius: 2, backgroundColor: theme.colors.border },
    };
  }, [theme, layout.compact]);

  const resizeCursor =
    Platform.OS === "web" ? ({ cursor: "ew-resize" } as unknown as ViewStyle) : undefined;
  const entries = timeline.data?.entries ?? [];
  const messages = entries
    .filter(
      (entry) => entry.item.type === "user_message" || entry.item.type === "assistant_message",
    )
    .filter(
      (entry) =>
        !(
          entry.item.type === "user_message" &&
          entry.item.text.trimStart().startsWith("[执行结果]")
        ),
    );
  const judgeEntries = (judgeTimeline.data?.entries ?? [])
    .filter((entry) => entry.item.type === "user_message" || entry.item.type === "assistant_message")
    .map((entry) => {
      if (entry.item.type !== "user_message") return entry;
      return {
        ...entry,
        item: { ...entry.item, text: stripTriageGate(entry.item.text) },
      };
    })
    .filter(
      (entry) =>
        entry.item.type === "assistant_message" ||
        (entry.item.type === "user_message" && entry.item.text.trim()),
    );
  useEffect(() => {
    if (!atBottomRef.current) return;
    const timer = setTimeout(() => messagesRef.current?.scrollToEnd({ animated: false }), 50);
    return () => clearTimeout(timer);
  }, [messages.length, mainAgentId]);
  useEffect(() => {
    const timer = setTimeout(() => feedRef.current?.scrollToEnd({ animated: false }), 80);
    return () => clearTimeout(timer);
  }, [judgeEntries.length, judgeAgentId]);
  useEffect(() => {
    atBottomRef.current = true;
    const timer = setTimeout(() => messagesRef.current?.scrollToEnd({ animated: false }), 80);
    return () => clearTimeout(timer);
  }, [params.focusAt]);
  const paused = status.data?.paused ?? false;
  const waitingAll = status.data?.tickets.filter((ticket) => ticket.state === "waiting_human") ?? [];
  const waitingByConversation = new Map<string, (typeof waitingAll)[number]>();
  for (const ticket of waitingAll) {
    const key = ticket.conversationId || `${ticket.sourceId}:${ticket.subject}`;
    const current = waitingByConversation.get(key);
    if (!current || ticket.updatedAt > current.updatedAt) waitingByConversation.set(key, ticket);
  }
  const waiting = [...waitingByConversation.values()].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  const active =
    status.data?.tickets.filter((ticket) => ["pending", "approved", "executing"].includes(ticket.state)) ?? [];
  const sources = status.data?.sources ?? [];
  const findTicketForText = (text: string) => {
    const byId = /(t_[a-z0-9_]+)/i.exec(text)?.[1] ?? "";
    const byIdTicket = byId
      ? status.data?.tickets.find((ticket) => ticket.id === byId)
      : undefined;
    if (byIdTicket) return byIdTicket;
    const byQNo = /T-(\d+)/i.exec(text)?.[1] ?? "";
    return byQNo
      ? status.data?.tickets.find((ticket) => String(ticket.qNo) === byQNo)
      : undefined;
  };
  const stateTone = (state: string) =>
    state === "done"
      ? theme.colors.statusSuccess
      : state === "failed"
        ? theme.colors.statusDanger
        : state === "waiting_human"
          ? theme.colors.statusWarning
          : theme.colors.accent;
  const sourceTone = (source: { enabled: boolean; approved: boolean; failCount: number }) =>
    !source.enabled
      ? theme.colors.foregroundMuted
      : source.failCount > 0
        ? theme.colors.statusDanger
        : source.approved
          ? theme.colors.statusSuccess
          : theme.colors.statusWarning;

  type MessageEntry = (typeof messages)[number];
  const messageKey = (entry: MessageEntry) => `${entry.timestamp}-${entry.item.type}`;
  const entryText = (entry: MessageEntry | null): string => {
    if (!entry) return "";
    return entry.item.type === "user_message" || entry.item.type === "assistant_message"
      ? entry.item.text
      : "";
  };
  const threads: Array<{ key: string; root: MessageEntry | null; replies: MessageEntry[] }> = [];
  let currentThread: (typeof threads)[number] | null = null;
  messages.forEach((entry, index) => {
    if (entry.item.type === "user_message") {
      currentThread = { key: messageKey(entry), root: entry, replies: [] };
      threads.push(currentThread);
    } else {
      if (!currentThread) {
        currentThread = { key: `synthetic-${index}`, root: null, replies: [] };
        threads.push(currentThread);
      }
      currentThread.replies.push(entry);
    }
  });
  let previousRightTicket: TicketView | undefined;
  const rightThreads = threads.map((thread) => {
    const threadText = [thread.root, ...thread.replies].map(entryText).join("\n");
    let threadTicket = findTicketForText(threadText);
    const rootText = entryText(thread.root).trimStart();
    if (!threadTicket && rootText.startsWith("> 引用 Superagent 的回复:")) {
      threadTicket = previousRightTicket;
    }
    if (threadTicket) previousRightTicket = threadTicket;
    return { thread, ticket: threadTicket };
  });

  const judgeThreads: typeof threads = [];
  let currentJudgeThread: (typeof judgeThreads)[number] | null = null;
  judgeEntries.forEach((entry, index) => {
    if (entry.item.type === "user_message") {
      currentJudgeThread = { key: messageKey(entry), root: entry, replies: [] };
      judgeThreads.push(currentJudgeThread);
    } else {
      if (!currentJudgeThread) {
        currentJudgeThread = { key: `judge-synthetic-${index}`, root: null, replies: [] };
        judgeThreads.push(currentJudgeThread);
      }
      currentJudgeThread.replies.push(entry);
    }
  });

  type LeftThread = {
    thread: (typeof judgeThreads)[number];
    ticket: TicketView | undefined;
    synthetic?: boolean;
  };
  const leftThreads: LeftThread[] = judgeThreads.map((thread) => {
    const threadText = [thread.root, ...thread.replies].map(entryText).join("\n");
    return { thread, ticket: findTicketForText(threadText) };
  });
  const knownTicketIds = new Set(
    leftThreads.map(({ ticket }) => ticket?.id).filter((id): id is string => Boolean(id)),
  );
  for (const ticket of status.data?.tickets ?? []) {
    if (!ticket.agentId || knownTicketIds.has(ticket.id)) continue;
    leftThreads.push({
      thread: { key: `ticket-${ticket.id}`, root: null, replies: [] },
      ticket,
      synthetic: true,
    });
  }
  const isWaitingTicket = (state: string) =>
    state === "waiting_human" || state === "pending";
  const isDispatchedTicket = (state: string, agentId: string) =>
    Boolean(agentId);
  const feedTabCounts = {
    all: leftThreads.filter(({ synthetic }) => !synthetic).length,
    waiting: leftThreads.filter(({ ticket }) => ticket && isWaitingTicket(ticket.state)).length,
    dispatched: leftThreads.filter(
      ({ ticket }) => ticket && isDispatchedTicket(ticket.state, ticket.agentId),
    ).length,
    ignored: leftThreads.filter(({ ticket }) => ticket?.state === "ignored").length,
  };
  const visibleThreads = leftThreads.filter(({ ticket, synthetic }) => {
    if (feedTab === "all") return !synthetic;
    if (!ticket) return false;
    if (feedTab === "waiting") return isWaitingTicket(ticket.state);
    if (feedTab === "dispatched") return isDispatchedTicket(ticket.state, ticket.agentId);
    return ticket.state === "ignored";
  });

  const toggleExpanded = (key: string) => {
    setExpandedMessages((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderMessage = (
    entry: MessageEntry,
    key: string,
    isRoot = false,
    _threadKey = "",
    forceQuote = false,
    contextTicket?: TicketView,
  ) => {
    const item = entry.item;
    const isUser = item.type === "user_message";
    const text = item.type === "user_message" || item.type === "assistant_message" ? item.text : "";
    const isNotice = isUser && SUPERAGENT_NOTICE_PREFIX.test(text.trimStart());
    const alignRight = isUser && !isNotice;
    const sourceAgentId = isNotice ? extractAgentId(text) : "";
    const linkedTicket = contextTicket || findTicketForText(text);
    const executorAgentId = linkedTicket?.agentId || "";
    const linkedSourceAgentId = linkedTicket?.sourceAgentId || "";
    const targetAgentId = executorAgentId || linkedSourceAgentId || sourceAgentId || mainAgentId;
    const targetAgentLabel = executorAgentId
      ? "执行 Agent ↗"
      : linkedSourceAgentId || sourceAgentId
        ? "来源 Agent ↗"
        : "Agent 页面 ↗";
    const quotedFull = alignRight ? splitQuotedMessage(text) : null;
    const bodySource = quotedFull ? quotedFull.body : text;
    const hasMermaid = /```mermaid\b/.test(bodySource);
    const collapsible =
      isRoot && !hasMermaid && bodySource.split("\n").filter((line) => line.trim()).length > 20;
    const collapsed = collapsible && !expandedMessages.has(key);
    const visibleBody = collapsed ? bodySource.split("\n").slice(0, 20).join("\n") : bodySource;
    const visibleText = collapsed && !quotedFull ? text.split("\n").slice(0, 20).join("\n") : text;
    const visibleQuoted = quotedFull ? { quote: quotedFull.quote, body: visibleBody } : null;
    return (
      <View key={key} style={[styles.messageRow, alignRight ? styles.messageRowUser : undefined]}>
        {!alignRight ? (
          <View style={styles.avatar}>
            <Icon name="Bot" size={15} color={theme.colors.accent} />
            <View
              style={[
                styles.avatarStatus,
                {
                  backgroundColor: mainAgentId
                    ? paused
                      ? theme.colors.statusWarning
                      : theme.colors.statusSuccess
                    : theme.colors.foregroundMuted,
                },
              ]}
            />
          </View>
        ) : null}
        <View style={styles.bubbleStack}>
          <View style={[styles.bubble, alignRight ? styles.bubbleUser : styles.bubbleAgent]}>
            {alignRight ? (
              visibleQuoted ? (
                <View>
                  <View style={styles.bubbleQuote}>
                    <Text style={styles.bubbleQuoteLabel}>引用</Text>
                    <Text style={styles.bubbleQuoteText} numberOfLines={4}>
                      {visibleQuoted.quote}
                    </Text>
                  </View>
                  <Text style={styles.bubbleUserText}>{visibleQuoted.body}</Text>
                </View>
              ) : (
                <Text style={styles.bubbleUserText}>{visibleText}</Text>
              )
            ) : (
              <Markdown>{normalizeMarkdown(visibleText)}</Markdown>
            )}
            {collapsible ? (
              <View style={styles.collapseRow}>
                <Pressable accessibilityRole="button" onPress={() => toggleExpanded(key)}>
                  <Text style={alignRight ? styles.expandTextUser : styles.expandText}>
                    {collapsed ? "展开" : "收起"}
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </View>
          {!alignRight || forceQuote || (navigation?.openAgent && targetAgentId) ? (
            <View style={styles.messageActions}>
              {!alignRight || forceQuote ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="引用这条消息"
                  hitSlop={4}
                  style={styles.quoteAction}
                  onPress={() => {
                    setQuoted({ text, from: isUser ? "source" : "assistant" });
                    if (layout.compact) {
                      setMobilePane("chat");
                      setTimeout(() => inputRef.current?.focus(), 80);
                    } else {
                      inputRef.current?.focus();
                    }
                  }}
                >
                  <Text style={styles.quoteActionText}>引用</Text>
                </Pressable>
              ) : null}
              {navigation?.openAgent && targetAgentId ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={targetAgentLabel}
                  hitSlop={4}
                  style={styles.quoteAction}
                  onPress={() => navigation.openAgent?.({ agentId: targetAgentId })}
                >
                  <Text style={styles.quoteActionText}>{targetAgentLabel}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
    );
  };

  return (
    <View style={styles.screen}>
      {layout.compact ? (
        <View style={styles.mobileSwitch}>
          <Pressable
            accessibilityRole="button"
            style={[
              styles.mobileSwitchButton,
              mobilePane === "feed" ? styles.mobileSwitchButtonActive : undefined,
            ]}
            onPress={() => setMobilePane("feed")}
          >
            <Text
              style={
                mobilePane === "feed"
                  ? styles.mobileSwitchTextActive
                  : styles.mobileSwitchText
              }
            >
              消息{waiting.length > 0 ? ` (${waiting.length})` : ""}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={[
              styles.mobileSwitchButton,
              mobilePane === "chat" ? styles.mobileSwitchButtonActive : undefined,
            ]}
            onPress={() => setMobilePane("chat")}
          >
            <Text
              style={
                mobilePane === "chat"
                  ? styles.mobileSwitchTextActive
                  : styles.mobileSwitchText
              }
            >
              Superagent
            </Text>
          </Pressable>
        </View>
      ) : null}
      <View style={styles.row}>
        {uiReady && (layout.compact ? mobilePane === "feed" : sidebarOpen) ? (
          <View
            style={[
              styles.feed,
              layout.compact
                ? { flex: 1, width: "100%" as const }
                : { width: resolvedFeedWidth },
            ]}
          >
            {!layout.compact ? (
              <View style={styles.feedHeader}>
                <View style={styles.feedTitleRow}>
                  <Text style={styles.sidebarTitle}>消息</Text>
                </View>
                <Pressable accessibilityRole="button" onPress={() => setSidebarOpen(false)}>
                  <Text style={styles.ghostSmallText}>收起</Text>
                </Pressable>
              </View>
            ) : null}
            <View style={styles.feedTabs}>
              {(
                [
                  ["all", "全部"],
                  ["waiting", "待处理"],
                  ["dispatched", "已派发"],
                  ["ignored", "忽略"],
                ] as const
              ).map(([key, label]) => (
                <Pressable
                  key={key}
                  accessibilityRole="button"
                  style={[styles.feedTab, feedTab === key ? styles.feedTabActive : undefined]}
                  onPress={() => setFeedTab(key)}
                >
                  <Text
                    style={feedTab === key ? styles.feedTabTextActive : styles.feedTabText}
                  >
                    {label} {feedTabCounts[key]}
                  </Text>
                </Pressable>
              ))}
            </View>
            <ScrollView ref={feedRef} style={{ flex: 1 }} contentContainerStyle={styles.messagesContent}>
              {visibleThreads.length === 0 ? (
                <Text style={styles.feedEmpty}>
                  {feedTab === "all"
                    ? "暂无消息。新事件和 AI 回复会出现在这里。"
                    : feedTab === "waiting"
                      ? "暂无待处理消息。"
                      : feedTab === "dispatched"
                        ? "暂无已派发消息。"
                        : "暂无已忽略消息。"}
                </Text>
              ) : null}
              {visibleThreads.map(({ thread, ticket: threadTicket }) => {
                const executor = threadTicket?.agentId
                  ? (subagents.data?.entries ?? []).find(
                      ({ agent }) => agent.id === threadTicket.agentId,
                    )?.agent
                  : undefined;
                return (
                  <View key={thread.key} style={styles.thread}>
                    {threadTicket ? (
                      <View style={styles.threadMetaRow}>
                        <View style={styles.qChip}>
                          <Text style={styles.qChipText}>T-{threadTicket.qNo}</Text>
                        </View>
                        <Text style={styles.threadMetaText}>
                          {ticketStateLabel(threadTicket.state)}
                        </Text>
                        {threadTicket.agentId ? (
                          navigation?.openAgent ? (
                            <Pressable
                              accessibilityRole="button"
                              onPress={() =>
                                navigation.openAgent?.({ agentId: threadTicket.agentId })
                              }
                            >
                              <Text style={styles.threadAgentLink}>
                                执行 Agent: {executor?.title || threadTicket.agentId.slice(0, 8)} ↗
                              </Text>
                            </Pressable>
                          ) : (
                            <Text style={styles.threadAgentLink}>
                              执行 Agent: {executor?.title || threadTicket.agentId.slice(0, 8)}
                            </Text>
                          )
                        ) : (
                          <Text style={styles.threadMetaText}>未派发执行 Agent</Text>
                        )}
                      </View>
                    ) : null}
                    {thread.root
                      ? renderMessage(
                          thread.root,
                          messageKey(thread.root),
                          true,
                          thread.key,
                          true,
                          threadTicket,
                        )
                      : null}
                    {thread.replies.length > 0 ? (
                      <View style={styles.threadReplies}>
                        <Text style={styles.threadReplyLabel}>AI 回复</Text>
                        {thread.replies.map((reply) =>
                          renderMessage(
                            reply,
                            messageKey(reply),
                            false,
                            thread.key,
                            true,
                            threadTicket,
                          ),
                        )}
                      </View>
                    ) : null}
                    {!thread.root && thread.replies.length === 0 && threadTicket ? (
                      <View style={styles.dispatchRecord}>
                        <Text style={styles.dispatchRecordLabel}>执行记录</Text>
                        <Text style={styles.cardTitle} numberOfLines={2}>
                          {threadTicket.title}
                        </Text>
                        <Text style={styles.cardMeta}>原始消息不在当前 judge 时间线</Text>
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </ScrollView>
          </View>
        ) : null}

        {!layout.compact && uiReady && sidebarOpen ? (
          <View
            ref={handleRef}
            {...(Platform.OS === "web" ? {} : panResponder.panHandlers)}
            style={[styles.handle, resizeCursor, { userSelect: "none" } as unknown as ViewStyle]}
          />
        ) : null}

        {!layout.compact || mobilePane === "chat" ? (
          <View style={styles.chat}>
          <View style={styles.header}>
            <View style={styles.brandRow}>
              <View style={styles.brandMark}>
                <Icon icon={{ svg: SUPERAGENT_LOGO_SVG }} size={34} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.title} numberOfLines={1}>
                  Superagent
                </Text>
                <View style={styles.subtitleRow}>
                  <View style={[styles.dot, { backgroundColor: paused ? theme.colors.statusWarning : theme.colors.statusSuccess }]} />
                  <Text style={styles.subtitle} numberOfLines={1}>
                    {mainAgentId
                      ? paused
                        ? "已暂停 · 仍可对话"
                        : "运行中 · 直接说你要什么"
                      : "正在初始化主 agent…"}
                  </Text>
                </View>
              </View>
            </View>
            <View style={styles.headerActions}>
              <Pressable
                accessibilityRole="button"
                style={styles.ghostSmall}
                onPress={() => setExecutorsOpen(true)}
              >
                <Text style={styles.ghostSmallText}>
                  执行 Agent
                  {(subagents.data?.entries ?? []).length > 0
                    ? ` (${(subagents.data?.entries ?? []).length})`
                    : ""}
                </Text>
              </Pressable>
              <Pressable accessibilityRole="button" style={styles.ghostSmall} onPress={() => setSourcesOpen(true)}>
                <Text style={styles.ghostSmallText}>消息源</Text>
              </Pressable>
              <Pressable accessibilityRole="button" style={styles.ghostSmall} onPress={() => setSettingsOpen(true)}>
                <Text style={styles.ghostSmallText}>设置</Text>
              </Pressable>
              {!layout.compact ? (
                <Pressable
                  accessibilityRole="button"
                  style={styles.ghostSmall}
                  onPress={() => setSidebarOpen((open) => !open)}
                >
                  <Text style={styles.ghostSmallText}>
                    {sidebarOpen ? "收起消息" : "消息"}
                    {!sidebarOpen && waiting.length > 0 ? ` (${waiting.length})` : ""}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>

          <ScrollView
            ref={messagesRef}
            style={styles.messages}
            contentContainerStyle={styles.messagesContent}
            onContentSizeChange={() => {
              if (atBottomRef.current) messagesRef.current?.scrollToEnd({ animated: false });
            }}
            onScroll={(event) => {
              const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
              atBottomRef.current =
                contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
            }}
            scrollEventThrottle={16}
          >
            {messages.length === 0 ? (
              <View style={styles.empty}>
                <View style={styles.emptyMark}>
                  <Icon icon={{ svg: SUPERAGENT_LOGO_SVG }} size={44} />
                </View>
                <Text style={styles.emptyTitle}>直接和 Superagent 说你要什么</Text>
                <Text style={styles.emptyHint}>
                  例如:帮我接一个 Autowonder 待决策工单的消息源,每 5 分钟拉一次;或者让它把某个工单派给子 agent 执行。
                </Text>
              </View>
            ) : null}
            {rightThreads.map(({ thread, ticket: threadTicket }) => {
              const rootIsNotice =
                thread.root?.item.type === "user_message" &&
                SUPERAGENT_NOTICE_PREFIX.test(thread.root.item.text.trimStart());
              return (
                <View key={thread.key} style={styles.thread}>
                  {thread.root
                    ? renderMessage(
                        thread.root,
                        messageKey(thread.root),
                        true,
                        thread.key,
                        false,
                        threadTicket,
                      )
                    : null}
                  {thread.replies.length > 0 ? (
                    rootIsNotice ? (
                      <View style={styles.threadReplies}>
                        <Text style={styles.threadReplyLabel}>AI 回复</Text>
                        {thread.replies.map((reply) =>
                          renderMessage(
                            reply,
                            messageKey(reply),
                            false,
                            thread.key,
                            false,
                            threadTicket,
                          ),
                        )}
                      </View>
                    ) : (
                      thread.replies.map((reply) =>
                        renderMessage(
                          reply,
                          messageKey(reply),
                          false,
                          thread.key,
                          false,
                          threadTicket,
                        ),
                      )
                    )
                  ) : null}
                </View>
              );
            })}
          </ScrollView>

          {quoted ? (
            <View style={styles.quoteBar}>
              <View style={{ flex: 1 }}>
                <Text style={styles.quoteLabel}>引用{quoteDisplayName(quoted.from)}</Text>
                <Text style={styles.quoteText} numberOfLines={3}>
                  {quoted.text}
                </Text>
              </View>
              <Pressable accessibilityRole="button" onPress={() => setQuoted(null)}>
                <Text style={styles.ghostSmallText}>取消</Text>
              </Pressable>
            </View>
          ) : null}
          <View style={styles.composer}>
            <TextInput
              ref={inputRef}
              style={styles.composerInput}
              value={draft}
              onChangeText={setDraft}
              placeholder={
                quoted?.from === "source"
                  ? "针对这条消息回复 Superagent,例如:帮我处理 / 先解释一下"
                  : "和 Superagent 聊天,或让它配置消息源/派发任务"
              }
              placeholderTextColor={theme.colors.foregroundMuted}
              multiline
            />
            <Pressable
              accessibilityRole="button"
              style={[styles.sendButton, (!draft.trim() || sendMessage.isPending) && styles.sendButtonDisabled]}
              disabled={!draft.trim() || sendMessage.isPending}
              onPress={() => {
                const text = draft.trim();
                if (!text) return;
                const quote = quoted
                  ? `> 引用${quoteDisplayName(quoted.from)}:\n> ${quoted.text
                      .trim()
                      .slice(0, 2000)
                      .split("\n")
                      .join("\n> ")}\n\n`
                  : "";
                sendMessage.mutate({ text, quote });
              }}
            >
              <Text style={styles.sendButtonText}>{sendMessage.isPending ? "发送中" : "发送"}</Text>
            </Pressable>
          </View>
          {notice ? <Text style={styles.notice}>{notice}</Text> : null}
          {sendMessage.error ? <Text style={styles.notice}>{String(sendMessage.error.message)}</Text> : null}

          <View style={styles.subagentsBar}>
            <View style={styles.subagentsHeader}>
              <Text style={styles.sectionTitle}>子 Agent</Text>
              {navigation?.openAgent && mainAgentId ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => navigation.openAgent?.({ agentId: mainAgentId })}
                >
                  <Text style={styles.ghostSmallText}>打开主 Agent 页面 ↗</Text>
                </Pressable>
              ) : null}
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
              {(subagents.data?.entries ?? []).length === 0 ? (
                <Text style={styles.cardMeta}>暂无</Text>
              ) : null}
              {(subagents.data?.entries ?? []).map(({ agent }) => (
                <Pressable
                  key={agent.id}
                  style={styles.subagentChip}
                  onPress={() => navigation?.openAgent?.({ agentId: agent.id })}
                >
                  <View
                    style={[
                      styles.dot,
                      {
                        backgroundColor:
                          agent.status === "error"
                            ? theme.colors.statusDanger
                            : agent.status === "running"
                              ? theme.colors.accent
                              : theme.colors.statusSuccess,
                      },
                    ]}
                  />
                  <Text style={styles.subagentText} numberOfLines={1}>
                    {(agent.title || agent.id.slice(0, 8)).replace(/^sa-exec-/, "")}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
        ) : null}

        {false && uiReady && sidebarOpen && !layout.compact ? (
          <View
            ref={handleRef}
            {...(Platform.OS === "web" ? {} : panResponder.panHandlers)}
            style={[styles.handle, resizeCursor, { userSelect: "none" } as unknown as ViewStyle]}
          >
            <View style={styles.grip} />
          </View>
        ) : null}

        {false && uiReady && sidebarOpen ? (
          <ScrollView
            style={[styles.sidebar, !layout.compact ? { width: Math.min(sidebarWidth, maxFeed) } : undefined]}
            contentContainerStyle={styles.sidebarContent}
          >
            <View style={styles.sidebarHeader}>
              <Text style={styles.sidebarTitle}>控制台</Text>
              <Pressable accessibilityRole="button" style={styles.ghostSmall} onPress={() => setSidebarOpen(false)}>
                <Text style={styles.ghostSmallText}>收起</Text>
              </Pressable>
            </View>

            <View style={styles.actionsRow}>
              <Pressable style={styles.ghostSmall} onPress={() => pauseMutation.mutate(!paused)}>
                <Text style={styles.ghostSmallText}>{paused ? "继续运行" : "暂停全部"}</Text>
              </Pressable>
              <Pressable style={styles.ghostSmall} onPress={refresh}>
                <Text style={styles.ghostSmallText}>刷新</Text>
              </Pressable>
            </View>

            <View style={styles.sectionRow}>
              <Text style={styles.sectionTitle}>待你决策</Text>
              <View style={styles.countChip}>
                <Text style={styles.countChipText}>{waiting.length}</Text>
              </View>
            </View>
            {waiting.length === 0 ? <Text style={styles.cardMeta}>暂无</Text> : null}
            {waiting.map((ticket) => (
              <View key={ticket.id} style={styles.card}>
                <View style={styles.cardTop}>
                  <View style={styles.qChip}>
                    <Text style={styles.qChipText}>T-{ticket.qNo}</Text>
                  </View>
                  <Text style={styles.cardTitle} numberOfLines={2}>
                    {ticket.title}
                  </Text>
                </View>
                <Markdown>{ticket.question}</Markdown>
                {ticket.plan ? (
                  <Text style={styles.cardMeta} numberOfLines={3}>
                    计划:{ticket.plan}
                  </Text>
                ) : null}
                <View style={styles.cardActions}>
                  <Pressable style={styles.primarySmall} onPress={() => decideMutation.mutate({ id: ticket.id, action: "approve" })}>
                    <Text style={styles.primarySmallText}>批准</Text>
                  </Pressable>
                  <Pressable style={styles.ghostSmall} onPress={() => decideMutation.mutate({ id: ticket.id, action: "reject" })}>
                    <Text style={styles.ghostSmallText}>否决</Text>
                  </Pressable>
                  <Pressable style={styles.dangerSmall} onPress={() => decideMutation.mutate({ id: ticket.id, action: "stop" })}>
                    <Text style={styles.dangerSmallText}>停止</Text>
                  </Pressable>
                </View>
              </View>
            ))}

            <View style={styles.sectionRow}>
              <Text style={styles.sectionTitle}>进行中</Text>
              <View style={styles.countChip}>
                <Text style={styles.countChipText}>{active.length}</Text>
              </View>
            </View>
            {active.length === 0 ? <Text style={styles.cardMeta}>暂无</Text> : null}
            {active.map((ticket) => (
              <View key={ticket.id} style={styles.card}>
                <View style={styles.cardTop}>
                  <View style={[styles.dot, { backgroundColor: stateTone(ticket.state) }]} />
                  <Text style={styles.cardTitle} numberOfLines={1}>
                    {ticket.title}
                  </Text>
                  <View style={styles.chip}>
                    <Text style={styles.chipText}>{ticket.state}</Text>
                  </View>
                </View>
                <Text style={styles.cardMeta}>{ticket.sourceId}</Text>
              </View>
            ))}

            <View style={styles.sectionRow}>
              <Text style={styles.sectionTitle}>消息源</Text>
              <View style={styles.countChip}>
                <Text style={styles.countChipText}>{sources.length}</Text>
              </View>
            </View>
            {sources.length === 0 ? <Text style={styles.cardMeta}>暂无,直接让 Superagent 帮你加</Text> : null}
            {sources.map((source) => (
              <View key={source.id} style={styles.card}>
                <View style={styles.cardTop}>
                  <View style={[styles.dot, { backgroundColor: sourceTone(source) }]} />
                  <Text style={styles.cardTitle} numberOfLines={1}>
                    {source.name || source.id}
                  </Text>
                  <Text style={styles.cardMeta}>{source.intervalSec > 0 ? `${source.intervalSec}s` : "实时"}</Text>
                </View>
                <Text style={styles.cardMeta}>
                  {source.enabled ? "运行中" : "已关闭"} · {source.approved ? "已批准" : "待批准"}
                  {source.failCount > 0 ? ` · 失败 ${source.failCount}` : ""}
                </Text>
                {source.lastError ? (
                  <Text style={styles.cardMeta} numberOfLines={2}>
                    {source.lastError}
                  </Text>
                ) : null}
                <View style={styles.cardActions}>
                  <Pressable style={styles.ghostSmall} onPress={() => toggleMutation.mutate({ id: source.id, enabled: !source.enabled })}>
                    <Text style={styles.ghostSmallText}>{source.enabled ? "关闭" : "开始"}</Text>
                  </Pressable>
                  {source.intervalSec > 0 ? (
                    <Pressable style={styles.ghostSmall} onPress={() => testMutation.mutate(source.id)}>
                      <Text style={styles.ghostSmallText}>测试</Text>
                    </Pressable>
                  ) : null}
                  {!source.approved ? (
                    <Pressable style={styles.ghostSmall} onPress={() => approveMutation.mutate(source.id)}>
                      <Text style={styles.ghostSmallText}>批准</Text>
                    </Pressable>
                  ) : null}
                  <Pressable style={styles.dangerSmall} onPress={() => deleteMutation.mutate(source.id)}>
                    <Text style={styles.dangerSmallText}>删除</Text>
                  </Pressable>
                </View>
              </View>
            ))}

            <Pressable style={styles.sectionRow} onPress={() => setSettingsOpen((open) => !open)}>
              <Text style={styles.sectionTitle}>设置</Text>
              <Text style={styles.cardMeta}>{settingsOpen ? "收起" : "展开"}</Text>
            </Pressable>
            {settingsOpen ? (
              <View style={styles.card}>
                <Text style={styles.cardMeta}>仓库路径(worktree 源)</Text>
                <TextInput style={styles.input} value={repoPath} onChangeText={setRepoPath} placeholder="/absolute/path/to/repo" placeholderTextColor={theme.colors.foregroundMuted} />
                <Text style={styles.cardMeta}>基线分支</Text>
                <TextInput style={styles.input} value={baseBranch} onChangeText={setBaseBranch} placeholder="main" placeholderTextColor={theme.colors.foregroundMuted} />
                <SelectField
                  label="主 agent provider"
                  value={mainProvider}
                  placeholder="选择 provider"
                  options={providerOptions}
                  theme={theme}
                  onChange={(value) => {
                    setMainProvider(value);
                    const model = defaultModelFor(value);
                    setMainModel(model);
                    setMainThinking(defaultThinkingFor(value, model));
                  }}
                />
                <SelectField
                  label="主 agent model"
                  value={mainModel}
                  placeholder="选择模型"
                  options={modelsFor(mainProvider)}
                  theme={theme}
                  onChange={(value) => {
                    setMainModel(value);
                    setMainThinking(defaultThinkingFor(mainProvider, value));
                  }}
                />
                <SelectField
                  label="主 agent 思考强度"
                  value={mainThinking}
                  placeholder="默认"
                  options={thinkingFor(mainProvider, mainModel)}
                  theme={theme}
                  onChange={setMainThinking}
                />
                <SelectField
                  label="执行 agent provider"
                  value={executorProvider}
                  placeholder="选择 provider"
                  options={providerOptions}
                  theme={theme}
                  onChange={(value) => {
                    setExecutorProvider(value);
                    const model = defaultModelFor(value);
                    setExecutorModel(model);
                    setExecutorThinking(defaultThinkingFor(value, model));
                  }}
                />
                <SelectField
                  label="执行 agent model"
                  value={executorModel}
                  placeholder="选择模型"
                  options={modelsFor(executorProvider)}
                  theme={theme}
                  onChange={(value) => {
                    setExecutorModel(value);
                    setExecutorThinking(defaultThinkingFor(executorProvider, value));
                  }}
                />
                <SelectField
                  label="执行 agent 思考强度"
                  value={executorThinking}
                  placeholder="默认"
                  options={thinkingFor(executorProvider, executorModel)}
                  theme={theme}
                  onChange={setExecutorThinking}
                />
                <Text style={styles.cardMeta}>企微 Bot ID</Text>
                <TextInput style={styles.input} value={wecomBotId} onChangeText={setWecomBotId} placeholderTextColor={theme.colors.foregroundMuted} />
                <Text style={styles.cardMeta}>企微 Bot Secret(留空不修改)</Text>
                <TextInput style={styles.input} value={wecomSecret} onChangeText={setWecomSecret} secureTextEntry placeholderTextColor={theme.colors.foregroundMuted} />
                <Text style={styles.settingsHint}>
                  企业微信:
                  {status.data?.settings.wecomConfigured
                    ? status.data?.settings.wecomConnected
                      ? "已连接"
                      : status.data?.settings.wecomError
                        ? `未连接(${status.data?.settings.wecomError})`
                        : "连接中"
                    : "未配置"}
                </Text>
                <Pressable style={styles.primarySmall} onPress={() => settingsMutation.mutate()}>
                  <Text style={styles.primarySmallText}>{settingsMutation.isPending ? "保存中" : "保存设置"}</Text>
                </Pressable>
                <Pressable style={styles.ghostSmall} onPress={() => rebuildMutation.mutate()}>
                  <Text style={styles.ghostSmallText}>重建主 agent(应用主模型修改)</Text>
                </Pressable>
                <Text style={styles.settingsHint}>
                  主 agent 的模型/思考强度修改后需重建生效;执行 agent 在下一次派发生效。
                </Text>
              </View>
            ) : null}
          </ScrollView>
        ) : null}

        <Modal open={executorsOpen} onOpenChange={setExecutorsOpen} title="执行 Agent">
          <Modal.Content scrollable>
            <View style={{ gap: 8 }}>
              <Text style={styles.settingsHint}>
                这里列出所有由 Superagent 派发的执行 Agent，点击可直接进入它的会话。
              </Text>
              {(subagents.data?.entries ?? []).length === 0 ? (
                <Text style={styles.cardMeta}>暂无执行 Agent</Text>
              ) : null}
              {(subagents.data?.entries ?? []).map(({ agent }) => (
                <View key={agent.id} style={styles.card}>
                  <View style={styles.cardTop}>
                    <View
                      style={[
                        styles.dot,
                        {
                          backgroundColor:
                            agent.status === "error"
                              ? theme.colors.statusDanger
                              : agent.status === "running"
                                ? theme.colors.accent
                                : theme.colors.statusSuccess,
                        },
                      ]}
                    />
                    <Text style={styles.cardTitle} numberOfLines={1}>
                      {agent.title || agent.id}
                    </Text>
                    <Text style={styles.cardMeta}>{agent.status}</Text>
                  </View>
                  <Text style={styles.cardMeta}>
                    {agent.labels?.["superagent.kind"] === "autowonder-coordinator"
                      ? "Autowonder 协调执行器"
                      : agent.labels?.["superagent.ticket"]
                        ? `工单 ${agent.labels["superagent.ticket"]}`
                        : agent.id.slice(0, 8)}
                  </Text>
                  <View style={styles.cardActions}>
                    <Pressable
                      style={styles.ghostSmall}
                      onPress={() => navigation?.openAgent?.({ agentId: agent.id })}
                    >
                      <Text style={styles.ghostSmallText}>打开 Agent ↗</Text>
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          </Modal.Content>
        </Modal>

        <Modal open={sourcesOpen} onOpenChange={setSourcesOpen} title="消息源">
          <Modal.Content scrollable>
            <View style={{ gap: 8 }}>
              <Text style={styles.settingsHint}>
                直接对 Superagent 说“接一个 XX 消息源”来新增;这里只管理已有来源。
              </Text>
              {sources.length === 0 ? <Text style={styles.cardMeta}>暂无</Text> : null}
              {sources.map((source) => (
                <View key={source.id} style={styles.card}>
                  <View style={styles.cardTop}>
                    <View style={[styles.dot, { backgroundColor: sourceTone(source) }]} />
                    <Text style={styles.cardTitle} numberOfLines={1}>
                      {source.name || source.id}
                    </Text>
                    <Text style={styles.cardMeta}>
                      {source.intervalSec > 0 ? `${source.intervalSec}s` : "实时"}
                    </Text>
                  </View>
                  <Text style={styles.cardMeta}>
                    {source.enabled ? "运行中" : "已关闭"} · {source.approved ? "已批准" : "待批准"}
                    {source.failCount > 0 ? ` · 失败 ${source.failCount}` : ""}
                  </Text>
                  {source.lastError ? (
                    <Text style={styles.cardMeta} numberOfLines={2}>
                      {source.lastError}
                    </Text>
                  ) : null}
                  <View style={styles.cardActions}>
                    <Pressable
                      style={styles.ghostSmall}
                      onPress={() => toggleMutation.mutate({ id: source.id, enabled: !source.enabled })}
                    >
                      <Text style={styles.ghostSmallText}>{source.enabled ? "关闭" : "开始"}</Text>
                    </Pressable>
                    {source.intervalSec > 0 ? (
                      <Pressable style={styles.ghostSmall} onPress={() => testMutation.mutate(source.id)}>
                        <Text style={styles.ghostSmallText}>测试</Text>
                      </Pressable>
                    ) : null}
                    {!source.approved ? (
                      <Pressable style={styles.ghostSmall} onPress={() => approveMutation.mutate(source.id)}>
                        <Text style={styles.ghostSmallText}>批准</Text>
                      </Pressable>
                    ) : null}
                    <Pressable style={styles.dangerSmall} onPress={() => deleteMutation.mutate(source.id)}>
                      <Text style={styles.dangerSmallText}>删除</Text>
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          </Modal.Content>
        </Modal>

        <Modal open={settingsOpen} onOpenChange={setSettingsOpen} title="设置">
          <Modal.Content scrollable>
            <View style={{ gap: 8 }}>
              <View style={styles.actionsRow}>
                <Pressable style={styles.ghostSmall} onPress={() => pauseMutation.mutate(!paused)}>
                  <Text style={styles.ghostSmallText}>{paused ? "继续运行" : "暂停全部"}</Text>
                </Pressable>
                <Pressable style={styles.ghostSmall} onPress={refresh}>
                  <Text style={styles.ghostSmallText}>刷新</Text>
                </Pressable>
                <Pressable style={styles.ghostSmall} onPress={() => setNotifyOnly((value) => !value)}>
                  <Text style={styles.ghostSmallText}>仅通知模式: {notifyOnly ? "开" : "关"}</Text>
                </Pressable>
              </View>
              <Text style={styles.settingsHint}>
                开启时只播报事件,不自动派发/忽略/执行;只有你明确回复某张 T 工单要求处理后才执行。
              </Text>
              <Text style={styles.cardMeta}>仓库路径(worktree 源)</Text>
              <TextInput
                style={styles.input}
                value={repoPath}
                onChangeText={setRepoPath}
                placeholder="/absolute/path/to/repo"
                placeholderTextColor={theme.colors.foregroundMuted}
              />
              <Text style={styles.cardMeta}>基线分支</Text>
              <TextInput
                style={styles.input}
                value={baseBranch}
                onChangeText={setBaseBranch}
                placeholder="main"
                placeholderTextColor={theme.colors.foregroundMuted}
              />
              <SelectField
                label="主 agent provider"
                value={mainProvider}
                placeholder="选择 provider"
                options={providerOptions}
                theme={theme}
                onChange={(value) => {
                  setMainProvider(value);
                  const model = defaultModelFor(value);
                  setMainModel(model);
                  setMainThinking(defaultThinkingFor(value, model));
                }}
              />
              <SelectField
                label="主 agent model"
                value={mainModel}
                placeholder="选择模型"
                options={modelsFor(mainProvider)}
                theme={theme}
                onChange={(value) => {
                  setMainModel(value);
                  setMainThinking(defaultThinkingFor(mainProvider, value));
                }}
              />
              <SelectField
                label="主 agent 思考强度"
                value={mainThinking}
                placeholder="默认"
                options={thinkingFor(mainProvider, mainModel)}
                theme={theme}
                onChange={setMainThinking}
              />
              <SelectField
                label="执行 agent provider"
                value={executorProvider}
                placeholder="选择 provider"
                options={providerOptions}
                theme={theme}
                onChange={(value) => {
                  setExecutorProvider(value);
                  const model = defaultModelFor(value);
                  setExecutorModel(model);
                  setExecutorThinking(defaultThinkingFor(value, model));
                }}
              />
              <SelectField
                label="执行 agent model"
                value={executorModel}
                placeholder="选择模型"
                options={modelsFor(executorProvider)}
                theme={theme}
                onChange={(value) => {
                  setExecutorModel(value);
                  setExecutorThinking(defaultThinkingFor(executorProvider, value));
                }}
              />
              <SelectField
                label="执行 agent 思考强度"
                value={executorThinking}
                placeholder="默认"
                options={thinkingFor(executorProvider, executorModel)}
                theme={theme}
                onChange={setExecutorThinking}
              />
              <Text style={styles.cardMeta}>企微 Bot ID</Text>
              <TextInput
                style={styles.input}
                value={wecomBotId}
                onChangeText={setWecomBotId}
                placeholderTextColor={theme.colors.foregroundMuted}
              />
              <Text style={styles.cardMeta}>企微 Bot Secret(留空不修改)</Text>
              <TextInput
                style={styles.input}
                value={wecomSecret}
                onChangeText={setWecomSecret}
                secureTextEntry
                placeholderTextColor={theme.colors.foregroundMuted}
              />
              <Text style={styles.settingsHint}>
                企业微信:
                {status.data?.settings.wecomConfigured
                  ? status.data.settings.wecomConnected
                    ? "已连接"
                    : status.data.settings.wecomError
                      ? `未连接(${status.data.settings.wecomError})`
                      : "连接中"
                  : "未配置"}
              </Text>
              <Pressable style={styles.primarySmall} onPress={() => settingsMutation.mutate()}>
                <Text style={styles.primarySmallText}>
                  {settingsMutation.isPending ? "保存中" : "保存设置"}
                </Text>
              </Pressable>
              <Pressable style={styles.ghostSmall} onPress={() => rebuildMutation.mutate()}>
                <Text style={styles.ghostSmallText}>重建主 agent(应用主模型修改)</Text>
              </Pressable>
              <Text style={styles.settingsHint}>
                主 agent 的模型/思考强度修改后需重建生效;执行 agent 在下一次派发生效。
              </Text>
            </View>
          </Modal.Content>
        </Modal>
      </View>
    </View>
  );
}
