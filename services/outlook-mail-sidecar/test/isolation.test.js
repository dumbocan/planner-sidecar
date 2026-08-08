import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

test("Compose isolates Outlook MCP from the host and separates internal and egress networks", async () => {
  const compose = await text("docker-compose2.yml");
  const block =
    compose.match(/  outlook-mail-sidecar:[\s\S]*?(?=\n  [a-z][^\n]+:|\nnetworks:)/)?.[0] ?? "";
  assert.match(block, /read_only: true/);
  assert.match(block, /cap_drop:\s*\n\s*- ALL/);
  assert.match(block, /no-new-privileges:true/);
  assert.match(block, /outlook-mcp-internal/);
  assert.match(block, /outlook-egress/);
  assert.match(block, /pdf-mcp-internal/);
  assert.doesNotMatch(block, /\n\s*ports:/);
});

test("OpenClaw registers the read-only Outlook tools for main", async () => {
  const config = JSON.parse(await text("state/openclaw.json"));
  const expectedTools = [
    "outlook_list_folders",
    "outlook_list_messages",
    "outlook_search_messages",
    "outlook_get_sanitized_message",
    "outlook_list_pdf_attachments",
    "outlook_extract_pdf_attachment",
  ];
  const expectedPolicyNames = expectedTools.map((name) => `outlook-mail__${name}`);
  assert.deepEqual(config.mcp.servers["outlook-mail"].toolFilter.include, expectedTools);
  assert.deepEqual(config.mcp.servers["outlook-mail"].codex.agents, ["main"]);
  assert.ok(expectedPolicyNames.every((name) => config.tools.allow.includes(name)));
  const channelTools = config.channels.telegram.direct["1345901933"].tools.allow;
  assert.ok(expectedPolicyNames.every((name) => channelTools.includes(name)));
});

test("isolated-agent projection permits only Outlook read tools and explicitly denies mutations", async () => {
  const projection = JSON.parse(
    await text("services/outlook-mail-sidecar/openclaw-isolated-agent.example.json"),
  );
  const agent = projection.agents.list[0];
  assert.deepEqual(agent.tools.allow, [
    "outlook-mail__outlook_list_folders",
    "outlook-mail__outlook_list_messages",
    "outlook-mail__outlook_search_messages",
    "outlook-mail__outlook_get_sanitized_message",
  ]);
  assert.ok(agent.tools.deny.includes("outlook-mail__outlook_send"));
  assert.ok(agent.tools.deny.includes("outlook-mail__outlook_delete"));
  const channel = projection.channels.telegram.direct["<outlook-reader-peer-id>"];
  assert.deepEqual(channel.tools.allow, agent.tools.allow);
  assert.ok(channel.tools.deny.includes("outlook-mail__outlook_reply"));
  assert.equal(
    agent.tools.allow.some((name) => /^(exec|shell|http|fetch|browser)$/.test(name)),
    false,
  );
});
