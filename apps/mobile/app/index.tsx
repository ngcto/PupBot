import { Redirect } from "expo-router";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useSession } from "../src/session.tsx";
import { color } from "../src/theme.ts";

export default function Index() {
  const { status } = useSession();

  if (status === "loading") {
    return (
      <View style={styles.splash}>
        <ActivityIndicator color={color.textMuted} />
      </View>
    );
  }

  return <Redirect href={status === "signed-in" ? "/(tabs)" : "/sign-in"} />;
}

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: color.bgApp },
});
