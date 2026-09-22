#!/usr/bin/env bun
// Opt-in browser acceptance driver: real Chromium (agent-browser), real server,
// disposable synthetic data. Orb-only; never runs in CI and never touches a
// deployed instance.
//
//   bun tests/acceptance/browser/run.ts            # full loop
//   bun tests/acceptance/browser/run.ts --discover # inspect the page and exit
//   bun tests/acceptance/browser/run.ts --only=J   # only steps named J*
//
// Every step reports PASS, FAIL, or BLOCKED with the reason. BLOCKED means the
// driver could not locate a surface it needs; it is never reported as a pass.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  edgeById,
  edgeBetween,
  neighborhood,
  nodeById,
  readGraph,
  sendCommand,
} from "../contract";
import {
  capture as captureFixture,
  edges as fixtureEdges,
  nodes as fixtureNodes,
  optionalRelationId,
  reframeEdgeId,
  suggestion as fixtureSuggestion,
} from "../fixtures";
import { startServer, type ServerHandle } from "../harness";
import { callTool, openSession } from "../mcp";

const session = process.env.AGENT_BROWSER_SESSION ?? "yakjev-accept";
const artifacts = resolve(import.meta.dir, "../../../.amp/in/artifacts");
const discover = process.argv.includes("--discover");
// Run only steps whose name starts with the prefix, e.g. --only=J for the
// self-contained live Jev checks (they use their own server and login).
const only = process.argv
  .find((value) => value.startsWith("--only="))
  ?.slice("--only=".length);
const devToken = "synthetic-yakjev-owner-token-local-only";
const wrongToken = "synthetic-wrong-token-value";

type Status = "pass" | "fail" | "blocked";
type Step = {
  name: string;
  status: Status;
  detail: string;
  artifacts: string[];
  ms?: number;
};

const steps: Step[] = [];
const shots: string[] = [];

function record(step: Step): void {
  steps.push(step);
  const icon = step.status === "pass" ? "ok" : step.status;
  console.log(
    `[${icon}] ${step.name}${step.ms === undefined ? "" : ` (${step.ms}ms)`} — ${step.detail}`,
  );
}

async function run(
  name: string,
  body: () => Promise<Omit<Step, "name" | "status">>,
): Promise<void> {
  if (only && !name.startsWith(only)) return;
  const started = Date.now();
  try {
    const result = await body();
    record({ name, status: "pass", ms: Date.now() - started, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const blocked = message.startsWith("BLOCKED");
    record({
      name,
      status: blocked ? "blocked" : "fail",
      detail: message.replace(/^BLOCKED:?\s*/, ""),
      artifacts: [],
      ms: Date.now() - started,
    });
  }
}

function blocked(reason: string): never {
  throw new Error(`BLOCKED: ${reason}`);
}

// ---------------------------------------------------------------- agent-browser

async function sh(cmd: string[], allowFailure = false): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const clean = `${stdout}\n${stderr}`
    .split("\n")
    .filter((line) => !line.startsWith("[agent-browser]"))
    .join("\n")
    .trim();
  if (code !== 0 && !allowFailure) {
    throw new Error(`command failed (${code}): ${cmd.join(" ")}\n${clean}`);
  }
  return clean;
}

async function ab(args: string[], allowFailure = false): Promise<string> {
  return sh(
    ["agent-browser", "--session", session, "--restore", ...args],
    allowFailure,
  );
}

async function js<T>(expression: string): Promise<T> {
  // The CLI prints the resolved value JSON-encoded, so wrap only to await the
  // expression. Wrapping in JSON.stringify would double-encode it.
  const raw = await ab(["eval", `(async () => (${expression}))()`]);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`eval did not return JSON: ${expression}\n${raw}`);
  }
}

async function screenshot(name: string): Promise<string> {
  const path = join(artifacts, `${name}.png`);
  await ab(["screenshot", path]);
  shots.push(path);
  return path;
}

async function screenshotElement(
  selector: string,
  name: string,
): Promise<string> {
  const path = join(artifacts, `${name}.png`);
  await ab(["screenshot", selector, path]);
  shots.push(path);
  return path;
}

async function frame(): Promise<void> {
  await ab([
    "eval",
    "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
  ]);
}

// `agent-browser find <locator> <value> <action> [--options]`: the action comes
// before any option flag, and a miss prints a marker while still exiting 0.
function found(output: string): boolean {
  return output.length > 0 && !/No element found|Unknown action/i.test(output);
}

async function findClick(
  base: string[],
  options: string[] = [],
): Promise<boolean> {
  return found(await ab(["find", ...base, "click", ...options], true));
}

async function findText(
  base: string[],
  options: string[] = [],
): Promise<string | undefined> {
  const result = await ab(["find", ...base, "text", ...options], true);
  return found(result) ? result : undefined;
}

async function fillLabel(label: string, value: string): Promise<boolean> {
  return found(await ab(["find", "label", label, "fill", value], true));
}

async function clickButton(name: string): Promise<boolean> {
  return findClick(["role", "button"], ["--name", name]);
}

/** Click the node, connection, or suggestion card whose text contains the text. */
async function clickCard(text: string): Promise<boolean> {
  return js<boolean>(`(() => {
    const wanted = ${JSON.stringify(text)};
    const cards = Array.from(
      document.querySelectorAll(".connection-card, .node-card"),
    );
    const target = cards.find((card) =>
      (card.textContent || "").replace(/\\s+/g, " ").includes(wanted),
    );
    if (!target) return false;
    target.click();
    return true;
  })()`);
}

/** Select an option in the select inside the label whose text starts with label. */
async function selectByLabel(label: string, value: string): Promise<boolean> {
  const id = await js<string | null>(`(() => {
    const wanted = ${JSON.stringify(label)};
    const label = Array.from(document.querySelectorAll("label")).find((item) =>
      (item.textContent || "").trim().startsWith(wanted),
    );
    const select = label ? label.querySelector("select") : null;
    if (!select) return null;
    select.id = "yakjev-e2e-" + wanted.replace(/\\W+/g, "-").toLowerCase();
    return select.id;
  })()`);
  if (!id) return false;
  const result = await ab(["select", `#${id}`, value], true);
  return !/not found|error/i.test(result);
}

// ---------------------------------------------------------------- pixel checks

type CanvasDiff = { pixels: number; fraction: number };

/**
 * Count rendered node discs from canvas pixels. Nodes are drawn in one colour, so
 * overlapping discs merge into larger blobs: a collapsed layout shows fewer,
 * bigger blobs even when the graph-space positions look reasonable.
 */
async function discCensus(
  shot: string,
): Promise<{ discs: number; merged: number }> {
  const raw = await sh(
    [
      "magick",
      shot,
      "-fuzz",
      "6%",
      "-fill",
      "white",
      "-opaque",
      "#396354",
      "-fill",
      "black",
      "+opaque",
      "white",
      "-define",
      "connected-components:verbose=true",
      "-connected-components",
      "8",
      "null:",
    ],
    true,
  );
  let discs = 0;
  let merged = 0;
  for (const line of raw.split("\n")) {
    const match = line.match(
      /^\s*\d+:\s+(\d+)x(\d+)\+\d+\+\d+\s+[\d.,]+\s+(\d+)\s+srgb\(255,255,255\)/,
    );
    if (!match) continue;
    const width = Number(match[1]);
    const height = Number(match[2]);
    const area = Number(match[3]);
    // Ignore text/antialiasing specks, then distinguish discs by geometry.
    // Overlapping discs can have the same area as one disc or fall between
    // area bands, but extend beyond a single 2x-rendered node's diameter.
    if (area < 400) continue;
    if (Math.max(width, height) <= 40) discs += 1;
    else merged += 1;
  }
  return { discs, merged };
}

async function diffCanvas(before: string, after: string): Promise<CanvasDiff> {
  const metric = await sh(
    [
      "magick",
      "compare",
      "-metric",
      "AE",
      "-fuzz",
      "2%",
      before,
      after,
      "null:",
    ],
    true,
  );
  const match = metric.match(/\d+(\.\d+)?/);
  const changed = match ? Number(match[0]) : Number.NaN;
  const dims = await sh(["magick", "identify", "-format", "%w %h", before]);
  const [width, height] = dims.trim().split(" ").map(Number);
  if (!Number.isFinite(changed) || !width || !height) {
    throw new Error(`could not diff ${before} and ${after}: ${metric}`);
  }
  return { pixels: changed, fraction: changed / (width * height) };
}

async function changedFraction(before: string, after: string): Promise<number> {
  return (await diffCanvas(before, after)).fraction;
}

async function waitForSelector(
  selector: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const present = await js<boolean>(
      `!!document.querySelector(${JSON.stringify(selector)})`,
    );
    if (present) return true;
    await Bun.sleep(150);
  }
  return false;
}

/** A node's CSS-pixel anchor via the canvas test hook (window.__yakjevCanvas). */
async function nodeAnchor(
  id: string,
): Promise<{ x: number; y: number } | null> {
  return js<{ x: number; y: number } | null>(
    `window.__yakjevCanvas?.anchorNode(${JSON.stringify(id)}) ?? null`,
  );
}

/**
 * Trusted shift-drag between two canvas points. Sigma ignores JS-dispatched
 * mouse events and agent-browser's own mouse commands cannot hold a modifier,
 * so this drives raw CDP Input.dispatchMouseEvent with the Shift bitmask (8).
 */
async function cdpShiftDrag(
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const cdpUrl = (await ab(["get", "cdp-url"])).trim();
  const port = await js<string>("location.port");
  const ws = new WebSocket(cdpUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("CDP WebSocket failed to open"));
  });
  try {
    let nextId = 0;
    const pending = new Map<number, (value: never) => void>();
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: never;
      };
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)!(message.result as never);
        pending.delete(message.id);
      }
    };
    const send = (
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ) =>
      new Promise<// eslint-disable-next-line @typescript-eslint/no-explicit-any
      any>((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        ws.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
        );
      });
    const targets = await send("Target.getTargets");
    const page = targets.targetInfos.find(
      (target: { type: string; url: string }) =>
        target.type === "page" && target.url.includes(`127.0.0.1:${port}`),
    );
    if (!page)
      throw new Error("no CDP page target for the current acceptance page");
    const attached = await send("Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    });
    const mouse = (
      type: string,
      x: number,
      y: number,
      extra: Record<string, unknown> = {},
    ) =>
      send(
        "Input.dispatchMouseEvent",
        { type, x, y, button: "left", pointerType: "mouse", ...extra },
        attached.sessionId,
      );
    // Hover first so sigma registers the node under the cursor, then hold Shift.
    await mouse("mouseMoved", from.x, from.y, { buttons: 0 });
    await Bun.sleep(150);
    await mouse("mousePressed", from.x, from.y, {
      buttons: 1,
      modifiers: 8,
      clickCount: 1,
    });
    await Bun.sleep(120);
    for (let i = 1; i <= 8; i++) {
      await mouse(
        "mouseMoved",
        from.x + ((to.x - from.x) * i) / 8,
        from.y + ((to.y - from.y) * i) / 8,
        { buttons: 1, modifiers: 8 },
      );
      await Bun.sleep(60);
    }
    await Bun.sleep(120);
    await mouse("mouseReleased", to.x, to.y, {
      buttons: 0,
      modifiers: 8,
      clickCount: 1,
    });
  } finally {
    ws.close();
  }
}

/** Wait until a node title is observable in the rendered node list. */
async function waitForNodeTitle(
  title: string,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inDom = await js<boolean>(
      `document.body.innerText.includes(${JSON.stringify(title)})`,
    );
    if (inDom) return Date.now();
    await Bun.sleep(150);
  }
  throw new Error(`node "${title}" never appeared in the rendered graph`);
}

// ---------------------------------------------------------------- auth flow

async function graphStatus(): Promise<number> {
  return js<number>(
    "fetch('/api/graph',{headers:{accept:'application/json'}}).then(r=>r.status)",
  );
}

async function fillToken(value: string): Promise<boolean> {
  for (const base of [
    ["label", "Owner access token"],
    ["placeholder", "Owner access token"],
    ["placeholder", "token"],
  ]) {
    if (found(await ab(["find", ...base, "fill", value], true))) return true;
  }
  return false;
}

async function login(): Promise<void> {
  if ((await graphStatus()) === 200) return;
  if (!(await fillToken(devToken))) {
    blocked(
      "no 'Owner access token' field found; the driver needs the token input",
    );
  }
  if (!(await clickButton("Unlock graph"))) {
    blocked(
      "no 'Unlock graph' button found; the driver needs the submit control",
    );
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await graphStatus()) === 200) return;
    await Bun.sleep(200);
  }
  blocked("login did not establish a session");
}

// ---------------------------------------------------------------- flow

async function main(): Promise<void> {
  await mkdir(artifacts, { recursive: true });
  const server = await startServer({
    env: { YAKJEV_DEV_AUTH: "true" },
    token: devToken,
  });
  console.log(`server ${server.origin} (data ${server.dataDir})`);
  try {
    await ab(["close"], true);
    await ab(["open", server.origin]);
    await ab(["set", "viewport", "1280", "720", "2"]);
    await frame();

    if (discover) {
      const snapshot = await ab(["snapshot", "-i"]);
      const text = await js<string>("document.body.innerText.slice(0, 2000)");
      const canvases = await js<number>(
        "document.querySelectorAll('canvas').length",
      );
      const status = await graphStatus();
      await screenshot("discover");
      console.log(`\ncanvas elements: ${canvases}\n/api/graph: ${status}\n`);
      console.log(text);
      console.log(snapshot);
      return;
    }

    await run(
      "E0 unauthenticated state, rejected token, then a real login",
      async () => {
        await ab(["cookies", "clear"]);
        await ab(["eval", "localStorage.clear(); sessionStorage.clear()"]);
        await ab(["reload"]);
        await frame();

        const fieldCount = await js<number>(
          "document.querySelectorAll('input[type=password]').length",
        );
        const button = await findText(
          ["role", "button"],
          ["--name", "Unlock graph"],
        );
        const alert = await findText(["role", "alert"]);
        await screenshot("00-login");
        if (fieldCount === 0 || !button) {
          blocked(
            "the unauthenticated page does not expose the 'Owner access token' field and 'Unlock graph' button",
          );
        }
        if (!alert) {
          blocked(
            "the unauthenticated page renders no role=alert with the server's message",
          );
        }

        await fillToken(wrongToken);
        await clickButton("Unlock graph");
        await frame();
        const cleared = await js<string>(
          "document.querySelector('input[type=password]')?.value ?? 'MISSING'",
        );
        const alertAfter = await findText(["role", "alert"]);
        await screenshot("00b-rejected-token");
        if (cleared !== "") {
          throw new Error(
            `the token field still holds ${JSON.stringify(cleared)} after a rejected token`,
          );
        }
        if (!alertAfter) {
          throw new Error("a rejected token produced no visible error message");
        }

        await login();
        await frame();
        const canvases = await js<number>(
          "document.querySelectorAll('canvas').length",
        );
        const stored = await js<number>(
          "localStorage.length + sessionStorage.length",
        );
        if (canvases === 0) throw new Error("no graph canvas after login");
        if (stored !== 0) {
          throw new Error(
            `the session persisted ${stored} storage entries; the token must not be stored client-side`,
          );
        }
        return {
          detail: `login surface, rejected-token error, cleared field, ${canvases} canvas, no client-side token storage`,
          artifacts: [
            join(artifacts, "00-login.png"),
            join(artifacts, "00b-rejected-token.png"),
          ],
        };
      },
    );

    await run(
      "E1 capture from another client appears live without reload",
      async () => {
        const canvasBefore = await screenshotElement(
          "canvas",
          "e1-canvas-before",
        );
        const started = Date.now();
        const result = await sendCommand(server, 0, {
          type: "capture",
          capture: captureFixture,
          nodes: fixtureNodes,
          edges: fixtureEdges,
        });
        const receiptAt = Date.now();
        const renderedAt = await waitForNodeTitle(
          "Multi-machine skills blocker",
          10_000,
        );
        const canvasAfter = await screenshotElement(
          "canvas",
          "e1-canvas-after",
        );
        const changed = await changedFraction(canvasBefore, canvasAfter);
        await screenshot("01-after-capture");
        if (changed < 0.005) {
          throw new Error(
            `revision ${result.receipt.revision} landed but the canvas did not change (${(changed * 100).toFixed(2)}%)`,
          );
        }
        return {
          detail: `revision ${result.receipt.revision}; receipt->render ${renderedAt - receiptAt}ms; command->render ${renderedAt - started}ms; canvas changed ${(changed * 100).toFixed(1)}%`,
          artifacts: [canvasAfter, join(artifacts, "01-after-capture.png")],
        };
      },
    );

    await run("E1b the canvas instance survives a live update", async () => {
      await js(
        "window.__yakjevCanvas = document.querySelector('canvas'), true",
      );
      const before = await readGraph(server);
      await sendCommand(server, before.revision, {
        type: "node.put",
        node: {
          id: "live_extra_node",
          title: "Live extra node",
          description: "Synthetic node added while the graph is on screen.",
          project: "synthetic-project",
          status: "idea",
          sources: [],
        },
      });
      await waitForNodeTitle("Live extra node", 10_000);
      const same = await js<boolean>(
        "document.querySelector('canvas') === window.__yakjevCanvas",
      );
      if (!same) {
        throw new Error(
          "the graph canvas was replaced on a live update, which resets the user's view",
        );
      }
      return {
        detail: "same canvas element across the live update",
        artifacts: [],
      };
    });

    await run(
      "E1c an MCP capture from an agent appears live in the rendered graph",
      async () => {
        const session = await openSession(server);
        const before = await readGraph(server);
        const canvasBefore = await screenshotElement(
          "canvas",
          "e1c-canvas-before",
        );
        const called = await callTool(server, session, "graph_command", {
          requestId: `acceptance-browser-mcp-${Date.now()}`,
          expectedRevision: before.revision,
          command: {
            type: "capture",
            capture: {
              id: "capture_mcp_agent",
              text: "Synthetic capture submitted through the agent surface while the graph is on screen.",
              sources: [
                {
                  uri: "synthetic://session/mcp-agent",
                  label: "Synthetic MCP session",
                },
              ],
              nodeIds: ["agent_side_node"],
            },
            nodes: [
              {
                id: "agent_side_node",
                title: "Agent side node",
                description:
                  "Captured through MCP while the graph is on screen.",
                project: "synthetic-project",
                status: "idea",
                sources: [
                  {
                    uri: "synthetic://document/agent-side",
                    label: "Synthetic agent note",
                  },
                ],
              },
            ],
            edges: [],
          },
        });
        const receiptAt = Date.now();
        const structured = called.structuredContent as {
          receipt?: { revision?: number; actor?: { channel?: string } };
        };
        if (structured.receipt?.actor?.channel !== "mcp") {
          throw new Error(
            `an MCP capture recorded channel ${structured.receipt?.actor?.channel}, expected mcp`,
          );
        }
        const renderedAt = await waitForNodeTitle("Agent side node", 10_000);
        const canvasAfter = await screenshotElement(
          "canvas",
          "e1c-canvas-after",
        );
        const diff = await diffCanvas(canvasBefore, canvasAfter);
        await screenshot("01c-after-mcp-capture");
        // One node is a small mark on the canvas, so count pixels rather than
        // require a fraction of the whole surface.
        if (diff.pixels < 150) {
          throw new Error(
            `the MCP capture reached the graph but the rendered canvas changed by only ${diff.pixels} pixels`,
          );
        }
        return {
          detail: `MCP revision ${structured.receipt?.revision}; receipt->render ${renderedAt - receiptAt}ms; canvas changed ${diff.pixels}px (${(diff.fraction * 100).toFixed(2)}%)`,
          artifacts: [join(artifacts, "01c-after-mcp-capture.png")],
        };
      },
    );

    await run(
      "E2 selecting the delayed node exposes its blocking edge and rationale",
      async () => {
        if (!(await clickButton("Multi-machine skills blocker"))) {
          blocked(
            "the node list does not expose 'Multi-machine skills blocker'",
          );
        }
        await frame();
        const interpretation = await findText(["text", "Expand neighborhood"]);
        const edgeCard = await findText(["text", "Prism harness installs"]);
        await screenshot("02-node-inspector");
        if (!interpretation || !edgeCard) {
          blocked(
            "the node inspector does not show the neighborhood control and its connection",
          );
        }
        if (
          !(await clickCard(
            "Prism harness installs → Multi-machine skills blocker",
          ))
        ) {
          blocked(
            "no connection card matched 'Prism harness installs → Multi-machine skills blocker'",
          );
        }
        await frame();
        const rationale = await findText(["text", "Current rationale"]);
        const original = await findText(["text", "Original assertion"]);
        const reframe = await findText(["text", "Reframe this relationship"]);
        await screenshot("02b-edge-inspector");
        if (!rationale || !original || !reframe) {
          blocked(
            "the edge inspector does not expose rationale, original assertion, and reframe",
          );
        }
        const graph = await readGraph(server);
        const edge = edgeById(graph, reframeEdgeId);
        if (!edge)
          throw new Error("the fixture edge is missing from the server");
        return {
          detail: `edge ${edge.id} (${edge.relation}) exposes rationale, original assertion, and reframe`,
          artifacts: [
            join(artifacts, "02-node-inspector.png"),
            join(artifacts, "02b-edge-inspector.png"),
          ],
        };
      },
    );

    await run(
      "E3 a suggestion renders as a proposal and is accepted explicitly",
      async () => {
        const graph = await readGraph(server);
        await sendCommand(server, graph.revision, {
          type: "suggestion.record",
          suggestion: { ...fixtureSuggestion, basedOnRevision: graph.revision },
        });
        await ab(["wait", "--text", "Jev & suggestions", "--timeout", "5000"]);
        if (!(await clickButton("Jev & suggestions"))) {
          blocked("the sidebar does not expose the 'Jev & suggestions' panel");
        }
        await frame();
        // The client learns about the recorded suggestion from the change stream.
        const cardDeadline = Date.now() + 8_000;
        let card = false;
        while (Date.now() < cardDeadline && !card) {
          card = await clickCard("Jev in projects → Prism harness installs");
          if (!card) await Bun.sleep(250);
        }
        if (!card) {
          blocked(
            "the suggestions list does not expose 'Jev in projects → Prism harness installs'",
          );
        }
        await frame();
        const proposal = await findText([
          "text",
          "A proposal, not a dependency",
        ]);
        const evidence = await findText(["text", "Synthetic lexical overlap"]);
        const provenance = await findText(["text", "Machine suggestion"]);
        await screenshot("03-suggestion");
        if (!proposal) {
          blocked("the suggestion panel does not state that it is a proposal");
        }
        if (!provenance) {
          throw new Error(
            "the suggestion does not identify itself as a machine suggestion",
          );
        }
        if (!evidence) {
          throw new Error(
            "the suggestion renders without its recorded evidence list",
          );
        }
        const afterRecord = await readGraph(server);
        if (
          edgeBetween(
            afterRecord,
            fixtureSuggestion.source,
            fixtureSuggestion.target,
          )
        ) {
          throw new Error("recording a suggestion created an asserted edge");
        }
        if (!(await clickButton("Accept suggestion"))) {
          blocked("no 'Accept suggestion' control found");
        }
        const deadline = Date.now() + 8_000;
        let accepted = false;
        while (Date.now() < deadline && !accepted) {
          const current = await readGraph(server);
          accepted = Boolean(
            edgeBetween(
              current,
              fixtureSuggestion.source,
              fixtureSuggestion.target,
            ),
          );
          if (!accepted) await Bun.sleep(200);
        }
        await screenshot("03b-suggestion-accepted");
        if (!accepted) {
          throw new Error(
            "accepting the suggestion did not create the asserted edge",
          );
        }
        return {
          detail:
            "proposal labelling with unverified-context evidence, no edge before acceptance, edge after explicit acceptance",
          artifacts: [
            join(artifacts, "03-suggestion.png"),
            join(artifacts, "03b-suggestion-accepted.png"),
          ],
        };
      },
    );

    await run(
      "E4 expanding the delayed node shows why it is stuck",
      async () => {
        if (!(await clickButton("Prism harness installs"))) {
          blocked("the node list does not expose the delayed work node");
        }
        await frame();
        if (!(await clickButton("Expand neighborhood"))) {
          blocked("no 'Expand neighborhood' control found");
        }
        const deadline = Date.now() + 8_000;
        let interpretation: string | undefined;
        while (Date.now() < deadline && !interpretation) {
          interpretation = await findText(["text", "cycle"]);
          if (!interpretation) {
            interpretation =
              (await js<string | null>(
                "document.querySelector('.interpretation')?.textContent ?? null",
              )) ?? undefined;
          }
          if (!interpretation) await Bun.sleep(200);
        }
        await screenshot("04-expanded");
        if (!interpretation) {
          throw new Error(
            "expanding the neighborhood produced no interpretation",
          );
        }
        return {
          detail: `interpretation shown: ${interpretation.slice(0, 160)}`,
          artifacts: [join(artifacts, "04-expanded.png")],
        };
      },
    );

    await run(
      "E4b Arrange with an unconnected intention keeps the cluster legible",
      async () => {
        const before = await readGraph(server);
        await sendCommand(server, before.revision, {
          type: "node.put",
          node: {
            id: "local_jev_experiment",
            title: "Local Jev experiment",
            description:
              "Unconnected intention: a local experiment with no claimed relation yet.",
            project: "synthetic-project",
            status: "idea",
            sources: [],
          },
        });
        await waitForNodeTitle("Local Jev experiment", 10_000);
        // A focused neighborhood from an earlier step would hide most nodes, so
        // return to the whole graph before judging the layout.
        await clickButton("Show whole graph");
        await clickButton("← Show whole graph");
        await frame();
        if (!(await clickButton("Arrange unpinned"))) {
          blocked("no 'Arrange unpinned' control found");
        }
        const deadline = Date.now() + 15_000;
        let positioned = false;
        while (Date.now() < deadline && !positioned) {
          const current = await readGraph(server);
          positioned = current.nodes
            .filter((node) => node.id !== "local_jev_experiment")
            .every((node) => node.position !== null);
          if (!positioned) await Bun.sleep(250);
        }
        await frame();
        const arrangedShot = await screenshot("04b-arranged-six-nodes");
        const census = await discCensus(arrangedShot);
        const graph = await readGraph(server);
        const cluster = graph.nodes.filter(
          (node) => node.id !== "local_jev_experiment" && node.position,
        );
        const isolated = graph.nodes.find(
          (node) => node.id === "local_jev_experiment",
        );
        if (cluster.length < 5 || !isolated?.position) {
          throw new Error(
            `Arrange did not save positions for all nodes (${cluster.length} cluster, isolated ${isolated?.position ? "positioned" : "unpositioned"})`,
          );
        }
        const center = cluster.reduce(
          (acc, node) => ({
            x: acc.x + (node.position?.x ?? 0) / cluster.length,
            y: acc.y + (node.position?.y ?? 0) / cluster.length,
          }),
          { x: 0, y: 0 },
        );
        const radius = Math.max(
          ...cluster.map((node) =>
            Math.hypot(
              (node.position?.x ?? 0) - center.x,
              (node.position?.y ?? 0) - center.y,
            ),
          ),
        );
        const isolatedDistance = Math.hypot(
          isolated.position.x - center.x,
          isolated.position.y - center.y,
        );
        const ratio = isolatedDistance / radius;
        if (ratio > 5) {
          throw new Error(
            `the unconnected intention dominates the layout: isolated node is ${ratio.toFixed(1)}x the cluster radius (cluster radius ${radius.toFixed(1)}, isolated distance ${isolatedDistance.toFixed(1)})`,
          );
        }
        const expected = graph.nodes.length;
        if (census.merged > 0 || census.discs !== expected) {
          throw new Error(
            `the arranged layout is not fully separated: ${census.discs} distinct discs and ${census.merged} merged blob(s) for ${expected} nodes`,
          );
        }
        return {
          detail: `positions saved for all nodes; ${census.discs} distinct discs, ${census.merged} merged blob(s) for ${expected} nodes; data ratio ${ratio.toFixed(1)}x`,
          artifacts: [join(artifacts, "04b-arranged-six-nodes.png")],
        };
      },
    );

    await run(
      "E5 reframe requires -> would benefit from in the UI",
      async () => {
        if (!(await clickButton("Multi-machine skills blocker"))) {
          blocked("the node list does not expose the delayed node");
        }
        await frame();
        if (
          !(await clickCard(
            "Prism harness installs → Multi-machine skills blocker",
          ))
        ) {
          blocked("the connection card for the reframe target was not found");
        }
        await frame();
        const before = await readGraph(server);
        if (!(await selectByLabel("Reframe as", optionalRelationId))) {
          blocked("no 'Reframe as' select found");
        }
        if (
          !(await fillLabel(
            "Reason for this correction",
            "Synthetic acceptance reframe: helpful, not a prerequisite.",
          ))
        ) {
          blocked("no 'Reason for this correction' field found");
        }
        if (!(await clickButton("Save reframe"))) {
          blocked("no 'Save reframe' control found");
        }
        const deadline = Date.now() + 8_000;
        let edge = edgeById(before, reframeEdgeId);
        while (Date.now() < deadline) {
          const current = await readGraph(server);
          edge = edgeById(current, reframeEdgeId);
          if (edge?.relation === optionalRelationId) break;
          await Bun.sleep(200);
        }
        await screenshot("05-reframed");
        if (edge?.relation !== optionalRelationId) {
          throw new Error(
            `the reframe did not reach the server; relation is ${edge?.relation}`,
          );
        }
        if (edge.assertion.relation !== "requires") {
          throw new Error("the original assertion was lost by the reframe");
        }
        const blocking = await neighborhood(server, {
          id: "prism_harness_installs",
          direction: "outgoing",
          blocking: true,
        });
        if (blocking.blockingEdges.includes(reframeEdgeId)) {
          throw new Error("the reframed edge still counts as blocking");
        }
        return {
          detail: `revision ${before.revision} -> ${(await readGraph(server)).revision}; blocking interpretation changed, original assertion retained`,
          artifacts: [join(artifacts, "05-reframed.png")],
        };
      },
    );

    await run("E6 undo restores the blocking interpretation", async () => {
      if (!(await clickButton("Undo last edit"))) {
        blocked("no 'Undo last edit' control found");
      }
      const deadline = Date.now() + 8_000;
      let edge = undefined;
      while (Date.now() < deadline) {
        const current = await readGraph(server);
        edge = edgeById(current, reframeEdgeId);
        if (edge?.relation === "requires") break;
        await Bun.sleep(200);
      }
      await screenshot("06-undone");
      if (edge?.relation !== "requires") {
        throw new Error(
          `after undo the relation is ${edge?.relation}, expected requires`,
        );
      }
      const blocking = await neighborhood(server, {
        id: "prism_harness_installs",
        direction: "outgoing",
        blocking: true,
      });
      if (!blocking.blockingEdges.includes(reframeEdgeId)) {
        throw new Error("undo did not restore the blocking interpretation");
      }
      return {
        detail: "relation restored to requires and the edge blocks again",
        artifacts: [join(artifacts, "06-undone.png")],
      };
    });

    await run(
      "E7 restart recovers the graph, positions, and the correction",
      async () => {
        const before = await readGraph(server);
        await server.restart();
        await ab(["open", server.origin]);
        await ab(["set", "viewport", "1280", "720", "2"]);
        await login();
        await waitForNodeTitle("Multi-machine skills blocker", 10_000);
        await frame();
        const after = await readGraph(server);
        if (after.revision !== before.revision) {
          throw new Error(
            `revision changed across restart: ${before.revision} -> ${after.revision}`,
          );
        }
        const positionBefore = nodeById(
          before,
          "multi_machine_skills",
        )?.position;
        const positionAfter = nodeById(after, "multi_machine_skills")?.position;
        if (JSON.stringify(positionBefore) !== JSON.stringify(positionAfter)) {
          throw new Error("the saved node position changed across restart");
        }
        await screenshot("07-after-restart");
        return {
          detail: `revision ${after.revision} and node positions recovered after restart`,
          artifacts: [join(artifacts, "07-after-restart.png")],
        };
      },
    );

    await run(
      "E7b Jev without a configured key renders an explicit unavailable state",
      async () => {
        if (!(await clickButton("Jev & suggestions"))) {
          blocked("the sidebar does not expose the 'Jev & suggestions' panel");
        }
        await frame();
        const before = await readGraph(server);
        if (
          !(await fillLabel(
            "Search context",
            "synthetic acceptance query without a provider key",
          ))
        ) {
          blocked("no 'Search context' field found in the Jev panel");
        }
        if (!(await clickButton("Evaluate with Jev"))) {
          blocked("no 'Evaluate with Jev' control found");
        }
        // An unavailable evaluation is a recorded result, so the panel reports it
        // as a status (with the failure code), not as a request error.
        const deadline = Date.now() + 20_000;
        let message: string | undefined;
        while (Date.now() < deadline && !message) {
          const inspector =
            (await js<string | null>(
              "document.querySelector('.inspector')?.innerText ?? null",
            )) ?? "";
          const match = inspector.match(
            /[^\n]*(unavailable|not configured)[^\n]*/i,
          );
          message = match?.[0]?.trim() || undefined;
          if (!message) await Bun.sleep(250);
        }
        await screenshot("07b-jev-unavailable");
        if (!message) {
          throw new Error(
            "evaluating without a provider key produced no visible unavailable state",
          );
        }
        if (!/unavailable|not configured/i.test(message)) {
          throw new Error(`unexpected evaluation message: ${message}`);
        }
        const after = await readGraph(server);
        if (after.suggestions.length !== before.suggestions.length) {
          throw new Error(
            "an unavailable evaluation still recorded a suggestion",
          );
        }
        return {
          detail: `explicit unavailable state: ${message.slice(0, 140)}`,
          artifacts: [join(artifacts, "07b-jev-unavailable.png")],
        };
      },
    );

    await run("E8 narrow layout keeps the graph usable at 390px", async () => {
      await ab(["set", "viewport", "390", "844", "2"]);
      await frame();
      await screenshot("08-narrow");
      const overflow = await js<number>(
        "Math.max(0, document.documentElement.scrollWidth - window.innerWidth)",
      );
      if (overflow > 2) {
        throw new Error(`horizontal overflow of ${overflow}px at 390px width`);
      }
      return {
        detail: "no horizontal overflow at 390px",
        artifacts: [join(artifacts, "08-narrow.png")],
      };
    });

    await run(
      "E9 accessibility audit finds no serious or critical violations",
      async () => {
        const raw = await ab(["a11y", "--json"]);
        let violations:
          | { id?: string; impact?: string; nodes?: unknown[] }[]
          | undefined;
        try {
          const parsed = JSON.parse(raw) as {
            violations?: typeof violations;
            data?: { violations?: typeof violations };
          };
          violations = parsed.violations ?? parsed.data?.violations;
        } catch {
          blocked(`the a11y report was not JSON: ${raw.slice(0, 200)}`);
        }
        if (!violations) {
          blocked(
            `the a11y report carried no violations array: ${raw.slice(0, 200)}`,
          );
        }
        const severe = violations.filter(
          (violation) =>
            violation.impact === "serious" || violation.impact === "critical",
        );
        if (severe.length > 0) {
          const detail = severe
            .map(
              (violation) =>
                `${violation.id} (${violation.impact}, ${violation.nodes?.length ?? 0} node(s))`,
            )
            .join(", ");
          throw new Error(
            `${severe.length} serious/critical accessibility violations: ${detail}. Full report: ${raw.slice(0, 600)}`,
          );
        }
        return {
          detail: `${violations.length} violations reported, none serious or critical`,
          artifacts: [],
        };
      },
    );

    // ---------------------------------------------------- live Jev (real provider)
    // A second disposable server with the real provider key: the primary
    // acceptance server deliberately runs without one (E7b depends on that).
    const providerKey = process.env.TYPESAFE_API_KEY;
    if (!providerKey) {
      record({
        name: "J1/J2 live Jev browser checks",
        status: "blocked",
        detail:
          "TYPESAFE_API_KEY is not configured; live preview checks skipped",
        artifacts: [],
      });
    } else {
      const jevServer = await startServer({
        env: { YAKJEV_DEV_AUTH: "true", TYPESAFE_API_KEY: providerKey },
        token: devToken,
      });
      try {
        await run(
          "J0 workspace context saves before the first intention",
          async () => {
            await ab(["open", jevServer.origin]);
            await ab(["set", "viewport", "1280", "720", "2"]);
            await login();
            if (!(await clickButton("Jev context")))
              blocked("Jev context settings control is missing");
            const text =
              "I run a vegetable garden. A prerequisite means the goal cannot happen without it; useful preparation is only a benefit.";
            if (!(await fillLabel("Jev context", text)))
              blocked("Jev context text area is missing");
            if (!(await clickButton("Save")))
              blocked("Jev context Save button is missing");
            const deadline = Date.now() + 3_000;
            let saved = false;
            while (Date.now() < deadline) {
              saved = (await readGraph(jevServer)).jevContext?.text === text;
              if (saved) break;
              await Bun.sleep(100);
            }
            if (!saved)
              throw new Error("workspace context did not reach SQLite");
            await ab(["reload"]);
            await login();
            if (!(await clickButton("Jev context")))
              blocked("Jev context control did not survive reload");
            const restored = await js<string>(
              "document.querySelector('textarea[aria-label=\"Jev context\"]')?.value ?? ''",
            );
            if (restored !== text)
              throw new Error(
                "saved workspace context was not restored after reload",
              );
            await ab(["press", "Escape"]);
            return {
              detail:
                "context saved in the graph before any node and restored after reload",
              artifacts: [],
            };
          },
        );

        const intention = "Plant tomatoes in the raised beds";
        await run(
          "J1 typing an intention lists Jev's connections; Enter commits them",
          async () => {
            await sendCommand(
              jevServer,
              (await readGraph(jevServer)).revision,
              {
                type: "capture",
                capture: {
                  id: "jev_browser_seed",
                  text: "Synthetic seed for the live Jev browser check. Not fetched.",
                  sources: [],
                  nodeIds: ["seed_beds", "seed_seeds"],
                },
                nodes: [
                  {
                    id: "seed_beds",
                    title: "Build raised beds for the vegetable garden",
                    description:
                      "Two cedar raised beds along the south fence for vegetables.",
                    project: "synthetic-garden",
                    status: "idea",
                    sources: [],
                  },
                  {
                    id: "seed_seeds",
                    title: "Order tomato and basil seeds before spring",
                    description:
                      "Seed order must go out before spring planting.",
                    project: "synthetic-garden",
                    status: "idea",
                    sources: [],
                  },
                ],
                edges: [],
                autoConnect: false,
              },
            );
            await ab(["open", jevServer.origin]);
            await ab(["set", "viewport", "1280", "720", "2"]);
            await login();
            await frame();
            await ab(["press", "c"]);
            if (!(await waitForSelector("input[aria-label='Intention']", 5000)))
              blocked("pressing c did not open the create card");
            let items: string[] = [];
            let attempts = 0;
            for (attempts = 1; attempts <= 2; attempts++) {
              if (!(await fillLabel("Intention", intention)))
                blocked("no 'Intention' input in the create card");
              if (
                await waitForSelector(
                  ".jev-live ul[aria-label='Jev will connect'] li",
                  12_000,
                )
              ) {
                items = await js<string[]>(
                  `Array.from(document.querySelectorAll(".jev-live ul[aria-label='Jev will connect'] li")).map((li) => (li.textContent || "").trim())`,
                );
                if (items.length > 0) break;
              }
              // A flaky provider call shows the offline note; retry once.
              await fillLabel("Intention", "");
              await frame();
            }
            if (items.length === 0)
              throw new Error(
                "the live 'Jev will connect' list never appeared while typing",
              );
            if (!items.some((item) => /raised beds|seeds/i.test(item)))
              throw new Error(
                `the live list named none of the seeded nodes: ${items.join(" | ")}`,
              );
            const shot = await screenshot("j1-typing-preview");
            await ab(["press", "Enter"]);
            const deadline = Date.now() + 10_000;
            let createdId: string | undefined;
            let jevEdges: {
              id: string;
              source: string;
              target: string;
              rationale: string;
              origin?: unknown;
            }[] = [];
            while (Date.now() < deadline) {
              const graph = await readGraph(jevServer);
              const created = graph.nodes.find(
                (node) => node.title === intention,
              );
              if (created) {
                createdId = created.id;
                jevEdges = graph.edges.filter(
                  (edge) =>
                    edge.source === created.id || edge.target === created.id,
                );
                if (jevEdges.length > 0) break;
              }
              await Bun.sleep(250);
            }
            if (!createdId)
              throw new Error("Enter did not create the intention");
            if (jevEdges.length === 0)
              throw new Error("the created intention has no edges");
            if (jevEdges.some((edge) => !edge.origin))
              throw new Error("a Jev-created edge is missing its origin");
            if (jevEdges.some((edge) => edge.rationale !== "Connected by Jev."))
              throw new Error("a Jev-created edge lacks the Jev rationale");
            await screenshot("j1-created-with-edges");
            return {
              detail: `${items.length} live connection(s) while typing (${attempts} attempt(s)); created ${createdId} with ${jevEdges.length} Jev edge(s), origin and rationale set`,
              artifacts: [shot],
            };
          },
        );

        await run(
          "J2 shift-drag pre-selects Jev's relation in the link card",
          async () => {
            await ab(["press", "Escape"]);
            const before = await readGraph(jevServer);
            if (edgeBetween(before, "seed_beds", "seed_seeds"))
              throw new Error("seed nodes are already connected; bad fixture");
            await screenshot("j2-before-shift-drag");
            const from = await nodeAnchor("seed_seeds");
            const to = await nodeAnchor("seed_beds");
            if (!from || !to)
              blocked(
                "window.__yakjevCanvas.anchorNode is not exposed; the canvas needs the test hook requested from jev-drag",
              );
            await cdpShiftDrag(from, to);
            if (!(await waitForSelector(".graph-editor .jev-note", 8_000))) {
              await screenshot("j2-shift-drag-missed");
              blocked(
                "synthetic shift-drag did not open the link chooser (see j2-shift-drag-missed.png)",
              );
            }
            const deadline = Date.now() + 15_000;
            let note = "";
            while (Date.now() < deadline) {
              note = await js<string>(
                "document.querySelector('.graph-editor .jev-note')?.textContent ?? ''",
              );
              if (/Jev ·/.test(note) || /no relation|offline/.test(note)) break;
              await Bun.sleep(250);
            }
            const shot2 = await screenshot("j2-assert-card");
            if (/no relation|offline/.test(note))
              throw new Error(`Jev declined the seeded pair: ${note}`);
            if (!/Jev ·/.test(note))
              throw new Error(`the link card shows no Jev judgment: ${note}`);
            if (!(await clickButton("Connect")))
              blocked("the link card has no 'Connect' control");
            const connected = Date.now() + 8_000;
            let edge = undefined;
            while (Date.now() < connected) {
              const graph = await readGraph(jevServer);
              edge = edgeBetween(graph, "seed_beds", "seed_seeds");
              if (edge) break;
              await Bun.sleep(250);
            }
            if (!edge)
              throw new Error("Connect did not create the shift-dragged edge");
            if (!edge.origin)
              throw new Error(
                "the accepted Jev pre-selection lost its origin on commit",
              );
            return {
              detail: `link card showed "${note}"; Connect created ${edge.id} with Jev origin`,
              artifacts: [shot2],
            };
          },
        );
      } finally {
        await jevServer.stop();
      }
    }
  } finally {
    await ab(["close"], true);
    await server.stop();
    const summary = {
      steps,
      artifacts: shots,
      server: { origin: server.origin, dataDir: server.dataDir },
    };
    await writeFile(
      join(artifacts, "browser-acceptance-report.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    const failed = steps.filter((step) => step.status === "fail").length;
    const blockedSteps = steps.filter(
      (step) => step.status === "blocked",
    ).length;
    console.log(
      `\n${steps.length} steps: ${steps.filter((s) => s.status === "pass").length} pass, ${failed} fail, ${blockedSteps} blocked`,
    );
    if (failed > 0) process.exitCode = 1;
  }
}

void (async () => {
  await main();
})();
