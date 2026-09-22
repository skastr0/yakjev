import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NodeInput, type Preview } from "@yakjev/protocol";
import { createApp } from "../src/app.ts";

// Explicit opt-in script, never run by CI. Judges the REAL /api/jev/preview
// route against a golden synthetic graph on a disposable SQLite database.
if (!process.env.TYPESAFE_API_KEY) {
  console.error("TYPESAFE_API_KEY is not configured; no provider call made.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Golden set: 25 intentions across 4 projects. Keyword traps share vocabulary
// across projects ("run", "graph", "paper") but are not related.
// ---------------------------------------------------------------------------

const node = (
  id: string,
  project: string,
  title: string,
  description: string,
): typeof NodeInput.Type => ({
  id,
  title,
  description,
  project,
  status: "idea",
  sources: [],
});

const nodes: (typeof NodeInput.Type)[] = [
  // yakjev — this product
  node(
    "y-preview",
    "yakjev",
    "Show live connection previews while typing an intention",
    "As the owner types a new intention, Jev shows which existing nodes it will connect to.",
  ),
  node(
    "y-ghosts",
    "yakjev",
    "Render animated ghost links on the canvas for pending connections",
    "Ghost links preview the connections Jev will make, with strength from relatedness.",
  ),
  node(
    "y-eval",
    "yakjev",
    "Run the Jev eval harness before every deploy",
    "Precision, recall, and latency against the golden synthetic graph.",
  ),
  node(
    "y-deploy",
    "yakjev",
    "Deploy the server to Railway on a public HTTPS domain",
    "Production deployment; the owner token is the only lock.",
  ),
  node(
    "y-corrections",
    "yakjev",
    "Learn from owner corrections to Jev's connections",
    "Removed or reframed Jev edges are fed back to later judgments as corrections.",
  ),
  node(
    "y-golden",
    "yakjev",
    "Maintain the golden synthetic graph with expected connections",
    "Twenty-five intentions across four projects with known true connections.",
  ),
  // garden
  node(
    "g-beds",
    "garden",
    "Build raised beds for the vegetable garden",
    "Two cedar raised beds along the south fence for vegetables.",
  ),
  node(
    "g-compost",
    "garden",
    "Start a compost pile for kitchen scraps",
    "Compost kitchen scraps and yard waste for the beds.",
  ),
  node(
    "g-drip",
    "garden",
    "Install drip irrigation for dry weeks",
    "Drip lines on a timer so the beds survive dry weeks.",
  ),
  node(
    "g-seeds",
    "garden",
    "Order tomato and basil seeds before spring",
    "Seed order must go out before spring planting.",
  ),
  node(
    "g-layout",
    "garden",
    "Sketch the garden layout on graph paper",
    "Plan bed placement and paths on graph paper before building.",
  ),
  node(
    "g-fence",
    "garden",
    "Repair the fence before planting season",
    "Fix the leaning fence posts before anything goes in the ground.",
  ),
  node(
    "g-harvest",
    "garden",
    "Harvest basil weekly once it bushes out",
    "Weekly harvest keeps basil producing through summer.",
  ),
  // fitness
  node(
    "f-5k",
    "fitness",
    "Run a 5k without stopping",
    "Build up to running a full 5k with no walking breaks.",
  ),
  node(
    "f-plan",
    "fitness",
    "Follow a couch-to-5k training plan",
    "Nine-week plan alternating walking and running intervals.",
  ),
  node(
    "f-shoes",
    "fitness",
    "Buy running shoes that fit properly",
    "Get fitted at a running store to avoid injury.",
  ),
  node(
    "f-sleep",
    "fitness",
    "Sleep eight hours before long runs",
    "Recovery sleep the night before long weekend runs.",
  ),
  node(
    "f-marathon",
    "fitness",
    "Decide whether to register for the fall marathon",
    "Registration closes in June; decide after the first 10k.",
  ),
  node(
    "f-stretch",
    "fitness",
    "Stretch for ten minutes after every run",
    "Hip flexors, hamstrings, and calves after each run.",
  ),
  // book
  node(
    "b-outline",
    "book",
    "Outline the chapter on attention",
    "Chapter three covers how attention shapes intention.",
  ),
  node(
    "b-read",
    "book",
    "Finish reading the attention research papers",
    "Six papers left before the attention chapter can be outlined.",
  ),
  node(
    "b-notes",
    "book",
    "Convert reading notes into chapter sections",
    "Each note cluster becomes one section draft.",
  ),
  node(
    "b-editor",
    "book",
    "Find an editor for the manuscript",
    "Ask two colleagues for editor referrals.",
  ),
  node(
    "b-routine",
    "book",
    "Write for one hour before breakfast",
    "Daily morning writing hour, weekdays.",
  ),
  node(
    "b-graph",
    "book",
    "Map the chapter argument as a dependency graph",
    "Draw the argument's claims as a dependency graph to find gaps.",
  ),
];

// ---------------------------------------------------------------------------
// Probes: drafts the owner might type, with the connections Jev should make.
// `same` marks paraphrase duplicates; `relation` is the expected edge kind.
// ---------------------------------------------------------------------------

interface Expectation {
  readonly nodeId: string;
  readonly relation?: string;
  readonly same?: boolean;
}
interface Probe {
  readonly name: string;
  readonly draft: { title: string; description?: string };
  readonly expected: readonly Expectation[];
}

const probes: Probe[] = [
  {
    name: "paraphrase-preview",
    draft: { title: "Show previews of connections live while the owner types" },
    expected: [{ nodeId: "y-preview", same: true }],
  },
  {
    name: "true-prerequisite",
    draft: {
      title: "Provision the Railway service and configure the public domain",
    },
    expected: [{ nodeId: "y-deploy", relation: "requires" }],
  },
  {
    name: "eval-reporting",
    draft: { title: "Measure precision and recall of Jev's connections" },
    expected: [{ nodeId: "y-eval" }, { nodeId: "y-golden" }],
  },
  {
    name: "correction-loop",
    draft: {
      title: "Feed reframed edges back into Jev's later judgments",
      description: "When the owner fixes a Jev connection, remember it.",
    },
    expected: [{ nodeId: "y-corrections", same: true }],
  },
  {
    name: "duplicate-shoes",
    draft: { title: "Buy new running shoes" },
    expected: [{ nodeId: "f-shoes", same: true }],
  },
  {
    name: "trap-run",
    // "run" collides with y-eval's "Run the eval harness" — no yakjev edge.
    draft: { title: "Run a 5k without walking" },
    expected: [{ nodeId: "f-5k", same: true }],
  },
  {
    name: "garden-prerequisites",
    draft: { title: "Plant tomatoes in the new raised beds" },
    expected: [
      { nodeId: "g-beds", relation: "requires" },
      { nodeId: "g-seeds", relation: "requires" },
    ],
  },
  {
    name: "duplicate-stretch",
    draft: { title: "Stretch after running" },
    expected: [{ nodeId: "f-stretch", same: true }],
  },
  {
    name: "marathon-registration",
    draft: {
      title: "Sign up for the fall marathon before registration closes",
    },
    expected: [{ nodeId: "f-marathon", same: true }],
  },
  {
    name: "reading-restated",
    draft: { title: "Read the remaining attention research papers" },
    expected: [{ nodeId: "b-read", same: true }],
  },
  {
    name: "trap-graph",
    // "graph" collides with y-ghosts and g-layout — no cross-project edge.
    draft: { title: "Draw the chapter's argument as a graph of dependencies" },
    expected: [{ nodeId: "b-graph", same: true }],
  },
  {
    name: "compost-care",
    draft: { title: "Turn the compost pile every week" },
    expected: [{ nodeId: "g-compost" }],
  },
  {
    name: "optional-preparation",
    draft: { title: "Keep the garden watered through heat waves" },
    expected: [{ nodeId: "g-drip" }],
  },
  {
    name: "writing-habit",
    draft: { title: "Write for an hour each morning before breakfast" },
    expected: [{ nodeId: "b-routine", same: true }],
  },
  {
    name: "clean-negative",
    // Nothing in the graph is about this; Jev must connect nothing.
    draft: { title: "Schedule a dentist appointment" },
    expected: [],
  },
  // Harder probes: cross-project keyword traps, long descriptions, and
  // partial mid-typing drafts. Keeps the headline metrics honest.
  {
    name: "trap-canvas",
    // "canvas" collides with y-ghosts; a painting frame is not software.
    draft: { title: "Stretch the canvas over the wooden frame" },
    expected: [],
  },
  {
    name: "trap-book-club",
    // "book" and "read" collide with the writing project; a club is not it.
    draft: { title: "Pick the September book club read" },
    expected: [],
  },
  {
    name: "trap-puppy",
    // "train" collides with the couch-to-5k plan; a puppy is not training.
    draft: { title: "Train the puppy to heel on walks" },
    expected: [],
  },
  {
    name: "trap-run-numbers",
    // "run" collides with f-5k and y-eval; budgeting is neither.
    draft: { title: "Run the numbers for next quarter's budget" },
    expected: [],
  },
  {
    name: "long-description",
    draft: {
      title: "Double-dig the new bed and work in compost",
      description:
        "Before spring planting, loosen the soil two spades deep in the newest raised bed, wheel over two barrows of finished compost from the pile by the fence, and turn it through the top layer so the tomatoes start in rich ground.",
    },
    expected: [{ nodeId: "g-beds" }, { nodeId: "g-compost" }],
  },
  {
    name: "mid-typing-two-words",
    // Typed mid-way; the preview fires at >=3 chars, so partial text is real.
    draft: { title: "Buy running" },
    expected: [{ nodeId: "f-shoes" }],
  },
  {
    name: "mid-typing-fragment",
    draft: { title: "Order tomato and" },
    expected: [{ nodeId: "g-seeds" }],
  },
  {
    name: "paraphrase-hard",
    draft: { title: "Sketch out the argument's dependencies for the chapter" },
    expected: [{ nodeId: "b-graph", same: true }],
  },
  {
    name: "paraphrase-referrals",
    draft: { title: "Get editor referrals from two colleagues" },
    expected: [{ nodeId: "b-editor", same: true }],
  },
  {
    name: "benefits-warmup",
    draft: { title: "Jog slowly for ten minutes before interval days" },
    expected: [{ nodeId: "f-plan" }],
  },
  {
    name: "clean-negative-errand",
    draft: { title: "Renew the car insurance" },
    expected: [],
  },
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const arg = (name: string) => {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? Number(found.slice(prefix.length)) : undefined;
};
const minPrecision = arg("min-precision");
const minRecall = arg("min-recall");

const dir = await mkdtemp(`${tmpdir()}/yakjev-jev-eval-`);
const origin = "http://yakjev-synthetic.test";
const app = createApp({
  origin,
  ownerToken: "synthetic-jev-eval-owner-token-not-a-secret",
  databasePath: `${dir}/graph.sqlite`,
  webRoot: `${dir}/web`,
});
const request = (path: string, body: unknown) =>
  app.fetch(
    new Request(`${origin}${path}`, {
      method: "POST",
      headers: {
        authorization: "Bearer synthetic-jev-eval-owner-token-not-a-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );

interface ProbeResult {
  readonly name: string;
  readonly status: Preview["status"] | "http-error";
  readonly wallMs: number;
  readonly elapsedMs: number | null;
  readonly connected: readonly string[];
  readonly expected: readonly Expectation[];
  readonly tp: readonly string[];
  readonly fp: readonly string[];
  readonly fn: readonly Expectation[];
  readonly relationMisses: readonly string[];
  readonly sameMisses: readonly string[];
  readonly preview: Preview | null;
}

const results: ProbeResult[] = [];
try {
  await app.ready();
  const seeded = await request("/api/commands", {
    requestId: "jev-eval-seed",
    expectedRevision: 0,
    command: {
      type: "capture",
      capture: {
        id: "jev-eval-seed",
        text: "Golden synthetic graph for the Jev preview eval. Not fetched.",
        sources: [],
        nodeIds: nodes.map((item) => item.id),
      },
      nodes,
      edges: [],
      autoConnect: false,
    },
  });
  if (seeded.status !== 200)
    throw new Error(`Seeding failed: ${seeded.status} ${await seeded.text()}`);

  for (const probe of probes) {
    const started = performance.now();
    const response = await request("/api/jev/preview", { draft: probe.draft });
    const wallMs = Math.round(performance.now() - started);
    if (response.status !== 200) {
      results.push({
        name: probe.name,
        status: "http-error",
        wallMs,
        elapsedMs: null,
        connected: [],
        expected: probe.expected,
        tp: [],
        fp: [],
        fn: probe.expected,
        relationMisses: [],
        sameMisses: [],
        preview: null,
      });
      continue;
    }
    const preview: Preview = await response.json();
    const connected = preview.judgments
      .filter((judgment) => judgment.connect)
      .map((judgment) => judgment.nodeId);
    const expectedIds = probe.expected.map((item) => item.nodeId);
    const tp = connected.filter((id) => expectedIds.includes(id));
    const fp = connected.filter((id) => !expectedIds.includes(id));
    const fn = probe.expected.filter(
      (item) => !connected.includes(item.nodeId),
    );
    const relationMisses = probe.expected
      .filter((item) => item.relation !== undefined && tp.includes(item.nodeId))
      .filter(
        (item) =>
          preview.judgments.find((judgment) => judgment.nodeId === item.nodeId)
            ?.relation !== item.relation,
      )
      .map((item) => item.nodeId);
    const sameMisses = probe.expected
      .filter((item) => item.same && tp.includes(item.nodeId))
      .filter(
        (item) =>
          preview.judgments.find((judgment) => judgment.nodeId === item.nodeId)
            ?.same !== true,
      )
      .map((item) => item.nodeId);
    results.push({
      name: probe.name,
      status: preview.status,
      wallMs,
      elapsedMs: preview.elapsedMs,
      connected,
      expected: probe.expected,
      tp,
      fp,
      fn,
      relationMisses,
      sameMisses,
      preview,
    });
  }
} finally {
  await app.close();
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const totals = results.reduce(
  (sum, result) => ({
    tp: sum.tp + result.tp.length,
    fp: sum.fp + result.fp.length,
    fn: sum.fn + result.fn.length,
  }),
  { tp: 0, fp: 0, fn: 0 },
);
const precision =
  totals.tp + totals.fp === 0 ? 1 : totals.tp / (totals.tp + totals.fp);
const recall =
  totals.tp + totals.fn === 0 ? 1 : totals.tp / (totals.tp + totals.fn);
const latencies = results.map((result) => result.wallMs).sort((a, b) => a - b);
const percentile = (p: number) =>
  latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] ??
  0;
const failed = results.filter((result) => result.status !== "succeeded");

console.log("");
console.log(
  "probe                  P     R     wall  connected (✓ hit · ✗ false · − missed)",
);
for (const result of results) {
  const p =
    result.connected.length === 0
      ? result.expected.length === 0
        ? 1
        : 0
      : result.tp.length / result.connected.length;
  const r =
    result.expected.length === 0
      ? result.connected.length === 0
        ? 1
        : 0
      : result.tp.length / result.expected.length;
  const detail = [
    ...result.tp.map((id) => `${id}✓`),
    ...result.fp.map((id) => `${id}✗`),
    ...result.fn.map((item) => `${item.nodeId}−`),
  ].join(" ");
  const misses = [
    ...result.relationMisses.map((id) => `${id}:relation`),
    ...result.sameMisses.map((id) => `${id}:same`),
  ];
  console.log(
    `${result.name.padEnd(22)} ${p.toFixed(2)}  ${r.toFixed(2)}  ${String(result.wallMs).padStart(4)}ms  ${detail}${misses.length ? `  miss:${misses.join(",")}` : ""}${result.status !== "succeeded" ? `  STATUS:${result.status}` : ""}`,
  );
}
console.log("");
console.log(
  `precision ${precision.toFixed(3)} (${totals.tp}tp ${totals.fp}fp) · recall ${recall.toFixed(3)} (${totals.tp}tp ${totals.fn}fn) · latency p50 ${percentile(0.5)}ms p95 ${percentile(0.95)}ms max ${latencies[latencies.length - 1] ?? 0}ms · ${results.length} probes`,
);

const receiptDir = ".data/jev-eval";
await mkdir(receiptDir, { recursive: true });
const receiptPath = `${receiptDir}/${new Date().toISOString().replaceAll(":", "-")}.json`;
await writeFile(
  receiptPath,
  JSON.stringify(
    {
      synthetic: true,
      actualProviderCalls: true,
      at: new Date().toISOString(),
      metrics: {
        precision,
        recall,
        ...totals,
        latency: {
          p50: percentile(0.5),
          p95: percentile(0.95),
          max: latencies[latencies.length - 1] ?? 0,
        },
      },
      results,
    },
    null,
    2,
  ),
);
console.log(`receipt: ${receiptPath}`);

if (failed.length > 0) {
  console.error(
    `${failed.length} probe(s) did not succeed: ${failed.map((result) => result.name).join(", ")}`,
  );
  process.exit(1);
}
if (minPrecision !== undefined && precision < minPrecision) {
  console.error(`precision ${precision.toFixed(3)} < ${minPrecision}`);
  process.exit(1);
}
if (minRecall !== undefined && recall < minRecall) {
  console.error(`recall ${recall.toFixed(3)} < ${minRecall}`);
  process.exit(1);
}
