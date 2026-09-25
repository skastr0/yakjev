import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SERVER_URL } from "../state/server-url";
import { Button, Field } from "./primitives";
import { color, styles } from "./theme";

export function ConnectScreen({
  loading,
  error,
  onConnect,
}: {
  loading: boolean;
  error: string | null;
  onConnect: (url: string, token: string) => Promise<boolean>;
}) {
  const [url, setUrl] = useState(SERVER_URL ?? "");
  const [changingServer, setChangingServer] = useState(!SERVER_URL);
  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  async function connect() {
    if (!url.trim() || !token.trim() || connecting) return;
    setConnecting(true);
    const ok = await onConnect(url.trim(), token.trim());
    setConnecting(false);
    if (ok) setToken("");
  }
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.app}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 24, paddingTop: 64, flexGrow: 1 }}
      >
        <Text style={[styles.title, { fontSize: 42, lineHeight: 47 }]}>
          A place for{"\n"}the whole tangle.
        </Text>
        <Text
          style={[
            styles.note,
            { marginTop: 24, marginBottom: 32, maxWidth: 380 },
          ]}
        >
          Your intentions, connected. Open your existing Yakjev graph and pick
          up where you left off.
        </Text>
        {loading ? (
          <ActivityIndicator
            accessibilityLabel="Restoring connection"
            color={color.ink}
          />
        ) : (
          <View style={{ gap: 20, maxWidth: 520 }}>
            <Field
              label="Owner access token"
              value={token}
              onChangeText={setToken}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={() => void connect()}
            />
            <Text style={styles.note}>
              Your token stays in this device’s secure storage.
            </Text>
            {error && (
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
            )}
            <Button
              primary
              disabled={connecting || !url.trim() || !token.trim()}
              onPress={() => void connect()}
            >
              {connecting ? "Connecting…" : "Open graph"}
            </Button>
            <Text style={styles.note}>
              {changingServer
                ? "Connect to another Yakjev server."
                : url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
            </Text>
            {changingServer && (
              <Field
                label="Server address"
                placeholder="https://yakjev.your-tailnet.ts.net"
                value={url}
                onChangeText={setUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                textContentType="URL"
              />
            )}
            <Button quiet onPress={() => setChangingServer((value) => !value)}>
              {changingServer ? "Hide server address" : "Change server"}
            </Button>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
