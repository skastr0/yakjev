import { createClient } from "@yakjev/client";
import {
  acceptanceToken,
  startServer,
} from "../../../tests/acceptance/harness";

// The existing real server, a disposable database, and a synthetic credential.
// No provider credentials are inherited; Jev reports unavailable honestly.
const server = await startServer();
try {
  const client = createClient({
    baseUrl: server.origin,
    token: acceptanceToken,
  });
  const nodes = [
    { id: "mobile-release", title: "Ship Yakjev for iPhone", x: 0, y: 0 },
    {
      id: "native-graph",
      title: "Make the graph feel alive",
      x: -230,
      y: -100,
    },
    { id: "gestures", title: "Explore with natural gestures", x: -440, y: 65 },
    {
      id: "shared-server",
      title: "One graph across every device",
      x: 240,
      y: -110,
    },
    { id: "context", title: "Give Jev useful context", x: 250, y: 140 },
    { id: "weekend", title: "Plan a quiet weekend", x: -80, y: 235 },
  ];
  let revision = 0;
  for (const node of nodes) {
    const result = await client.sendCommand(
      {
        type: "node.put",
        node: {
          id: node.id,
          title: node.title,
          description: "Synthetic fixture for mobile runtime checks.",
          project: node.id === "weekend" ? "Personal" : "Yakjev",
          status: node.id === "native-graph" ? "active" : "idea",
          sources: [],
        },
      },
      revision,
    );
    revision = result.receipt.revision;
  }
  for (const [source, target, relation] of [
    ["mobile-release", "native-graph", "requires"],
    ["native-graph", "gestures", "benefits_from"],
    ["mobile-release", "shared-server", "requires"],
    ["shared-server", "context", "related_to"],
  ] as const) {
    const result = await client.sendCommand(
      {
        type: "edge.put",
        edge: {
          id: `${source}-${target}`,
          source,
          target,
          relation,
          rationale: "Synthetic fixture connection, created explicitly.",
        },
      },
      revision,
    );
    revision = result.receipt.revision;
  }
  await client.saveLayout(nodes.map(({ id, x, y }) => ({ id, x, y })));
  console.log(
    JSON.stringify(
      {
        server: server.origin,
        syntheticOwnerToken: acceptanceToken,
        revision,
        nodes: nodes.length,
        note: "Disposable local data. Jev is unavailable. Ctrl-C stops the server and removes its database.",
      },
      null,
      2,
    ),
  );
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  await server.stop();
}
