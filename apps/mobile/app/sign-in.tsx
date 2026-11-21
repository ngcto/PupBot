import { Redirect, useRouter } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { errorMessage } from "../src/api.ts";
import { PrimaryButton, Screen, TextField } from "../src/components/ui.tsx";
import { useSession } from "../src/session.tsx";
import { color, radius, space, type, weight } from "../src/theme.ts";

export default function SignInScreen() {
  const { status, signIn } = useSession();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === "signed-in") return <Redirect href="/(tabs)" />;

  const submit = async () => {
    if (!email.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      router.replace("/(tabs)");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.mark}>
            <View style={styles.dot} />
          </View>

          <View style={styles.heading}>
            <Text style={styles.title}>Terabot</Text>
            <Text style={styles.subtitle}>Your bots, on your phone.</Text>
          </View>

          <View style={styles.form}>
            <TextField
              label="Email"
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              keyboardType="email-address"
              textContentType="emailAddress"
              autoComplete="email"
              returnKeyType="next"
            />
            <TextField
              label="Password"
              value={password}
              onChangeText={setPassword}
              placeholder="Your password"
              secureTextEntry
              textContentType="password"
              autoComplete="current-password"
              returnKeyType="go"
              onSubmitEditing={submit}
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <PrimaryButton
              label="Sign in"
              onPress={submit}
              busy={busy}
              disabled={!email.trim() || !password}
            />
            <Text style={styles.hint}>
              The same account as the web app. Your session is stored in the device keychain.
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: space.xl,
    paddingVertical: space.xxxl,
    gap: space.xl,
  },
  mark: {
    width: 56,
    height: 56,
    borderRadius: radius.xl,
    backgroundColor: color.surface1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.card,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
  },
  dot: { width: 18, height: 18, borderRadius: radius.pill, backgroundColor: color.text },
  heading: { alignItems: "center", gap: space.xs },
  title: { ...type.xxl, color: color.text, fontWeight: weight.semiBold },
  subtitle: { ...type.body, color: color.textMuted },
  form: { gap: space.md },
  error: { ...type.base, color: color.danger },
  hint: { ...type.sm, color: color.textFaint, textAlign: "center", paddingTop: space.xs },
});
