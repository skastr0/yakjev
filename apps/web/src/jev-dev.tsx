import { useEffect, useState } from "react";
import type { JevCall, JevCalls } from "@yakjev/protocol";
import { errorMessage, jevCalls } from "./api";

const POLL_MS = 1500;
const SHOWN = 60;

// Dev panel: every Jev provider call since the server started, with tokens
// and estimated cost. Polls only while open.
export function JevDevPanel({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<JevCalls | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      try {
        const next = await jevCalls();
        if (stopped) return;
        setData(next);
        setError("");
      } catch (cause) {
        if (!stopped) setError(errorMessage(cause));
      }
      if (!stopped) timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);
  return (
    <aside className="jev-dev" aria-label="Jev calls">
      <header>
        <strong>Jev calls</strong>
        {data && <span>since {clock(data.since)}</span>}
        <button type="button" className="text-button" onClick={onClose}>
          Close
        </button>
      </header>
      {error && <p className="jev-dev-error">{error}</p>}
      {data && <Summary data={data} />}
      {data && data.calls.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>time</th>
              <th>for</th>
              <th title="candidates judged">cand</th>
              <th>ms</th>
              <th>in</th>
              <th>out</th>
              <th>$</th>
            </tr>
          </thead>
          <tbody>
            {data.calls.slice(0, SHOWN).map((call, index) => (
              <tr
                key={`${call.at}-${index}`}
                data-failed={call.status === "failed" || undefined}
                title={call.failure ?? call.model ?? ""}
              >
                <td>{clock(call.at)}</td>
                <td>
                  <span className="jev-dev-purpose" data-purpose={call.purpose}>
                    {call.purpose}
                  </span>
                </td>
                <td>{call.candidates}</td>
                <td>{Math.round(call.elapsedMs)}</td>
                <td>{count(call.inputTokens)}</td>
                <td>{count(call.outputTokens)}</td>
                <td>{usd(call.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && data.calls.length === 0 && (
        <p className="jev-dev-empty">No Jev calls yet.</p>
      )}
    </aside>
  );
}

function Summary({ data }: { data: JevCalls }) {
  const { totals } = data;
  const recent = data.calls.filter(
    (call) => Date.now() - Date.parse(call.at) < 60_000,
  ).length;
  const byPurpose = new Map<JevCall["purpose"], number>();
  for (const call of data.calls)
    byPurpose.set(call.purpose, (byPurpose.get(call.purpose) ?? 0) + 1);
  return (
    <div className="jev-dev-summary">
      <dl>
        <div>
          <dt>calls</dt>
          <dd>
            {totals.calls}
            {totals.failed > 0 && <small> · {totals.failed} failed</small>}
          </dd>
        </div>
        <div>
          <dt>last min</dt>
          <dd>{recent}</dd>
        </div>
        <div>
          <dt>avg ms</dt>
          <dd>
            {totals.calls ? Math.round(totals.elapsedMs / totals.calls) : 0}
          </dd>
        </div>
        <div>
          <dt>tokens in / out</dt>
          <dd>
            {count(totals.inputTokens)} / {count(totals.outputTokens)}
          </dd>
        </div>
        <div>
          <dt>cost</dt>
          <dd
            title={
              data.pricing
                ? `$${data.pricing.inputUsdPerMTok} in, $${data.pricing.outputUsdPerMTok} out per million tokens`
                : "Set YAKJEV_JEV_USD_PER_MTOK_INPUT and _OUTPUT on the server"
            }
          >
            {data.pricing ? usd(totals.costUsd) : "no rate set"}
          </dd>
        </div>
      </dl>
      {byPurpose.size > 0 && (
        <p>
          {[...byPurpose].map(([purpose, n]) => `${purpose} ${n}`).join(" · ")}
          {data.calls.length < totals.calls && " (in the log)"}
        </p>
      )}
    </div>
  );
}

export function clock(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString([], { hour12: false });
}

export function count(value: number | null) {
  if (value === null) return "–";
  return value >= 10_000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

export function usd(value: number | null) {
  if (value === null) return "–";
  if (value === 0) return "$0";
  return value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(3)}`;
}
