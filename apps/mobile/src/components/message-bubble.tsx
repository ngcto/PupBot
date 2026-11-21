import { messageQuote, messageText } from "@terabot/api-client";
import type { ChatMessage } from "@terabot/api-client";
import { deriveAccent } from "@terabot/avatars";
import { StyleSheet, Text, View } from "react-native";
import { color, radius, space, type } from "../theme.ts";

/**
 * The one component the libraries do not cover: a message bubble. It is small,
 * single purpose, and it is the shape the product's chat is recognised by — the
 * user turn is the avatar colour with the measured accent tint, the assistant
 * turn is plain text, exactly as `apps/web/components/message-bubble.tsx` draws it.
 */
export function MessageBubble({ message, accentColor }: { message: ChatMessage; accentColor: string }) {
  const text = messageText(message);
  const quote = messageQuote(message);

  if (message.role === "user") {
    return (
      <View style={[styles.user, { backgroundColor: deriveAccent(accentColor) }]}>
        {quote ? <Text style={styles.quote}>{quote}</Text> : null}
        <Text style={styles.userText}>{text}</Text>
      </View>
    );
  }

  return (
    <View style={styles.assistant}>
      <Text style={[styles.assistantText, message.status === "error" ? styles.failed : null]}>{text}</Text>
    </View>
  );
}

export function StreamingBubble({ text, step }: { text: string; step: string | null }) {
  return (
    <View style={styles.assistant}>
      {text ? (
        <Text style={styles.assistantText}>{text}</Text>
      ) : (
        <Text style={styles.step}>{step ?? "Thinking…"}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  user: {
    maxWidth: "82%",
    alignSelf: "flex-end",
    borderRadius: radius.lg,
    paddingHorizontal: space.md,
    paddingVertical: 7,
    gap: space.xs,
  },
  userText: { ...type.body, color: color.onAccent },
  quote: {
    ...type.sm,
    color: color.onAccent,
    opacity: 0.7,
    borderLeftWidth: 2,
    borderLeftColor: color.onAccent,
    paddingLeft: space.sm,
  },
  assistant: { maxWidth: "92%", alignSelf: "flex-start", paddingVertical: 2 },
  assistantText: { ...type.body, color: color.text },
  failed: { color: color.danger },
  step: { ...type.body, color: color.textMuted },
});
