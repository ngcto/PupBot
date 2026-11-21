import { createApiClient } from "@pupbot/api-client";
import type { FetchLike, SessionStore } from "@pupbot/api-client";
import { fetch as expoFetch } from "expo/fetch";
import * as SecureStore from "expo-secure-store";

/**
 * Where the API lives. Point `EXPO_PUBLIC_API_URL` at a reachable host for a
 * device: `localhost` on a phone is the phone, not the machine running the API.
 */
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8787";

const COOKIE_KEY = "terabot.mobile.session";

/**
 * `expo-secure-store` is the keychain/keystore, not AsyncStorage: the session
 * cookie never sits in plain files.
 */
export const secureSessionStore: SessionStore = {
  read: () => SecureStore.getItemAsync(COOKIE_KEY),
  write: async (cookie) => {
    await SecureStore.setItemAsync(COOKIE_KEY, cookie);
  },
  clear: async () => {
    await SecureStore.deleteItemAsync(COOKIE_KEY);
  },
};

const listeners = new Set<() => void>();

/** Fired when the API says the stored session is gone; the app returns to sign-in. */
export function onUnauthorized(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const api = createApiClient({
  baseUrl: API_URL,
  session: secureSessionStore,
  fetch: expoFetch as unknown as FetchLike,
  onUnauthorized: () => {
    for (const listener of listeners) listener();
  },
});

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Try again.";
}
