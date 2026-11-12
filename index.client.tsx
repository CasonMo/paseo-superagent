import { useRpc, type PluginClientContext, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { SuperagentScreen } from "./client/panel";
import { SUPERAGENT_MARK_SVG } from "./client/logo";
import { markSeenRpc, statusRpc } from "./shared/superagent";

function SuperagentItem({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
  const fetchStatus = useRpc(statusRpc);
  const markSeen = useRpc(markSeenRpc);
  const status = useQuery({
    queryKey: ["superagent", "badge"],
    queryFn: () => fetchStatus({}),
    refetchInterval: 5000,
  });
  const count = status.data?.newEvents ?? 0;
  const trailing =
    count > 0 ? (
      <View
        style={{
          minWidth: 18,
          height: 18,
          borderRadius: 9,
          paddingHorizontal: 5,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.colors.accent,
        }}
      >
        <Text style={{ color: theme.colors.accentForeground, fontSize: 10, fontWeight: "600" }}>
          {count > 99 ? "99+" : count}
        </Text>
      </View>
    ) : undefined;
  return (
    <SidebarRow
      icon={{ svg: SUPERAGENT_MARK_SVG }}
      active={currentScreen?.screenId === "superagent"}
      trailing={trailing}
      onPress={() => {
        openScreen({ screenId: "superagent", params: { focusAt: String(Date.now()) } });
        void markSeen({})
          .then(() => status.refetch())
          .catch(() => {});
      }}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "superagent", title: "Superagent", Component: SuperagentScreen });
  client.addSidebarHeaderItem({ id: "superagent", title: "Superagent", Component: SuperagentItem });
  return () => {};
}
