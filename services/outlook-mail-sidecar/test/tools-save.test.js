import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { OUTLOOK_TOOL_NAMES, createReadTools } from "../src/tools.js";

function stubPdfToolClient() {
  return { extract: async () => ({ text: "stub", pages: 1, truncated: false }) };
}

function pdfBuffer() {
  return Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(32, 0)]);
}

test("exposes outlook_save_pdf_attachment in the read-only tool inventory", () => {
  assert.ok(OUTLOOK_TOOL_NAMES.includes("outlook_save_pdf_attachment"));
});

test("savePdfAttachment requires confirm:true", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "outlook-save-"));
  try {
    const graph = {
      getAttachmentMetadata: async () => ({}),
      getAttachmentRawContent: async () => Buffer.alloc(0),
    };
    const tools = createReadTools(graph, { pdfToolClient: stubPdfToolClient(), stateDir });
    await assert.rejects(
      () =>
        tools.savePdfAttachment({
          messageId: "msg-1",
          attachmentId: "att-1",
          outDir: "invoices",
        }),
      /confirm/,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("savePdfAttachment rejects outDir path traversal", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "outlook-save-"));
  try {
    const graph = {
      getAttachmentMetadata: async () => ({}),
      getAttachmentRawContent: async () => Buffer.alloc(0),
    };
    const tools = createReadTools(graph, { pdfToolClient: stubPdfToolClient(), stateDir });
    for (const bad of ["../etc", "foo/../../bar", "/abs/path"]) {
      await assert.rejects(
        () =>
          tools.savePdfAttachment({
            messageId: "msg-1",
            attachmentId: "att-1",
            confirm: true,
            outDir: bad,
          }),
        /configured root|too long/,
      );
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("savePdfAttachment writes the PDF bytes to the resolved path and reports trust boundary", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "outlook-save-"));
  try {
    let metaCalls = 0;
    let rawCalls = 0;
    const graph = {
      getAttachmentMetadata: async (messageId, attachmentId) => {
        metaCalls += 1;
        return {
          id: attachmentId,
          name: "A-G2026-385710.pdf",
          contentType: "text/plain",
          size: 9999,
          isInline: false,
          "@odata.type": "#microsoft.graph.fileAttachment",
        };
      },
      getAttachmentRawContent: async () => {
        rawCalls += 1;
        return pdfBuffer();
      },
    };
    const tools = createReadTools(graph, { pdfToolClient: stubPdfToolClient(), stateDir });
    const result = await tools.savePdfAttachment({
      messageId: "msg-1",
      attachmentId: "att-mercadona",
      confirm: true,
      outDir: "attachments/mercadona",
    });
    assert.equal(metaCalls, 1);
    assert.equal(rawCalls, 1);
    assert.equal(result.attachmentName, "A-G2026-385710.pdf");
    assert.equal(result.size, pdfBuffer().length);
    assert.equal(result.savedPath, path.join(stateDir, "attachments/mercadona", "A-G2026-385710.pdf"));
    assert.equal(result.contentType, "text/plain");

    const written = await readFile(result.savedPath);
    assert.equal(written.length, pdfBuffer().length);
    assert.equal(written.subarray(0, 5).toString("ascii"), "%PDF-");
    const st = await stat(result.savedPath);
    assert.equal(st.size, pdfBuffer().length);
    assert.match(result.trustBoundary, /untrusted/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("savePdfAttachment sanitizes filenames with path separators and never writes outside stateDir", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "outlook-save-"));
  try {
    const graph = {
      getAttachmentMetadata: async () => ({
        id: "att-1",
        name: "../../etc/passwd",
        contentType: "application/pdf",
        size: 1024,
        isInline: false,
        "@odata.type": "#microsoft.graph.fileAttachment",
      }),
      getAttachmentRawContent: async () => pdfBuffer(),
    };
    const tools = createReadTools(graph, { pdfToolClient: stubPdfToolClient(), stateDir });
    const result = await tools.savePdfAttachment({
      messageId: "msg-1",
      attachmentId: "att-1",
      confirm: true,
      outDir: "invoices",
    });
    assert.equal(result.attachmentName.includes("/"), false);
    assert.equal(result.attachmentName.includes("\\"), false);
    assert.equal(result.attachmentName.endsWith(".pdf"), true);
    assert.equal(result.savedPath.startsWith(stateDir), true);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("savePdfAttachment rejects payloads without PDF magic", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "outlook-save-"));
  try {
    const graph = {
      getAttachmentMetadata: async () => ({
        id: "att-1",
        name: "fake.pdf",
        contentType: "application/pdf",
        size: 1024,
        isInline: false,
        "@odata.type": "#microsoft.graph.fileAttachment",
      }),
      getAttachmentRawContent: async () => Buffer.from("not a pdf"),
    };
    const tools = createReadTools(graph, { pdfToolClient: stubPdfToolClient(), stateDir });
    await assert.rejects(
      () =>
        tools.savePdfAttachment({
          messageId: "msg-1",
          attachmentId: "att-1",
          confirm: true,
          outDir: "invoices",
        }),
      /magic/,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("savePdfAttachment rejects empty buffers", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "outlook-save-"));
  try {
    const graph = {
      getAttachmentMetadata: async () => ({
        id: "att-1",
        name: "empty.pdf",
        contentType: "application/pdf",
        size: 0,
        isInline: false,
        "@odata.type": "#microsoft.graph.fileAttachment",
      }),
      getAttachmentRawContent: async () => Buffer.alloc(0),
    };
    const tools = createReadTools(graph, { pdfToolClient: stubPdfToolClient(), stateDir });
    await assert.rejects(
      () =>
        tools.savePdfAttachment({
          messageId: "msg-1",
          attachmentId: "att-1",
          confirm: true,
          outDir: "invoices",
        }),
      /empty/,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("savePdfAttachment requires stateDir dependency", async () => {
  const graph = {
    getAttachmentMetadata: async () => ({}),
    getAttachmentRawContent: async () => Buffer.alloc(0),
  };
  const tools = createReadTools(graph, { pdfToolClient: stubPdfToolClient() });
  await assert.rejects(
    () =>
      tools.savePdfAttachment({
        messageId: "msg-1",
        attachmentId: "att-1",
        confirm: true,
        outDir: "invoices",
      }),
    /stateDir/,
  );
});
