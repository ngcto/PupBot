import { botStatusLine } from "@pupbot/api-client";
import type { BotDetail } from "@pupbot/api-client";
import { COLORS, SHAPES, colorHex } from "@pupbot/avatars";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { api, errorMessage } from "../../src/api.ts";
import { useSession } from "../../src/session.tsx";
import { Avatar } from "../../src/components/avatar.tsx";
import { Card, Divider, Screen, StatusDot } from "../../src/components/ui.tsx";
import { color, radius, space, type, weight } from "../../src/theme.ts";

export default function BotDetailScreen() {
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const router = useRouter();
  const { status: sessionStatus } = useSession();
  const [bot, setBot] = useState<BotDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      setBot(await api.getBot(botId));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [botId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  const chooseAvatar = async (shape: string, avatarColor: string) => {
    if (!bot || saving) return;
    if (bot.avatar.shape === shape && bot.avatar.color === avatarColor) return;

    const previous = bot;
    setBot({ ...bot, avatar: { shape, color: avatarColor } });
    setSaving(true);
    setError(null);

    try {
      setBot(await api.setAvatar(bot.id, { shape, color: avatarColor }));
      setSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 1600);
    } catch (caught) {
      setBot(previous);
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  if (sessionStatus === "signed-out") return <Redirect href="/sign-in" />;

  if (!bot) {
    return (
      <Screen>
        <View style={styles.loading}>
          {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={color.textMuted} />}
        </View>
      </Screen>
    );
  }

  const status = botStatusLine(bot);

  return (
    <Screen>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={10}
          onPress={() => router.back()}
          style={styles.closeButton}
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={20} color={color.textSecondary} strokeWidth={1.8} />
        </Pressable>
        <Text style={styles.headerTitle}>Bot details</Text>
        <Text style={styles.saved}>{saved ? "Saved" : saving ? "Saving…" : ""}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <Avatar shape={bot.avatar.shape} color={bot.avatar.color} size={96} />
          <Text style={styles.name}>{bot.name}</Text>
          <View style={styles.heroStatus}>
            <StatusDot tone={status.tone} />
            <Text style={styles.heroStatusText}>{status.text}</Text>
          </View>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Avatar</Text>
          <View style={styles.shapeGrid}>
            {SHAPES.map((shape) => {
              const selected = shape.id === bot.avatar.shape;
              return (
                <Pressable
                  key={shape.id}
                  accessibilityRole="button"
                  accessibilityLabel={shape.name}
                  accessibilityState={{ selected }}
                  onPress={() => void chooseAvatar(shape.id, bot.avatar.color)}
                  style={[styles.shapeCell, selected ? styles.shapeSelected : null]}
                >
                  <Avatar shape={shape.id} color={bot.avatar.color} size={38} label="" />
                </Pressable>
              );
            })}
          </View>

          <View style={styles.colorRow}>
            {COLORS.map((entry) => {
              const selected = entry.id === bot.avatar.color;
              return (
                <Pressable
                  key={entry.id}
                  accessibilityRole="button"
                  accessibilityLabel={entry.name}
                  accessibilityState={{ selected }}
                  onPress={() => void chooseAvatar(bot.avatar.shape, entry.id)}
                  style={[styles.colorCell, selected ? styles.colorSelected : null]}
                >
                  <View style={[styles.swatch, { backgroundColor: colorHex(entry.id) }]} />
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Model</Text>
          <Card style={styles.card}>
            {bot.model ? (
              <>
                <DetailRow label="Provider" value={bot.model.endpointLabel} />
                <Divider />
                <DetailRow label="Model" value={bot.model.modelId} />
                <Divider />
                <DetailRow label="Context" value={formatContext(bot.model.contextWindow)} />
              </>
            ) : (
              <Text style={styles.cardEmpty}>
                No model endpoint yet. Pick one in the web app under Settings › Models.
              </Text>
            )}
          </Card>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Computer</Text>
          <Card style={styles.card}>
            {bot.computer ? (
              <>
                <DetailRow label="Status" value={bot.computer.status} />
                <Divider />
                <DetailRow label="Provider" value={bot.computer.provider} />
                <Divider />
                <DetailRow label="Last used" value={formatWhen(bot.computer.lastUsedAt)} />
              </>
            ) : (
              <Text style={styles.cardEmpty}>
                No computer bound. A bot needs a computer to run tools; bind one in the web app.
              </Text>
            )}
          </Card>
        </View>
      </ScrollView>
    </Screen>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text numberOfLines={1} style={styles.rowValue}>
        {value}
      </Text>
    </View>
  );
}

function formatContext(tokens: number | null): string {
  if (!tokens) return "Unknown";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M tokens`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k tokens`;
  return `${tokens} tokens`;
}

function formatWhen(value: string | null): string {
  if (!value) return "Never";
  const then = Date.parse(value);
  if (Number.isNaN(then)) return "Unknown";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    gap: space.sm,
  },
  closeButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  headerTitle: { ...type.md, color: color.text, fontWeight: weight.semiBold, flex: 1 },
  saved: { ...type.sm, color: color.textMuted, width: 56, textAlign: "right" },
  content: { paddingBottom: space.xxl, gap: space.xl },
  hero: { alignItems: "center", gap: space.sm, paddingTop: space.sm },
  name: { ...type.xl, color: color.text, fontWeight: weight.semiBold },
  heroStatus: { flexDirection: "row", alignItems: "center", gap: space.xs2 },
  heroStatusText: { ...type.base, color: color.textTertiary },
  error: { ...type.base, color: color.danger, paddingHorizontal: space.lg },
  section: { gap: space.sm, paddingHorizontal: space.lg },
  sectionLabel: { ...type.sm, color: color.textMuted, fontWeight: weight.medium, letterSpacing: 0.3, textTransform: "uppercase" },
  shapeGrid: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  shapeCell: {
    width: 54,
    height: 54,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.surface1,
    borderWidth: 1,
    borderColor: "transparent",
  },
  shapeSelected: { borderColor: color.text },
  colorRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, paddingTop: space.xs },
  colorCell: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "transparent",
  },
  colorSelected: { borderColor: color.text },
  swatch: { width: 26, height: 26, borderRadius: radius.pill },
  card: { paddingVertical: space.xs, gap: space.xs },
  cardEmpty: { ...type.base, color: color.textMuted, paddingVertical: space.sm },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.lg, paddingVertical: space.sm },
  rowLabel: { ...type.base, color: color.textSecondary },
  rowValue: { ...type.base, color: color.textTertiary, flexShrink: 1, textAlign: "right" },
});
