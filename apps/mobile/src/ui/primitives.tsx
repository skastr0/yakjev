import type { PropsWithChildren } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { color, styles } from "./theme";

export function ChangedElsewhere({ onReload }: { onReload: () => void }) {
  return (
    <View style={styles.section}>
      <Text accessibilityRole="alert" style={styles.error}>
        This was edited in another client. Reload the latest version before
        saving.
      </Text>
      <Button onPress={onReload}>Reload latest · discard this draft</Button>
    </View>
  );
}

export function Button({
  children,
  onPress,
  disabled,
  primary,
  selected,
  quiet,
  label,
}: PropsWithChildren<{
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  selected?: boolean;
  quiet?: boolean;
  label?: string;
}>) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, selected: !!selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary && styles.primary,
        selected && styles.chosen,
        quiet && styles.quiet,
        disabled && styles.disabled,
        pressed && { opacity: 0.65 },
      ]}
    >
      <Text style={[styles.buttonText, primary && styles.primaryText]}>
        {children}
      </Text>
    </Pressable>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={color.muted}
        selectionColor={color.jev}
        {...props}
        style={[styles.field, props.multiline && styles.multiline, props.style]}
      />
    </View>
  );
}

export function Sheet({
  title,
  onClose,
  children,
  scroll = true,
}: PropsWithChildren<{
  title: string;
  onClose: () => void;
  scroll?: boolean;
}>) {
  const insets = useSafeAreaInsets();
  const content = (
    <View
      style={{
        paddingHorizontal: 20,
        paddingBottom: Math.max(insets.bottom, 16),
        gap: 16,
      }}
    >
      {children}
    </View>
  );
  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <Pressable
          accessibilityLabel="Close editor"
          onPress={onClose}
          style={{ flex: 1, minHeight: 50, backgroundColor: "#203d3510" }}
        />
        <View
          accessibilityViewIsModal
          style={{
            maxHeight: "82%",
            backgroundColor: color.paper,
            borderTopWidth: 1,
            borderColor: color.line,
            borderTopLeftRadius: 18,
            borderTopRightRadius: 18,
          }}
        >
          <View
            style={{
              width: 32,
              height: 4,
              backgroundColor: color.line,
              borderRadius: 3,
              alignSelf: "center",
              marginTop: 8,
            }}
          />
          <View
            style={[
              styles.row,
              {
                paddingHorizontal: 20,
                paddingTop: 6,
                paddingBottom: 12,
                justifyContent: "space-between",
              },
            ]}
          >
            <Text
              accessibilityRole="header"
              style={[styles.title, { fontSize: 25, flexShrink: 1 }]}
            >
              {title}
            </Text>
            <Button onPress={onClose} quiet label="Close editor">
              Close
            </Button>
          </View>
          {scroll ? (
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentInsetAdjustmentBehavior="automatic"
            >
              {content}
            </ScrollView>
          ) : (
            content
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function JevNote({
  loading,
  text,
}: {
  loading?: boolean;
  text: string;
}) {
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.row, { alignItems: "flex-start" }]}
    >
      <View
        style={{
          width: 6,
          height: 6,
          marginTop: 7,
          borderRadius: 3,
          backgroundColor: color.jev,
          opacity: loading ? 0.45 : 1,
        }}
      />
      <Text style={[styles.note, { color: color.jev, flex: 1 }]}>{text}</Text>
    </View>
  );
}
