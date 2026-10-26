// The outbox for the app: created once, outside React.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import { Platform } from "react-native";
import { Outbox, classifyResponse } from "@holdsend/core";
import { KeyValueStore } from "@holdsend/react-native";

/**
 * Where the notes example's server runs. The web build is served by that
 * server, so the same origin works there. On a phone "localhost" is the phone
 * itself: set EXPO_PUBLIC_NOTES_URL to your computer's address on the same
 * network, such as http://YOUR-COMPUTER-ADDRESS:3000 (see README.md).
 */
export const API_URL = (process.env.EXPO_PUBLIC_NOTES_URL ?? "").replace(/\/+$/, "");

/** A setup problem to show on screen instead of failing quietly, or null. */
export const SETUP_PROBLEM =
  Platform.OS !== "web" && API_URL === ""
    ? "Set EXPO_PUBLIC_NOTES_URL to your computer's address on this network (http://<address>:3000) and restart Expo. Notes are kept on this device until then."
    : null;

let userPromise = null;

/**
 * The demo's stand-in for signing in: a random id kept on this device. One
 * shared promise, so two callers at first launch get the same id.
 */
export function demoUser() {
  userPromise ??= (async () => {
    const key = "holdsend-notes-user";
    const saved = await AsyncStorage.getItem(key);
    if (saved) return saved;
    const id = `demo-${randomUUID()}`;
    await AsyncStorage.setItem(key, id); // if this fails, say so rather than use an id that will not last
    return id;
  })();
  userPromise.catch(() => {
    userPromise = null; // let the next call try again
  });
  return userPromise;
}

/** Posts one note. The outbox adds the Idempotency-Key and Written-At headers. */
async function sendNote(item, { headers, signal }) {
  const res = await fetch(`${API_URL}/api/notes`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers, "x-demo-user": item.owner },
    body: JSON.stringify(item.payload),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  return classifyResponse(res.status, body.code, body.message);
}

/** The whole queue lives under one AsyncStorage key; writes over 1.5 MB are refused (see @holdsend/react-native). */
export const store = new KeyValueStore(AsyncStorage, { key: "holdsend-notes-example" });

// expo-crypto gives a strong random key on every platform, including
// Hermes builds without crypto.randomUUID.
export const outbox = new Outbox({ store, send: sendNote, newKey: randomUUID });
