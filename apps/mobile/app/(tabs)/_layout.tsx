import { Message01Icon, Settings01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Tabs } from "expo-router";
import { StyleSheet } from "react-native";
import { color, type } from "../../src/theme.ts";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: color.bgApp },
        tabBarStyle: {
          backgroundColor: color.bgApp,
          borderTopColor: color.hairline,
          borderTopWidth: StyleSheet.hairlineWidth,
        },
        tabBarActiveTintColor: color.text,
        tabBarInactiveTintColor: color.textFaint,
        tabBarLabelStyle: { fontSize: type.xs.fontSize },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Bots",
          tabBarIcon: ({ color: tint }) => (
            <HugeiconsIcon icon={Message01Icon} size={22} color={tint} strokeWidth={1.8} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color: tint }) => (
            <HugeiconsIcon icon={Settings01Icon} size={22} color={tint} strokeWidth={1.8} />
          ),
        }}
      />
    </Tabs>
  );
}
