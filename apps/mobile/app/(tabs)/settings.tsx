import { Logout01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import Constants from "expo-constants";
import { Redirect } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { API_URL } from "../../src/api.ts";
import { Card, Divider, PrimaryButton, Screen, ScreenTitle } from "../../src/components/ui.tsx";
import { useSession } from "../../src/session.tsx";
import { color, radius, space, type, weight } from "../../src/theme.ts";

const APP_VERSION = Constants.expoConfig?.version ?? "1.0.0";

export default function SettingsScreen() {
  const { status, user, signOut } = useSession();
  const [busy, setBusy] = useState(false);

  if (status === "signed-out") return <Redirect href="/sign-in" />;

  const confirmSignOut = () => {
    Alert.alert("Sign out?", "You will need your email and password to sign back in.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: () => {
          setBusy(true);
          void signOut().finally(() => setBusy(false));
        },
      },
    ]);
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <ScreenTitle>Settings</ScreenTitle>

        <Card style={styles.account}>
          <View style={styles.avatar}>
            <Text style={styles.initial}>{(user?.name ?? "?").slice(0, 1).toUpperCase()}</Text>
          </View>
          <View style={styles.accountText}>
            <Text numberOfLines={1} style={styles.name}>
              {user?.name ?? "Signed in"}
            </Text>
            <Text numberOfLines={1} style={styles.email}>
              {user?.email ?? ""}
            </Text>
          </View>
        </Card>

        <Card style={styles.group}>
          <Row label="App version" value={APP_VERSION} />
          <Divider />
          <Row label="API server" value={API_URL} mono />
        </Card>

        <Pressable
          accessibilityRole="button"
          onPress={confirmSignOut}
          disabled={busy}
          style={({ pressed }) => [styles.signOut, pressed ? styles.signOutPressed : null]}
        >
          <HugeiconsIcon icon={Logout01Icon} size={18} color={color.danger} strokeWidth={1.8} />
          <Text style={styles.signOutLabel}>{busy ? "Signing out…" : "Sign out"}</Text>
        </Pressable>

        <Text style={styles.footnote}>
          Models, endpoints and computers are configured in the web app. This build shows the same account and
          the same bots.
        </Text>
      </ScrollView>
    </Screen>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text numberOfLines={1} style={[styles.rowValue, mono ? styles.mono : null]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: space.xxl, gap: space.lg },
  account: { flexDirection: "row", alignItems: "center", gap: space.md, marginHorizontal: space.lg },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: color.surface3,
    alignItems: "center",
    justifyContent: "center",
  },
  initial: { ...type.lg, color: color.text, fontWeight: weight.semiBold },
  accountText: { flex: 1, gap: 2 },
  name: { ...type.md, color: color.text, fontWeight: weight.semiBold },
  email: { ...type.base, color: color.textMuted },
  group: { marginHorizontal: space.lg, paddingVertical: space.xs, gap: space.xs },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.lg, paddingVertical: space.sm },
  rowLabel: { ...type.base, color: color.textSecondary },
  rowValue: { ...type.base, color: color.textTertiary, flexShrink: 1, textAlign: "right" },
  mono: { fontFamily: "monospace", fontSize: 12 },
  signOut: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    marginHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.pill,
    backgroundColor: color.surface1,
  },
  signOutPressed: { backgroundColor: color.surface2 },
  signOutLabel: { ...type.md, color: color.danger, fontWeight: weight.medium },
  footnote: { ...type.sm, color: color.textFaint, paddingHorizontal: space.lg, lineHeight: 18 },
});
