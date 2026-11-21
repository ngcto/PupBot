import { blockReason, botStatusLine } from "@pupbot/api-client";
import type { ChatMessage } from "@pupbot/api-client";
import { ArrowLeft01Icon, ArrowUp02Icon, ChevronRightIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Avatar } from "../../src/components/avatar.tsx";
import { MessageBubble, StreamingBubble } from "../../src/components/message-bubble.tsx";
import { Card, Screen, StatusDot } from "../../src/components/ui.tsx";
import { useChat } from "../../src/hooks/use-chat.ts";
import { color, radius, space, type, weight } from "../../src/theme.ts";

export default function ChatScreen() {
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const router = useRouter();
  const { bot, state, loading, sending, send, refreshBot, dismissError } = useChat(botId);
  const [draft, setDraft] = useState("");
  const list = useRef<FlatList<ChatMessage>>(null);
  const atBottom = useRef(true);

  useFocusEffect(
    useCallback(() => {
      void refreshBot();
    }, [refreshBot]),
  );

  const status = bot ? botStatusLine(bot) : null;
  const blocked = bot ? blockReason(bot) : null;

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void send(text);
  };

  const rows = state.messages;
  const streaming = state.streaming && !state.streaming.completed ? state.streaming : null;

  return (
    <Screen>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={10}
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={20} color={color.textSecondary} strokeWidth={1.8} />
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${bot?.name ?? "Bot"} details`}
          onPress={() => router.push({ pathname: "/bot/[botId]", params: { botId } })}
          style={styles.headerMain}
        >
          {bot ? <Avatar shape={bot.avatar.shape} color={bot.avatar.color} size={30} label="" /> : null}
          <View style={styles.headerText}>
            <Text numberOfLines={1} style={styles.headerName}>
              {bot?.name ?? "Bot"}
            </Text>
            {status ? (
              <View style={styles.headerStatus}>
                <StatusDot tone={status.tone} />
                <Text numberOfLines={1} style={styles.headerStatusText}>
                  {status.text}
                </Text>
              </View>
            ) : null}
          </View>
          <HugeiconsIcon icon={ChevronRightIcon} size={16} color={color.textFaint} strokeWidth={1.8} />
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        <FlatList
          ref={list}
          data={rows}
          keyExtractor={(message) => message.id}
          contentContainerStyle={styles.messages}
          keyboardShouldPersistTaps="handled"
          onScroll={(event) => {
            const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
            atBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
          }}
          scrollEventThrottle={64}
          onContentSizeChange={() => {
            if (atBottom.current) list.current?.scrollToEnd({ animated: false });
          }}
          ListEmptyComponent={
            loading ? undefined : (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>{bot?.name ?? "This bot"} hasn&apos;t said anything yet.</Text>
                <Text style={styles.emptyBody}>Send a message to get started.</Text>
              </View>
            )
          }
          ListFooterComponent={
            streaming ? (
              <View style={styles.assistantRow}>
                <StreamingBubble text={streaming.text} step={streaming.step} />
              </View>
            ) : (
              <View style={styles.footerSpace} />
            )
          }
          renderItem={({ item }) => (
            <View style={[styles.messageRow, item.role === "user" ? styles.userRow : styles.assistantRow]}>
              <MessageBubble message={item} accentColor={bot?.accentColor ?? color.surface3} />
            </View>
          )}
        />

        {state.error ? (
          <View style={styles.errorBar}>
            <Text style={styles.errorText}>{state.error}</Text>
            <Pressable accessibilityRole="button" onPress={dismissError}>
              <Text style={styles.errorAction}>Dismiss</Text>
            </Pressable>
          </View>
        ) : null}

        {blocked ? (
          <View style={styles.blocker}>
            <Card style={styles.blockerCard}>
              <Text style={styles.blockerText}>{blocked}</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push({ pathname: "/bot/[botId]", params: { botId } })}
              >
                <Text style={styles.blockerAction}>Bot details</Text>
              </Pressable>
            </Card>
          </View>
        ) : (
          <View style={styles.composer}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={sending ? "Sending…" : `Message ${bot?.name ?? ""}`}
              placeholderTextColor={color.textFaint}
              style={styles.input}
              multiline
              maxLength={8000}
              editable={!sending}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send"
              onPress={submit}
              disabled={!draft.trim() || sending}
              style={({ pressed }) => [
                styles.send,
                !draft.trim() || sending ? styles.sendInactive : null,
                pressed ? styles.sendPressed : null,
              ]}
            >
              <HugeiconsIcon
                icon={ArrowUp02Icon}
                size={18}
                color={draft.trim() && !sending ? color.canvas : color.textMuted}
                strokeWidth={2}
              />
            </Pressable>
          </View>
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  backButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  headerMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: space.sm2 },
  headerText: { flex: 1, gap: 1 },
  headerName: { ...type.md, color: color.text, fontWeight: weight.semiBold },
  headerStatus: { flexDirection: "row", alignItems: "center", gap: space.xs2 },
  headerStatusText: { ...type.sm, color: color.textTertiary, flexShrink: 1 },
  messages: { paddingHorizontal: space.lg, paddingVertical: space.lg, gap: space.md, flexGrow: 1 },
  messageRow: { maxWidth: "100%" },
  userRow: { alignItems: "flex-end" },
  assistantRow: { alignItems: "flex-start" },
  footerSpace: { height: space.sm },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.xs, paddingHorizontal: space.xl },
  emptyTitle: { ...type.md, color: color.text, textAlign: "center" },
  emptyBody: { ...type.base, color: color.textMuted, textAlign: "center" },
  errorBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    backgroundColor: color.surface1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.card,
  },
  errorText: { ...type.base, color: color.textSecondary, flex: 1 },
  errorAction: { ...type.base, color: color.text, fontWeight: weight.medium },
  blocker: { paddingHorizontal: space.lg, paddingBottom: space.lg },
  blockerCard: { gap: space.sm },
  blockerText: { ...type.base, color: color.textSecondary },
  blockerAction: { ...type.base, color: color.text, fontWeight: weight.medium },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.sm,
    marginHorizontal: space.md,
    marginBottom: space.md,
    paddingLeft: space.md,
    paddingRight: space.xs,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    backgroundColor: color.surface1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.card,
  },
  input: { flex: 1, ...type.md, color: color.text, maxHeight: 132, paddingTop: space.sm2, paddingBottom: space.sm2 },
  send: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    backgroundColor: color.text,
    alignItems: "center",
    justifyContent: "center",
  },
  sendInactive: { backgroundColor: color.surface4 },
  sendPressed: { opacity: 0.8 },
});
