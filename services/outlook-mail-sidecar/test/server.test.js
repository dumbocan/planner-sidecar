import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createServiceTools } from "../src/server.js";
import { persistClientId } from "../src/setup.js";

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";

function stubPdfToolClient() {
  return { extract: async () => ({ text: "stub", pages: 1, truncated: false }) };
}

test("createServiceTools loads the persisted client ID used by the container", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "outlook-server-"));
  try {
    await persistClientId({ stateDir, clientId: CLIENT_ID });
    let receivedClientId;
    const tools = await createServiceTools({
      stateDir,
      env: {},
      createAuthClientImpl: async ({ clientId }) => {
        receivedClientId = clientId;
        return {};
      },
      createGraphClientImpl: () => ({
        listFolders: async () => [],
        listMessages: async () => [],
        getMessage: async () => ({}),
        listMessageAttachments: async () => [],
        getAttachmentMetadata: async () => ({}),
        getAttachmentRawContent: async () => Buffer.alloc(0),
      }),
      createPdfToolClientImpl: stubPdfToolClient,
    });
    assert.equal(receivedClientId, CLIENT_ID);
    assert.equal(typeof tools.listFolders, "function");
    assert.equal(typeof tools.listPdfAttachments, "function");
    assert.equal(typeof tools.extractPdfAttachment, "function");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});