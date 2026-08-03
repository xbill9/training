import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Drive the server the way a client does: newline-delimited JSON-RPC on stdio.
// Anything less would test our own code rather than the wiring the SDK does.
function startServer() {
  const child = spawn(process.execPath, [resolve(root, "src/mcp-server.js")], {
    cwd: root,
    env: { ...process.env, TRAINING_DIR: root },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const resolver = pending.get(message.id);
      if (resolver) { pending.delete(message.id); resolver(message); }
    }
  });

  let nextId = 1;
  const send = (method, params) => new Promise((resolveResponse, reject) => {
    const id = nextId++;
    pending.set(id, resolveResponse);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => reject(new Error(`${method} timed out`)), 20000).unref();
  });
  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };

  return { child, send, notify, stop: () => child.kill() };
}

async function withServer(run) {
  const server = startServer();
  try {
    const initialized = await server.send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" }
    });
    assert.equal(initialized.result.serverInfo.name, "partner-training");
    server.notify("notifications/initialized", {});
    await run(server);
  } finally {
    server.stop();
  }
}

test("handshake and tool listing", async () => {
  await withServer(async (server) => {
    const listed = await server.send("tools/list", {});
    const names = listed.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "find_activity", "import_scan", "list_paths",
      "next_up", "path_detail", "refresh_from_site", "training_summary"
    ]);
    // Every tool must describe itself, or a client cannot choose between them.
    for (const tool of listed.result.tools) {
      assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a description`);
    }
  });
});

test("training_summary reports real counts from the Markdown database", async () => {
  await withServer(async (server) => {
    const response = await server.send("tools/call", { name: "training_summary", arguments: {} });
    const body = response.result.content[0].text;
    assert.match(body, /# Training summary/);
    assert.match(body, /\*\*Paths\*\* — \d+ finished/);
    assert.match(body, /\*\*Outstanding\*\*: \d+ slots = \d+ distinct/);
    assert.match(body, /Top recommendation:/);
  });
});

test("next_up returns each ranking section", async () => {
  await withServer(async (server) => {
    for (const section of ["quick_wins", "leverage", "stalled", "blocked", "near_miss"]) {
      const response = await server.send("tools/call", { name: "next_up", arguments: { section, limit: 3 } });
      assert.ok(response.result.content[0].text.length > 10, `${section} returned nothing`);
    }
  });
});

test("find_activity locates a course and lists the paths holding it", async () => {
  await withServer(async (server) => {
    const response = await server.send("tools/call", {
      name: "find_activity",
      arguments: { query: "migration center servers" }
    });
    const body = response.result.content[0].text;
    assert.match(body, /Introduction to Migration Center Servers Assessments/i);
    assert.match(body, /In \d+ path\(s\)/);
    // The URL must be the openable form, not the bare /focuses/ one.
    assert.match(body, /focuses\/\d+\?parent=catalog&path=\d+/);
  });
});

test("path_detail splits outstanding from completed work", async () => {
  await withServer(async (server) => {
    const response = await server.send("tools/call", { name: "path_detail", arguments: { path: "4343" } });
    const body = response.result.content[0].text;
    assert.match(body, /## Outstanding \(\d+\)/);
    assert.match(body, /## Completed \(\d+\)/);
  });
});

test("a bad query answers instead of crashing", async () => {
  await withServer(async (server) => {
    const response = await server.send("tools/call", {
      name: "find_activity",
      arguments: { query: "zzzz-no-such-course" }
    });
    assert.match(response.result.content[0].text, /No activity matching/);
  });
});
