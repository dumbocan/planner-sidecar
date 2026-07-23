import assert from "node:assert/strict";
import test from "node:test";
import { listen } from "../src/server.js";

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
