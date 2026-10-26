// The notes app for phones: write with or without a connection, see what is
// waiting, and see what the server published. Same server as examples/notes.
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useColorScheme } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { API_URL, SETUP_PROBLEM, demoUser, outbox } from "./outbox";
import { useOutboxEntries } from "./use-outbox-entries";
import { useConnected, useNativeAutoFlush } from "./use-native-auto-flush";

const STATUS_TEXT = {
  waiting: "Waiting for a connection",
  sending: "Sending",
  needs_confirmation: "Written more than 30 days ago. Send it now, or discard it?",
  sent: "Sent",
};
const STUCK_TEXT = {
  attempts_exhausted: "Could not be sent. The server kept failing.",
  key_conflict: "The server already has a different note under this key.",
  refused: "The server refused this note.",
  unreachable: "Could not reach the server for a long time.",
};

const when = (iso) => (iso ? new Date(iso).toLocaleString() : "unknown");
const preview = (text) => (text.length > 40 ? `${text.slice(0, 40)}…` : text);

/** Asks before something that may publish a second copy. */
function confirm(message) {
  if (Platform.OS === "web") return Promise.resolve(window.confirm(message));
  return new Promise((resolve) =>
    Alert.alert("Send as a new note?", message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: "Send", onPress: () => resolve(true) },
    ]),
  );
}

/** The published list, with the last good copy kept for offline starts. */
function usePublishedNotes(owner) {
  const [state, setState] = useState({ notes: [], note: "", loaded: false });
  const latest = useRef(0);
  const refresh = useCallback(async () => {
    if (!owner) return;
    const call = ++latest.current;
    const cacheKey = `holdsend-notes-feed:${owner}`;
    try {
      const res = await fetch(`${API_URL}/api/notes`, { headers: { "x-demo-user": owner } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { notes } = await res.json();
      await AsyncStorage.setItem(cacheKey, JSON.stringify(notes)).catch(() => undefined);
      if (call === latest.current) setState({ notes, note: "", loaded: true });
    } catch {
      if (call !== latest.current) return;
      let saved = null;
      try {
        saved = JSON.parse((await AsyncStorage.getItem(cacheKey)) ?? "null");
      } catch {
        /* a missing or damaged copy: show nothing rather than get stuck */
      }
      setState((current) => {
        const notes = current.loaded && current.notes.length > 0 ? current.notes : (saved ?? []);
        return {
          notes,
          note: notes.length > 0 ? "Offline: showing the list as it was last loaded." : "Offline: the published list will load when the connection returns.",
          loaded: true,
        };
      });
    }
  }, [owner]);
  return [state, refresh];
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Notes />
    </SafeAreaProvider>
  );
}

function Notes() {
  const scheme = useColorScheme();
  const colors = scheme === "dark" ? dark : light;
  const [owner, setOwner] = useState(undefined);
  const [userProblem, setUserProblem] = useState("");
  useEffect(() => {
    demoUser().then(setOwner, (err) => setUserProblem(`Could not keep a user id on this device: ${err instanceof Error ? err.message : String(err)}`));
  }, []);

  const connected = useConnected();
  // Until the owner is known, show nothing rather than everyone's notes.
  // Changes made by this app arrive through outbox.subscribe; on a phone the
  // poll is only a safety net, so keep it slow to spare the battery.
  const { entries, loaded: outboxLoaded } = useOutboxEntries(outbox, { owner: owner ?? "", pollMs: Platform.OS === "web" ? 2000 : 30_000 });
  const [published, refreshPublished] = usePublishedNotes(owner);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [loseNote, setLoseNote] = useState("");

  const kick = useNativeAutoFlush(outbox, {
    owner,
    // Never send before we know whose notes to send.
    enabled: owner !== undefined,
    onReport: (report) => {
      if (report !== "skipped" && report.sent > 0) void refreshPublished();
    },
  });

  useEffect(() => {
    if (connected) void refreshPublished();
  }, [connected, refreshPublished]);

  async function act(fn) {
    try {
      setNotice((await fn()) ?? "");
    } catch (err) {
      setNotice(`That did not work: ${err instanceof Error ? err.message : String(err)}`);
    }
    kick();
  }

  const actions = {
    cancel: async (item) =>
      (await outbox.cancel(item.key)) === "in_flight"
        ? "Too late to cancel: this note has started sending and may already be published. It will be finished, not sent twice."
        : undefined,
    approve: async (item) =>
      (await outbox.approve(item.key))?.newKey ? "Sending with a new key. If an earlier version reached the server, there may be two copies." : undefined,
    retry: async (item) => {
      if (item.stuckReason === "key_conflict") {
        const yes = await confirm("The server holds a different note under this note's key. Send this one as a new note? You may end up with two.");
        if (!yes) return undefined;
      }
      await outbox.retry(item.key);
      return undefined;
    },
    discard: async (item) => {
      const result = await outbox.discard(item.key);
      if (result === "discarded_may_exist") return "Removed from this device. An earlier attempt may have reached the server, so check the published list.";
      if (result === "in_flight") return "It is being sent right now. Try again in a moment.";
      return undefined;
    },
  };

  async function onSend() {
    const value = text.trim();
    if (!value || saving || !owner) return;
    setSaving(true);
    try {
      await outbox.add("note.create", { text: value }, { owner });
      setText("");
      kick();
    } catch (err) {
      setNotice(`Could not keep this note on the device: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(id) {
    const res = await fetch(`${API_URL}/api/notes/${id}`, { method: "DELETE", headers: { "x-demo-user": owner } }).catch(() => null);
    setNotice(res?.ok ? "" : "Deleting needs a connection.");
    await refreshPublished();
  }

  async function onLoseAnswer() {
    try {
      const res = await fetch(`${API_URL}/api/demo/lose-next-answer`, { method: "POST", headers: { "x-demo-user": owner } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setLoseNote("The server will save your next note but drop its answer. Watch it still appear once.");
    } catch {
      setLoseNote("Needs a connection.");
    }
  }

  const ready = owner !== undefined && outboxLoaded && published.loaded;
  const s = styles(colors);

  return (
    <SafeAreaView style={s.screen}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" testID="app" dataSet={{ ready: String(ready) }}>
        <Text style={s.h1} accessibilityRole="header">
          HoldSend notes
        </Text>
        <Text style={s.muted}>Write with or without a connection. Notes wait on this device until they are sent, and are never published twice.</Text>
        {SETUP_PROBLEM || userProblem ? (
          <Text testID="setup-problem" accessibilityRole="alert" style={s.warn}>
            {SETUP_PROBLEM || userProblem}
          </Text>
        ) : null}
        <Text testID="connection" accessibilityLiveRegion="polite" style={[s.strong, !connected && s.warn]}>
          {connected ? "Online" : "Offline: notes are kept on this device and sent when the connection returns."}
        </Text>
        <Text style={s.hint}>
          {Platform.OS === "ios"
            ? "On iPhone, waiting notes are sent the next time the app is open with a connection."
            : "Waiting notes are sent while the app is open with a connection."}
        </Text>

        <Text style={s.label} nativeID="text-label">
          New note
        </Text>
        <TextInput
          testID="text"
          accessibilityLabelledBy="text-label"
          style={s.input}
          multiline
          maxLength={2000}
          value={text}
          onChangeText={setText}
          placeholder="What happened?"
          placeholderTextColor={colors.muted}
        />
        <Pressable testID="send" accessibilityRole="button" disabled={saving} onPress={onSend} style={[s.primary, saving && s.disabled]}>
          <Text style={s.primaryText}>Send</Text>
        </Pressable>

        {notice ? (
          <Text testID="notice" accessibilityLiveRegion="polite" style={s.warn}>
            {notice}
          </Text>
        ) : null}

        <Text style={s.h2} accessibilityRole="header">
          Waiting on this device
        </Text>
        {outboxLoaded && entries.length === 0 ? <Text style={s.hint}>Nothing waiting.</Text> : null}
        <View testID="outbox">
          {entries.map(({ item, status }) => (
            <View key={item.key} testID="outbox-item" dataSet={{ status }} style={s.card}>
              <Text testID="note-text" style={s.text}>
                {item.payload.text}
              </Text>
              <Text style={s.hint}>
                {status === "stuck" ? (STUCK_TEXT[item.stuckReason] ?? "Stopped.") : STATUS_TEXT[status]} · written {new Date(item.writtenAt).toLocaleString()}
              </Text>
              <View style={s.row}>
                {status === "waiting" && <ItemButton s={s} label="Cancel" item={item} onPress={() => act(() => actions.cancel(item))} />}
                {status === "needs_confirmation" && <ItemButton s={s} label="Send" item={item} onPress={() => act(() => actions.approve(item))} />}
                {status === "stuck" && <ItemButton s={s} label="Try again" item={item} onPress={() => act(() => actions.retry(item))} />}
                {(status === "stuck" || status === "needs_confirmation") && (
                  <ItemButton s={s} label="Discard" item={item} onPress={() => act(() => actions.discard(item))} />
                )}
              </View>
            </View>
          ))}
        </View>

        <Text style={s.h2} accessibilityRole="header">
          Published
        </Text>
        {published.note ? <Text style={s.hint}>{published.note}</Text> : null}
        {published.loaded && published.notes.length === 0 && !published.note ? <Text style={s.hint}>No notes yet.</Text> : null}
        <View testID="feed">
          {published.notes.map((note) => (
            <View key={note.id} testID="feed-item" style={s.card}>
              <Text testID="note-text" style={s.text}>
                {note.text}
              </Text>
              <Text style={s.hint}>
                Written {when(note.writtenAt)} (the writer&apos;s clock) · arrived {when(note.arrivedAt)}
              </Text>
              <View style={s.row}>
                <ItemButton s={s} label="Delete" item={{ payload: { text: note.text } }} onPress={() => onDelete(note.id)} />
              </View>
            </View>
          ))}
        </View>

        <Text style={s.h2} accessibilityRole="header">
          Try to break it
        </Text>
        <Text style={s.hint}>Turn on airplane mode, write a few notes, close the app, open it again, then turn airplane mode off. Or:</Text>
        <Pressable testID="lose-answer" accessibilityRole="button" onPress={onLoseAnswer} style={s.secondary}>
          <Text style={s.text}>Lose the answer to my next note</Text>
        </Pressable>
        {loseNote ? (
          <Text testID="lose-answer-note" style={s.hint}>
            {loseNote}
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function ItemButton({ s, label, item, onPress }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${preview(item.payload.text)}`} onPress={onPress} style={s.secondary}>
      <Text style={s.text}>{label}</Text>
    </Pressable>
  );
}

const light = { bg: "#f7f6f2", card: "#ffffff", text: "#1d1d1b", muted: "#5f5e58", line: "#dedcd3", accent: "#1f5f8b", warn: "#8a4b00" };
const dark = { bg: "#161614", card: "#1f1f1c", text: "#ecebe6", muted: "#a6a59d", line: "#34332e", accent: "#7db7e0", warn: "#e6a457" };

const styles = (c) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.bg },
    content: { padding: 16, paddingBottom: 48, gap: 8, maxWidth: 640, width: "100%", alignSelf: "center" },
    h1: { fontSize: 24, fontWeight: "700", color: c.text },
    h2: { fontSize: 17, fontWeight: "600", color: c.text, marginTop: 20 },
    text: { color: c.text, fontSize: 16 },
    strong: { color: c.text, fontSize: 16, fontWeight: "600" },
    muted: { color: c.muted, fontSize: 16 },
    hint: { color: c.muted, fontSize: 14 },
    warn: { color: c.warn },
    label: { color: c.text, marginTop: 12 },
    input: { minHeight: 96, padding: 10, borderWidth: 1, borderColor: c.line, borderRadius: 8, backgroundColor: c.card, color: c.text, textAlignVertical: "top", fontSize: 16 },
    primary: { alignSelf: "flex-start", backgroundColor: c.accent, paddingVertical: 10, paddingHorizontal: 18, borderRadius: 8, minHeight: 44, justifyContent: "center" },
    primaryText: { color: c.bg, fontWeight: "600", fontSize: 16 },
    disabled: { opacity: 0.5 },
    secondary: { borderWidth: 1, borderColor: c.line, backgroundColor: c.card, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, minHeight: 44, justifyContent: "center" },
    card: { backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: 12, gap: 6, marginBottom: 8 },
    row: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  });
