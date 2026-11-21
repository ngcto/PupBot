import type { StatusTone } from "@terabot/api-client";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { StyleProp, TextInputProps, ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { color, radius, space, type, weight } from "../theme.ts";

export function Screen({ children, edges }: { children: ReactNode; edges?: ("top" | "bottom")[] }) {
  return (
    <SafeAreaView style={styles.screen} edges={edges ?? ["top"]}>
      {children}
    </SafeAreaView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Divider() {
  return <View style={styles.divider} />;
}

export function ScreenTitle({ children, subtitle }: { children: ReactNode; subtitle?: string }) {
  return (
    <View style={styles.titleBlock}>
      <Text style={styles.title}>{children}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
  busy,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(inactive), busy: Boolean(busy) }}
      onPress={onPress}
      disabled={inactive}
      style={({ pressed }) => [
        styles.button,
        pressed && !inactive ? styles.buttonPressed : null,
        inactive ? styles.buttonInactive : null,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={color.text} /> : <Text style={styles.buttonLabel}>{label}</Text>}
    </Pressable>
  );
}

export function TextField({ label, ...rest }: TextInputProps & { label: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        placeholderTextColor={color.textFaint}
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
        {...rest}
      />
    </View>
  );
}

const toneColors: Record<StatusTone, string> = {
  working: color.focus,
  awake: color.success,
  sleeping: color.textFaint,
  warning: color.warning,
  idle: color.textMuted,
};

/** A live status dot. Only the "working" tone breathes, so the row reads at a glance. */
export function StatusDot({ tone }: { tone: StatusTone }) {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (tone !== "working") {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 600, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, tone]);

  return <Animated.View style={[styles.dot, { backgroundColor: toneColors[tone], opacity: pulse }]} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgApp },
  card: {
    backgroundColor: color.surface1,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.card,
    padding: space.md,
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: color.divider },
  titleBlock: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.xs },
  title: { ...type.xxl, color: color.text, fontWeight: weight.semiBold },
  subtitle: { ...type.base, color: color.textMuted },
  button: {
    height: 46,
    borderRadius: radius.pill,
    backgroundColor: color.surface3,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.lg2,
  },
  buttonPressed: { backgroundColor: color.surface4 },
  buttonInactive: { opacity: 0.45 },
  buttonLabel: { ...type.md, color: color.text, fontWeight: weight.semiBold },
  field: { gap: space.xs2 },
  fieldLabel: { ...type.sm, color: color.textMuted, fontWeight: weight.medium },
  input: {
    ...type.md,
    color: color.text,
    backgroundColor: color.surface1,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.input,
    paddingHorizontal: space.md,
    paddingVertical: space.sm2,
  },
  dot: { width: 7, height: 7, borderRadius: radius.pill },
});
