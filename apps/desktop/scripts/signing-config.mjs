// Public builds never discover or select a signing identity. Maintainers must
// explicitly supply these values from private local configuration.
export function signingConfig(env = process.env) {
  const team = env.YAKJEV_MAC_TEAM_ID ?? "";
  const identity = env.YAKJEV_MAC_SIGNING_IDENTITY ?? "";
  if (!/^[A-Z0-9]{10}$/.test(team))
    throw new Error(
      "YAKJEV_MAC_TEAM_ID must be an explicit 10-character team ID",
    );
  if (
    !identity.startsWith("Developer ID Application: ") ||
    !identity.endsWith(` (${team})`) ||
    /[\r\n\0]/.test(identity)
  )
    throw new Error("YAKJEV_MAC_SIGNING_IDENTITY must match the explicit team");
  return {
    team,
    identity,
    builderIdentity: identity.slice("Developer ID Application: ".length),
  };
}

export function buildEnvironment(env = process.env) {
  const result = { CSC_IDENTITY_AUTO_DISCOVERY: "false" };
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
  ]) {
    if (env[key] !== undefined) result[key] = env[key];
  }
  return result;
}
