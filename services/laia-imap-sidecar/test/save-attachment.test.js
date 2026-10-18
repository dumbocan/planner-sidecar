import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createMailTools } from "../src/tools.js";

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64, 0)]);

function toolsWith(workspaceRoot, override) {
  return createMailTools({
    state: {},
    intake: {
      fetchAttachmentPart: async () => ({
        data: PDF,
        filename: "Factura 001.pdf",
        folder: "INBOX.Bornay",
        part: "2",
        type: "application/pdf",
        size: PDF.length,
      }),
      ...override,
    },
    workspaceRoot,
  });
}

const base = {
  folder: "INBOX.Bornay",
  uid: 7,
  part: "2",
  outDir: "comercios/2026-10-18/Bornay",
  confirm: true,
};

test("mail_save_attachment requires confirm:true", async () => {
  const tools = toolsWith(tmpdir());
  await assert.rejects(
    tools.savePdfAttachment({ ...base, confirm: false }),
    /confirm:true/,
  );
  await assert.rejects(
    tools.savePdfAttachment({ ...base, confirm: undefined }),
    /confirm:true/,
  );
});

test("mail_save_attachment fails closed without a workspace root", async () => {
  const tools = createMailTools({
    state: {},
    intake: { fetchAttachmentPart: async () => ({ data: PDF }) },
  });
  await assert.rejects(
    tools.savePdfAttachment(base),
    /workspaceRoot is not configured/,
  );
});

test("mail_save_attachment refuses outDir traversal", async () => {
  const tools = toolsWith(tmpdir());
  await assert.rejects(
    tools.savePdfAttachment({ ...base, outDir: "../escape" }),
    /inside the configured workspace root/,
  );
});

test("mail_save_attachment rejects a non-PDF payload", async () => {
  const tools = toolsWith(tmpdir(), {
    fetchAttachmentPart: async () => ({
      data: Buffer.from("not a pdf at all"),
      filename: "fake.pdf",
    }),
  });
  await assert.rejects(tools.savePdfAttachment(base), /PDF/);
});

test("mail_save_attachment saves once and dedupes by sha256", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "imap-save-"));
  try {
    const tools = toolsWith(dir);
    const first = await tools.savePdfAttachment(base);
    assert.equal(first.deduplicated, false);
    assert.equal(first.path, path.join("comercios", "2026-10-18", "Bornay", "Factura 001.pdf"));
    assert.equal(first.size, PDF.length);
    const written = await readFile(path.join(dir, first.path));
    assert.equal(written.length, PDF.length);

    const second = await tools.savePdfAttachment(base);
    assert.equal(second.deduplicated, true, "second save must not rewrite the file");
    assert.equal(second.sha256, first.sha256);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mail_save_attachment sanitizes the stored filename", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "imap-save-"));
  try {
    const tools = toolsWith(dir, {
      fetchAttachmentPart: async () => ({
        data: PDF,
        filename: "../../etc/passwd",
        part: "2",
      }),
    });
    const saved = await tools.savePdfAttachment(base);
    assert.ok(!saved.filename.includes(".."), "stored name must not carry a traversal segment");
    assert.ok(!saved.path.includes(".."));
    assert.ok(saved.filename.toLowerCase().endsWith(".pdf"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
