export type RandomUUID = () => string;

// Resolve at call time so importing shared helpers never requires a DOM or a
// platform crypto implementation. Expo callers can inject expo-crypto.
export const randomUUID: RandomUUID = () => globalThis.crypto.randomUUID();
