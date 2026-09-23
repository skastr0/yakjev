export const CONNECT_CHANNEL = "yakjev:connect";

export type ConnectionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export interface YakjevDesktopBridge {
  readonly connect: (origin: string) => Promise<ConnectionResult>;
}
