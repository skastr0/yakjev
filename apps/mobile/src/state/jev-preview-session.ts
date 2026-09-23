import { errorMessage, type YakjevClient } from "@yakjev/client";
import type { Preview, PreviewRequest } from "@yakjev/protocol";

export type PreviewState = {
  key: string;
  preview: Preview | null;
  loading: boolean;
  error: string | null;
};
export const previewKey = (input: PreviewRequest | null, revision: number) =>
  `${revision}:${JSON.stringify(input)}`;

export class JevPreviewSession {
  private state: PreviewState = {
    key: "",
    preview: null,
    loading: false,
    error: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly cache = new Map<string, Preview>();
  private revision = -1;
  private generation = 0;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly client: Pick<YakjevClient, "preview"> | null,
    private readonly delay = 220,
  ) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(state: PreviewState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  cancel = () => {
    this.generation++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
    this.update({ key: "", preview: null, loading: false, error: null });
  };

  request = (input: PreviewRequest | null, revision: number) => {
    this.cancel();
    const key = previewKey(input, revision);
    if (this.revision !== revision) {
      this.revision = revision;
      this.cache.clear();
    }
    if (
      !this.client ||
      !input ||
      (input.draft && input.draft.title.trim().length < 3)
    ) {
      this.update({ key, preview: null, loading: false, error: null });
      return;
    }
    const cached = this.cache.get(key);
    if (cached) {
      this.update({ key, preview: cached, loading: false, error: null });
      return;
    }
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.update({ key, preview: null, loading: true, error: null });
    const client = this.client;
    this.timer = setTimeout(() => {
      this.timer = null;
      void client.preview(input, controller.signal).then(
        (preview) => {
          if (controller.signal.aborted || generation !== this.generation)
            return;
          if (preview.basedOnRevision !== revision) {
            this.update({
              key,
              preview: null,
              loading: false,
              error: "The graph changed while Jev was checking connections.",
            });
            return;
          }
          if (preview.status === "succeeded") {
            if (this.cache.size >= 64)
              this.cache.delete(this.cache.keys().next().value!);
            this.cache.set(key, preview);
          }
          this.update({
            key,
            preview,
            loading: false,
            error:
              preview.status === "succeeded"
                ? null
                : preview.status === "unavailable"
                  ? "Jev is unavailable."
                  : "Jev could not check these connections.",
          });
        },
        (cause: unknown) => {
          if (!controller.signal.aborted && generation === this.generation)
            this.update({
              key,
              preview: null,
              loading: false,
              error: errorMessage(cause),
            });
        },
      );
    }, this.delay);
  };

  dispose = () => {
    this.cancel();
    this.cache.clear();
    this.listeners.clear();
  };
}
