export function launchEnvironment(userData: string): Record<string, string> {
  // Preserve only OS facilities needed by Electron. Provider, owner, and
  // deployment credentials cannot enter either disposable child process.
  const env: Record<string, string> = {
    NODE_ENV: "test",
    YAKJEV_DESKTOP_USER_DATA: userData,
  };
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "SystemRoot",
    "WINDIR",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
