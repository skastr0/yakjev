import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Schema } from "effect";
import { Health } from "@yakjev/protocol";
import "./style.css";

function App() {
  const [state, setState] = useState<"checking" | "ready" | "unavailable">(
    "checking",
  );
  useEffect(() => {
    const controller = new AbortController();
    fetch("/healthz", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Server unavailable");
        Schema.decodeUnknownSync(Health)(await response.json());
        setState("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("unavailable");
      });
    return () => controller.abort();
  }, []);
  return (
    <main>
      <header>
        <a href="/" aria-label="yakjev home">
          yakjev
        </a>
        <span>PROJECT SCAFFOLD · 0.0.1</span>
      </header>
      <section>
        <p className="eyebrow">KEEP THE THREAD</p>
        <h1>
          A place for
          <br />
          the whole tangle.
        </h1>
        <p className="intro">
          A lasting map of intentions, dependencies, and the things that get in
          the way.
        </p>
        <p className="status" role="status" data-state={state}>
          {state === "ready"
            ? "Server connected · SQLite ready"
            : state === "checking"
              ? "Checking server…"
              : "Server unavailable · start the API and reload"}
        </p>
      </section>
      <footer>
        <p>
          This is the foundation, not the graph editor yet.
          <br />
          Capture, Jev decisions, and agent access come next.
        </p>
        <a href="https://github.com/skastr0/yakjev">Follow the build ↗</a>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
