import { botStatusLine } from "@pupbot/api-client";
import type { BotSummary } from "@pupbot/api-client";
import { ChevronRightIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { api, errorMessage } from "../../src/api.ts";
import { Avatar } from "../../src/components/avatar.tsx";
import { Card, Screen, StatusDot } from "../../src/components/ui.tsx";
import { useSession } from "../../src/session.tsx";
import { color, radius, space, type, weight } from "../../src/theme.ts";

/** How often the list asks for fresh computer and run state while it is on screen. */
const POLL_MS = 5000;

export default function BotsScreen() {
  const { status, user } = useSession();
  const router = useRouter();
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(false);

  const load = useCallback(async (mode: "initial" | "refresh" | "quiet") => {
    // A slow poll must not stack on top of the next tick.
    if (inFlight.current && mode === "quiet") return;
    inFlight.current = true;
    if (mode === "refresh") setRefreshing(true);
    try {
      const next = await api.listBots();
      setBots(next);
      setError(null);
    } catch (caught) {
      if (mode !== "quiet") setError(errorMessage(caught));
    } finally {
      inFlight.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load("initial");
      const timer = setInterval(() => void load("quiet"), POLL_MS);
      return () => clearInterval(timer);
    }, [load]),
  );

  if (status === "signed-out") return <Redirect href="/sign-in" />;

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.title}>Bots</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Account settings"
          onPress={() => router.push("/(tabs)/settings")}
          style={styles.accountChip}
        >
          <Text style={styles.accountInitial}>{(user?.name ?? "?").slice(0, 1).toUpperCase()}</Text>
        </Pressable>
      </View>

      {error ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{error}</Text>
          <Pressable accessibilityRole="button" onPress={() => void load("refresh")}>
            <Text style={styles.bannerAction}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      <FlatList
        data={bots}
        keyExtractor={(bot) => bot.id}
        contentContainerStyle={bots.length === 0 ? styles.listEmpty : styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load("refresh")}
            tintColor={color.textMuted}
          />
        }
        ListEmptyComponent={
          loading ? undefined : (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyTitle}>No bots yet</Text>
              <Text style={styles.emptyBody}>
                Bots you create in the web app show up here, with their computer and model.
              </Text>
            </Card>
          )
        }
        renderItem={({ item }) => (
          <BotRow
            bot={item}
            onOpenChat={() => router.push({ pathname: "/chat/[botId]", params: { botId: item.id } })}
            onOpenDetail={() => router.push({ pathname: "/bot/[botId]", params: { botId: item.id } })}
          />
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />
    </Screen>
  );
}

function BotRow({
  bot,
  onOpenChat,
  onOpenDetail,
}: {
  bot: BotSummary;
  onOpenChat: () => void;
  onOpenDetail: () => void;
}) {
  const status = botStatusLine(bot);

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${bot.name}`}
        onPress={onOpenChat}
        style={({ pressed }) => [styles.rowMain, pressed ? styles.rowPressed : null]}
      >
        <Avatar shape={bot.avatar.shape} color={bot.avatar.color} size={44} label="" />
        <View style={styles.rowText}>
          <View style={styles.rowTitleLine}>
            <Text numberOfLines={1} style={styles.rowName}>
              {bot.name}
            </Text>
            {bot.unread ? <View style={styles.unreadDot} /> : null}
          </View>
          <View style={styles.statusLine}>
            <StatusDot tone={status.tone} />
            <Text numberOfLines={1} style={styles.statusText}>
              {status.text}
            </Text>
          </View>
          {bot.lastMessagePreview ? (
            <Text numberOfLines={1} style={styles.preview}>
              {bot.lastMessagePreview}
            </Text>
          ) : null}
        </View>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${bot.name} details`}
        onPress={onOpenDetail}
        hitSlop={8}
        style={({ pressed }) => [styles.detailButton, pressed ? styles.rowPressed : null]}
      >
        <HugeiconsIcon icon={ChevronRightIcon} size={18} color={color.textFaint} strokeWidth={1.8} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
  },
  title: { ...type.xxl, color: color.text, fontWeight: weight.semiBold },
  accountChip: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    backgroundColor: color.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  accountInitial: { ...type.base, color: color.textSecondary, fontWeight: weight.semiBold },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.card,
    backgroundColor: color.surface1,
  },
  bannerText: { ...type.base, color: color.textSecondary, flex: 1 },
  bannerAction: { ...type.base, color: color.text, fontWeight: weight.medium },
  list: { paddingBottom: space.xxl },
  listEmpty: { flexGrow: 1, justifyContent: "center", paddingHorizontal: space.lg },
  emptyCard: { gap: space.xs },
  emptyTitle: { ...type.md, color: color.text, fontWeight: weight.semiBold },
  emptyBody: { ...type.base, color: color.textMuted },
  row: { flexDirection: "row", alignItems: "center" },
  rowMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm2,
  },
  rowPressed: { backgroundColor: color.surface1 },
  rowText: { flex: 1, gap: 2 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: space.xs2 },
  rowName: { ...type.md, color: color.text, fontWeight: weight.semiBold, flexShrink: 1 },
  unreadDot: { width: 6, height: 6, borderRadius: radius.pill, backgroundColor: color.text },
  statusLine: { flexDirection: "row", alignItems: "center", gap: space.xs2 },
  statusText: { ...type.sm, color: color.textTertiary, flexShrink: 1 },
  preview: { ...type.sm, color: color.textMuted },
  detailButton: {
    width: 40,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    marginRight: space.xs,
    borderRadius: radius.md,
  },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: color.divider, marginLeft: 72 },
});
