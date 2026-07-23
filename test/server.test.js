import assert from "node:assert/strict";
import test from "node:test";
import { listen, plannerFailure } from "../src/server.js";

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

test("plannerFailure returns the generic envelope and logs the constructor name only", () => {
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
