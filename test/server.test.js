import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRuntime, listen, plannerFailure, plannerSuccess } from "../src/server.js";

test("createRuntime builds real auth and Graph clients without PLANNER_CLIENT_ID", async () => {
  const originalClientId = process.env.PLANNER_CLIENT_ID;
  const stateDir = await mkdtemp(path.join(tmpdir(), "planner-sidecar-server-"));
  try {
    delete process.env.PLANNER_CLIENT_ID;
    const runtime = createRuntime({ stateDir });
    assert.equal(typeof runtime.auth.acquireToken, "function");
    assert.equal(typeof runtime.graph.getMe, "function");
    assert.equal(typeof runtime.graph.listPlans, "function");
    assert.deepEqual(await runtime.auth.getStatus(), { connected: false, expiresAt: null });
  } finally {
    if (originalClientId === undefined) delete process.env.PLANNER_CLIENT_ID;
    else process.env.PLANNER_CLIENT_ID = originalClientId;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("GET /healthz returns 200 ok on a random port", async () => {
  const handle = await listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  } finally {
    await handle.close();
  }
});

test("non-/healthz paths return 404 on the same listener", async () => {
  const handle = await listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/anything-else`);
    assert.equal(response.status, 404);
  } finally {
    await handle.close();
  }
});

test("non-GET methods on /healthz return 404", async () => {
  const handle = await listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/healthz`, { method: "POST" });
    assert.equal(response.status, 404);
  } finally {
    await handle.close();
  }
});

test("non-POST/GET/DELETE methods on /mcp return 405", async () => {
  const handle = await listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/mcp`, { method: "PUT" });
    assert.equal(response.status, 405);
  } finally {
    await handle.close();
  }
});

test("plannerFailure returns the generic envelope for non-GraphError and logs constructor name only", () => {
  const logs = [];
  const original = console.error;
  console.error = (line) => logs.push(line);
  try {
    const response = plannerFailure("planner_list_plans", new Error("secret message"));
    assert.equal(response.isError, true);
    assert.equal(response.content[0].text, "Planner sidecar is unavailable.");
    const parsed = JSON.parse(logs[0]);
    assert.deepEqual(parsed, {
      event: "planner_tool_failure",
      tool: "planner_list_plans",
      error: "Error",
    });
    assert.equal(logs.join("\n").includes("secret message"), false);
  } finally {
    console.error = original;
  }
});

test("plannerFailure returns specific message for GraphError 404", () => {
  class GraphError extends Error {
    constructor(message, { status }) { super(message); this.name = "GraphError"; this.status = status; }
  }
  const logs = [];
  const original = console.error;
  console.error = (line) => logs.push(line);
  try {
    const response = plannerFailure("planner_get_task", new GraphError("not found", { status: 404 }));
    assert.equal(response.isError, true);
    assert.equal(
      response.content[0].text,
      "The requested Planner item was not found. It may have been deleted or the identifier is incorrect.",
    );
  } finally {
    console.error = original;
  }
});

test("plannerFailure returns specific message for GraphError 401", () => {
  class GraphError extends Error {
    constructor(message, { status }) { super(message); this.name = "GraphError"; this.status = status; }
  }
  const logs = [];
  const original = console.error;
  console.error = (line) => logs.push(line);
  try {
    const response = plannerFailure("planner_list_plans", new GraphError("unauthorized", { status: 401 }));
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /planner-sidecar onboard/);
  } finally {
    console.error = original;
  }
});

test("plannerFailure returns specific message for GraphError 500", () => {
  class GraphError extends Error {
    constructor(message, { status }) { super(message); this.name = "GraphError"; this.status = status; }
  }
  const logs = [];
  const original = console.error;
  console.error = (line) => logs.push(line);
  try {
    const response = plannerFailure("planner_list_plans", new GraphError("server error", { status: 500 }));
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /status 500/);
  } finally {
    console.error = original;
  }
});

test("plannerSuccess logs a single structured audit line with no content leakage", () => {
  const logs = [];
  const original = console.error;
  console.error = (line) => logs.push(line);
  try {
    const response = plannerSuccess("planner_list_plans", "default", [{ id: "p1" }], 0);
    assert.equal(response.isError, undefined);
    assert.equal(JSON.parse(response.content[0].text)[0].id, "p1");
    const parsed = JSON.parse(logs[0]);
    assert.deepEqual(parsed, {
      event: "planner_tool_call",
      tool: "planner_list_plans",
      profile: "default",
      result_count: 1,
      duration_ms: parsed.duration_ms,
    });
    assert.equal(logs.join("\n").includes("p1"), false);
  } finally {
    console.error = original;
  }
});
