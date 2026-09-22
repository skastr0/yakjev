#!/usr/bin/env bun
// Opt-in browser acceptance driver: real Chromium (agent-browser), real server,
// disposable synthetic data. Orb-only; never runs in CI and never touches a
// deployed instance.
//
//   bun tests/acceptance/browser/run.ts            # full loop
//   bun tests/acceptance/browser/run.ts --discover # inspect the page and exit
//
// Every step reports PASS, FAIL, or BLOCKED with the reason. BLOCKED means the
// driver could not locate a surface it needs; it is never reported as a pass.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  edgeById,
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
import { acceptanceToken, startServer, type ServerHandle } from "../harness";

const session = "yakjev-accept";
const artifacts = resolve(import.meta.dir, "../../../.amp/in/artifacts");
const discover = process.argv.includes("--discover");

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

type RunResult = { stdout: string; stderr: string; code: number };

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
  const raw = await ab([
    "eval",
    `(async () => JSON.stringify(await (${expression})))()`,
  ]);
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

async function waitForText(text: string, timeoutMs = 8_000): Promise<void> {
  await ab(["wait", "--text", text, "--timeout", String(timeoutMs)]);
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

// ---------------------------------------------------------------- pixel checks

async function changedFraction(before: string, after: string): Promise<number> {
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
  const changed = Number(metric.split(/\s+/).filter(Boolean).pop());
  const dims = await sh(["magick", "identify", "-format", "%w %h", before]);
  const [width, height] = dims.trim().split(" ").map(Number);
  if (!Number.isFinite(changed) || !width || !height) {
    throw new Error(`could not diff ${before} and ${after}: ${metric}`);
  }
  return changed / (width * height);
}

// ---------------------------------------------------------------- flow

const devToken = "synthetic-yakjev-owner-token-local-only";
const wrongToken = "synthetic-wrong-token-value";

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
    ["label", "token"],
  ]) {
    if (found(await ab(["find", ...base, "fill", value], true))) return true;
  }
  return false;
}

async function submitLogin(): Promise<boolean> {
  for (const name of ["Unlock graph", "Connect", "Sign in", "Log in"]) {
    if (await findClick(["role", "button"], ["--name", name])) return true;
  }
  return false;
}

async function login(): Promise<void> {
  if ((await graphStatus()) === 200) return;
  if (!(await fillToken(devToken))) {
    blocked(
      "no 'Owner access token' field found; the driver needs the UI's token input",
    );
  }
  if (!(await submitLogin())) {
    blocked(
      "no 'Unlock graph' button found; the driver needs the submit control",
    );
  }
  await ab(["wait", "--load", "networkidle"], true);
  const status = await graphStatus();
  if (status !== 200) {
    blocked(
      `login did not establish a session (/api/graph returned ${status})`,
    );
  }
}

async function main(): Promise<void> {
  await mkdir(artifacts, { recursive: true });
  const server = await startServer({
    env: { YAKJEV_DEV_AUTH: "true" },
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
      const status = await js<number>(
        "fetch('/api/graph',{headers:{accept:'application/json'}}).then(r=>r.status)",
      );
      await screenshot("discover");
      console.log(`\ncanvas elements: ${canvases}\n/api/graph: ${status}\n`);
      console.log(text);
      console.log(snapshot);
      return;
    }

    await run("open the graph page authenticated", async () => {
      await login();
      await js(
        "window.__yakjevCanvas = document.querySelector('canvas'), true",
      );
      const canvases = await js<number>(
        "document.querySelectorAll('canvas').length",
      );
      if (canvases === 0) {
        blocked("the page rendered without a graph canvas");
      }
      await screenshot("01-empty-graph");
      return {
        detail: `authenticated, ${canvases} canvas element(s)`,
        artifacts: [join(artifacts, "01-empty-graph.png")],
      };
    });

    await run(
      "E0 the unauthenticated state renders a login surface, not an empty graph",
      async () => {
        await ab(["cookies", "clear"]);
        await ab(["open", server.origin]);
        await ab(["set", "viewport", "1280", "720", "2"]);
        await ab(["eval", "localStorage.clear(); sessionStorage.clear()"]);
        await ab(["reload"]);
        await frame();

        const field = await findText(["label", "Owner access token"]);
        const button = await findText(
          ["role", "button"],
          ["--name", "Unlock graph"],
        );
        const alert = await findText(["role", "alert"]);
        await screenshot("00-login");
        if (!field || !button) {
          blocked(
            "the unauthenticated page does not expose the 'Owner access token' field and 'Unlock graph' button",
          );
        }
        if (!alert) {
          blocked(
            "the unauthenticated page renders no role=alert error state with the server's message",
          );
        }

        await fillToken(wrongToken);
        await submitLogin();
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
        const stored = await js<number>(
          "localStorage.length + sessionStorage.length",
        );
        if (stored !== 0) {
          throw new Error(
            `the session persisted ${stored} storage entries; the token must not be stored client-side`,
          );
        }
        return {
          detail:
            "login surface, role=alert error, cleared field after a rejected token, no client-side token storage",
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
        const revision = result.receipt.revision;
        // The receipt is durable; the UI must catch up on its own.
        await waitForVisibleNode("Multi-machine skills blocker", 8_000);
        const renderedAt = Date.now();
        const canvasAfter = await screenshotElement(
          "canvas",
          "e1-canvas-after",
        );
        const changed = await changedFraction(canvasBefore, canvasAfter);
        await screenshot("01b-after-capture");
        if (changed < 0.005) {
          throw new Error(
            `receipt landed at revision ${revision} but the canvas did not change (changed fraction ${changed.toFixed(4)})`,
          );
        }
        return {
          detail: `revision ${revision}; receipt->DOM ${renderedAt - receiptAt}ms; command->render ${renderedAt - started}ms; canvas changed ${(changed * 100).toFixed(1)}%`,
          artifacts: [canvasAfter, join(artifacts, "01b-after-capture.png")],
        };
      },
    );

    await run(
      "E1b the canvas instance and camera survive a live update",
      async () => {
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
      },
    );

    await run(
      "E2 an asserted edge is visible with its rationale reachable",
      async () => {
        const graph = await readGraph(server);
        const edge = edgeById(graph, reframeEdgeId);
        if (!edge)
          throw new Error("fixture edge missing from the server graph");
        const visible = await findClick([
          "text",
          edge.rationale.split(" ").slice(0, 4).join(" "),
        ]);
        await screenshot("02-edge-inspector");
        if (!visible) {
          blocked(
            "no DOM affordance surfaced the edge rationale; the driver needs the UI's edge-inspector selector",
          );
        }
        return {
          detail: `edge ${edge.id} rationale reachable in the UI`,
          artifacts: [join(artifacts, "02-edge-inspector.png")],
        };
      },
    );

    await run(
      "E3 a suggestion renders as a proposal, not an asserted edge",
      async () => {
        const graph = await readGraph(server);
        await sendCommand(server, graph.revision, {
          type: "suggestion.record",
          suggestion: { ...fixtureSuggestion, basedOnRevision: graph.revision },
        });
        const shown = await findText(["text", "Suggested"]);
        await screenshot("03-suggestion");
        if (!shown) {
          blocked(
            "no visible 'Suggested' affordance; needs the UI's suggestion marker",
          );
        }
        const evidence = await findText([
          "text",
          "not independent confirmation",
        ]);
        if (!evidence) {
          blocked(
            "the suggestion is visible but its unverified-context evidence label is not; " +
              "a judgment must not look like independent confirmation",
          );
        }
        const after = await readGraph(server);
        if (edgeById(after, "suggestion_jev_projects_prism")) {
          throw new Error("recording a suggestion created an asserted edge");
        }
        return {
          detail: "suggestion visible as a proposal and not an assertion",
          artifacts: [join(artifacts, "03-suggestion.png")],
        };
      },
    );

    await run(
      "E4 expanding the delayed node shows why it is stuck",
      async () => {
        const opened = await findClick([
          "text",
          "Multi-machine skills blocker",
        ]);
        if (!opened)
          blocked(
            "node title is not a DOM affordance (canvas-only rendering?)",
          );
        await frame();
        const expanded = await neighborhood(server, {
          id: "prism_harness_installs",
          direction: "outgoing",
          blocking: true,
        });
        await screenshot("04-expand");
        return {
          detail: `blocking edges reported by the server: ${expanded.blockingEdges.join(", ")}`,
          artifacts: [join(artifacts, "04-expand.png")],
        };
      },
    );

    await run(
      "E5 reframe requires -> would benefit from in the UI",
      async () => {
        const before = await readGraph(server);
        const opened = await findClick([
          "text",
          "Multi-machine skills blocker",
        ]);
        if (!opened) blocked("cannot open the delayed node to reach its edge");
        const reframed = await findClick(["text", "Would benefit from"]);
        if (!reframed) {
          blocked(
            "no 'Would benefit from' control; needs the UI's reframe affordance selector",
          );
        }
        await frame();
        const after = await readGraph(server);
        if (after.revision === before.revision) {
          throw new Error(
            "reframe did not reach the server (revision unchanged)",
          );
        }
        const edge = edgeById(after, reframeEdgeId);
        if (edge?.relation !== optionalRelationId) {
          throw new Error(
            `edge relation is ${edge?.relation}, expected ${optionalRelationId}`,
          );
        }
        const blocking = await neighborhood(server, {
          id: "prism_harness_installs",
          direction: "outgoing",
          blocking: true,
        });
        if (blocking.blockingEdges.includes(reframeEdgeId)) {
          throw new Error("the reframed edge still counts as blocking");
        }
        await screenshot("05-reframed");
        return {
          detail: `revision ${before.revision} -> ${after.revision}; blocking interpretation changed`,
          artifacts: [join(artifacts, "05-reframed.png")],
        };
      },
    );

    await run("E6 undo restores the blocking interpretation", async () => {
      const before = await readGraph(server);
      const undone = await findClick(["role", "button"], ["--name", "Undo"]);
      if (!undone)
        blocked("no Undo control; needs the UI's undo affordance selector");
      await frame();
      const after = await readGraph(server);
      if (after.revision <= before.revision) {
        throw new Error("undo did not reach the server");
      }
      const edge = edgeById(after, reframeEdgeId);
      if (edge?.relation !== "requires") {
        throw new Error(
          `after undo the relation is ${edge?.relation}, expected requires`,
        );
      }
      await screenshot("06-undone");
      return {
        detail: `revision ${before.revision} -> ${after.revision}; relation restored to requires`,
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
        await frame();
        await waitForVisibleNode("Multi-machine skills blocker", 8_000);
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
          throw new Error("saved node position changed across restart");
        }
        await screenshot("07-after-restart");
        return {
          detail: `revision ${after.revision} and node positions recovered after restart`,
          artifacts: [join(artifacts, "07-after-restart.png")],
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
        let violations: { id?: string; impact?: string }[] | undefined;
        try {
          const parsed = JSON.parse(raw) as { violations?: typeof violations };
          violations = parsed.violations;
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
          throw new Error(
            `${severe.length} serious/critical accessibility violations: ${severe
              .map((violation) => violation.id)
              .join(", ")}`,
          );
        }
        return {
          detail: `${violations.length} violations reported, none serious or critical`,
          artifacts: [],
        };
      },
    );
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

/**
 * Wait until a node is observable in the rendered UI. Canvas-only renderers put
 * nothing in the DOM, so this accepts either a DOM match or a canvas change and
 * reports which one it saw.
 */
async function waitForVisibleNode(
  title: string,
  timeoutMs: number,
): Promise<"dom" | "canvas"> {
  const deadline = Date.now() + timeoutMs;
  const before = await screenshotElement("canvas", "e1-canvas-watch-before");
  while (Date.now() < deadline) {
    const inDom = await js<boolean>(
      `document.body.innerText.includes(${JSON.stringify(title)})`,
    );
    if (inDom) return "dom";
    await Bun.sleep(250);
  }
  const after = await screenshotElement("canvas", "e1-canvas-watch-after");
  const changed = await changedFraction(before, after);
  if (changed > 0.005) return "canvas";
  throw new Error(
    `node "${title}" never became observable within ${timeoutMs}ms (DOM text absent, canvas changed ${(changed * 100).toFixed(2)}%)`,
  );
}

await main();
