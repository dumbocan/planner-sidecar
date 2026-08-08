import assert from "node:assert/strict";
import test from "node:test";
import { OUTLOOK_TOOL_NAMES, createReadTools } from "../src/tools.js";

function stubPdfToolClient(impl) {
  return { extract: impl ?? (async () => ({ text: "stub", pages: 1, truncated: false })) };
}

test("exposes the Outlook read-only and manual-PDF tool inventory", () => {
  assert.deepEqual(OUTLOOK_TOOL_NAMES, [
    "outlook_list_folders",
    "outlook_list_messages",
    "outlook_search_messages",
    "outlook_get_sanitized_message",
    "outlook_list_attachments",
    "outlook_list_pdf_attachments",
    "outlook_extract_pdf_attachment",
    "outlook_save_pdf_attachment",
  ]);
  // No write/mutation tool may live in the inventory. PDF reads are still
  // strictly manual-only: there is no auto-download or batch tool.
  assert.equal(
    OUTLOOK_TOOL_NAMES.some((name) =>
      /send|reply|draft|move|delete|flag|write|forward/i.test(name),
    ),
    false,
  );
});

test("bounds list and search inputs and returns only the opaque handles needed for follow-up reads", async () => {
  const calls = [];
  const graph = {
    listFolders: async () => [{ id: "folder-id", displayName: "Junk Email", childFolderCount: 0 }],
    listMessages: async (input) => {
      calls.push(input);
      return [{ id: "message-id", subject: "Subject" }];
    },
    getMessage: async () => ({
      id: "message-id",
      subject: "Subject",
      body: { contentType: "text", content: "Body" },
    }),
  };
  const tools = createReadTools(graph, { pdfToolClient: stubPdfToolClient() });
  const folders = await tools.listFolders({ limit: 999 });
  const messages = await tools.listMessages({ folderId: "folder-id", limit: 999 });
  const search = await tools.searchMessages({ query: "hello", folderId: "folder-id", limit: 999 });
  const message = await tools.getSanitizedMessage({ messageId: "message-id" });

  assert.equal(folders[0].folderId, "folder-id");
  assert.equal(folders[0].displayName, "Junk Email");
  assert.equal(messages[0].messageId, "message-id");
  assert.equal(search[0].messageId, "message-id");
  assert.equal(message.id, undefined);
  assert.equal(calls[0].top, 50);
  assert.equal(calls[1].top, 50);
});

test("listPdfAttachments filters to PDF-only rows and returns sanitized metadata", async () => {
  const graph = {
    listMessageAttachments: async () => [
      {
        id: "att-pdf-1",
        name: "report.pdf",
        contentType: "application/pdf",
        size: 1024,
        isInline: false,
        "@odata.type": "#microsoft.graph.fileAttachment",
      },
      {
        id: "att-image-1",
        name: "logo.png",
        contentType: "image/png",
        size: 4096,
        isInline: true,
        "@odata.type": "#microsoft.graph.fileAttachment",
      },
      {
        id: "att-pdf-2",
        name: "invoice.PDF",
        contentType: "Application/PDF",
        size: 2048,
        isInline: false,
        "@odata.type": "#microsoft.graph.fileAttachment",
      },
      {
        id: "att-item",
        name: "ForwardedMessage",
        contentType: "message/rfc822",
        size: 8192,
        isInline: false,
        "@odata.type": "#microsoft.graph.itemAttachment",
      },
    ],
  };
  const tools = createReadTools(graph, { pdfToolClient: stubPdfToolClient() });
  const list = await tools.listPdfAttachments({ messageId: "msg-1" });
  assert.equal(list.length, 2);
  assert.equal(list[0].attachmentId, "att-pdf-1");
  assert.equal(list[0].name, "report.pdf");
  assert.match(list[0].trustBoundary, /untrusted/);
  assert.equal(list[0].isPdf, true);
  assert.equal(list[0].kind, "file");
  assert.equal(list[1].attachmentId, "att-pdf-2");
  // Image and item attachments must not be exposed.
  assert.equal(list.some((row) => row.attachmentId === "att-image-1"), false);
  assert.equal(list.some((row) => row.attachmentId === "att-item"), false);
});

test("listPdfAttachments matches .pdf filename even when contentType is mislabeled (Mercadona case)", async () => {
  // Mercadona sends invoices as fileAttachment rows named A-G2026-XXXX.pdf
  // but with contentType: text/plain. The MIME-only filter used to drop them.
  const graph = {
    listMessageAttachments: async () => [
      {
        id: "att-mercadona",
        name: "A-G2026-385710.pdf",
        contentType: "text/plain",
        size: 366883,
        isInline: false,
        "@odata.type": "#microsoft.graph.fileAttachment",
      },
      {
        id: "att-image",
        name: "logo.png",
        contentType: "image/png",
        size: 4096,
        isInline: true,
        "@odata.type": "#microsoft.graph.fileAttachment",
      },
      {
        id: "att-item",
        name: "factura.pdf",
        contentType: "message/rfc822",
        size: 8192,
        isInline: false,
        "@odata.type": "#microsoft.graph.itemAttachment",
      },
    ],
  };
  const tools = createReadTools(graph, { pdfToolClient: stubPdfToolClient() });
  const list = await tools.listPdfAttachments({ messageId: "msg-1" });
  assert.equal(list.length, 1);
  assert.equal(list[0].attachmentId, "att-mercadona");
  assert.equal(list[0].name, "A-G2026-385710.pdf");
  assert.equal(list[0].contentType, "text/plain");
  assert.equal(list[0].isPdf, true);
  assert.equal(list[0].kind, "file");
  // Item attachments are still excluded even when their name ends in .pdf.
  assert.equal(list.some((row) => row.attachmentId === "att-item"), false);
});

test("listAttachments returns classified safe metadata for all three attachment kinds", async () => {
  const graph = {
    listMessageAttachments: async () => [
      {
        id: "att-file",
        name: "A-G2026-385710.pdf",
        contentType: "text/plain",
        size: 366883,
        isInline: false,
        "@odata.type": "#microsoft.graph.fileAttachment",
      },
      {
        id: "att-item",
        name: "ForwardedMessage",
        contentType: "message/rfc822",
        size: 8192,
        isInline: false,
        "@odata.type": "#microsoft.graph.itemAttachment",
      },
      {
        id: "att-ref",
        name: "cloud-invoice.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 1060,
        isInline: true,
        sourceUrl: "https://example.invalid/redacted",
        providerType: "oneDriveBusiness",
        "@odata.type": "#microsoft.graph.referenceAttachment",
      },
      {
        id: "att-image",
        name: "logo.png",
        contentType: "image/png",
        size: 4096,
        isInline: true,
        "@odata.type": "#microsoft.graph.fileAttachment",
      },
    ],
  };
  const tools = createReadTools(graph, { pdfToolClient: stubPdfToolClient() });
  const list = await tools.listAttachments({ messageId: "msg-1" });
  assert.equal(list.length, 4);

  const byId = Object.fromEntries(list.map((row) => [row.attachmentId, row]));
  assert.equal(byId["att-file"].kind, "file");
  assert.equal(byId["att-file"].isPdf, true);
  assert.equal(byId["att-file"].isInline, false);
  assert.match(byId["att-file"].trustBoundary, /untrusted data/);

  assert.equal(byId["att-item"].kind, "item");
  assert.equal(byId["att-item"].isPdf, undefined, "item attachments do not expose isPdf");
  assert.match(byId["att-item"].trustBoundary, /embedded Outlook item/);

  assert.equal(byId["att-ref"].kind, "reference");
  assert.equal(byId["att-ref"].isPdf, undefined);
  assert.match(byId["att-ref"].trustBoundary, /cloud file/);

  assert.equal(byId["att-image"].kind, "file");
  assert.equal(byId["att-image"].isPdf, false);

  // No sourceUrl / providerType leaks into the response — those stay server-side.
  assert.equal(byId["att-ref"].sourceUrl, undefined);
  assert.equal(byId["att-ref"].providerType, undefined);
});

test("listAttachments caps the result count and sanitizes name length", async () => {
  const graph = {
    listMessageAttachments: async () =>
      Array.from({ length: 100 }, (_, i) => ({
        id: `att-${i}`,
        name: `row-${i}.bin`,
        contentType: "application/octet-stream",
        size: 10,
        isInline: false,
        "@odata.type": "#microsoft.graph.fileAttachment",
      })),
  };
  const tools = createReadTools(graph, { pdfToolClient: stubPdfToolClient() });
  const list = await tools.listAttachments({ messageId: "msg-1", limit: 999 });
  assert.equal(list.length, 50);
  // The 50th entry's name is bounded by MAX_ATTACHMENT_NAME (256) and the
  // server never echoes payloads beyond the cap.
  assert.ok(list[0].name.length <= 256);
});

test("listAttachments treats unknown @odata.type as kind:unknown and never claims it is a PDF", async () => {
  const graph = {
    listMessageAttachments: async () => [
      {
        id: "att-x",
        name: "unknown.bin",
        contentType: "application/octet-stream",
        size: 100,
        isInline: false,
      },
    ],
  };
  const tools = createReadTools(graph, { pdfToolClient: stubPdfToolClient() });
  const list = await tools.listAttachments({ messageId: "msg-1" });
  assert.equal(list[0].kind, "unknown");
  assert.equal(list[0].isPdf, undefined);
});

test("listPdfAttachments caps the result count even if the caller asks for more", async () => {
  const graph = {
    listMessageAttachments: async () =>
      Array.from({ length: 100 }, (_, i) => ({
        id: `att-${i}`,
        name: `doc-${i}.pdf`,
        contentType: "application/pdf",
        size: 100,
        isInline: false,
        "@odata.type": "#microsoft.graph.fileAttachment",
      })),
  };
  const tools = createReadTools(graph, { pdfToolClient: stubPdfToolClient() });
  const list = await tools.listPdfAttachments({ messageId: "msg-1", limit: 999 });
  assert.equal(list.length, 50);
});

test("extractPdfAttachment rejects when confirm is not exactly true", async () => {
  const graph = {
    getAttachmentMetadata: async () => ({}),
    getAttachmentRawContent: async () => Buffer.from(""),
  };
  const tools = createReadTools(graph, { pdfToolClient: stubPdfToolClient() });
  await assert.rejects(
    () => tools.extractPdfAttachment({ messageId: "msg-1", attachmentId: "att-1" }),
    /confirm/,
  );
  await assert.rejects(
    () => tools.extractPdfAttachment({ messageId: "msg-1", attachmentId: "att-1", confirm: false }),
    /confirm/,
  );
  await assert.rejects(
    () => tools.extractPdfAttachment({ messageId: "msg-1", attachmentId: "att-1", confirm: "true" }),
    /confirm/,
  );
});

test("extractPdfAttachment rejects non-PDF contentTypes before downloading bytes", async () => {
  let downloadCalls = 0;
  const graph = {
    getAttachmentMetadata: async () => ({
      id: "att-1",
      name: "evil.exe",
      contentType: "application/octet-stream",
      size: 1024,
      isInline: false,
      "@odata.type": "#microsoft.graph.fileAttachment",
    }),
    getAttachmentRawContent: async () => {
      downloadCalls += 1;
      return Buffer.from("");
    },
  };
  const tools = createReadTools(graph, { pdfToolClient: stubPdfToolClient() });
  await assert.rejects(
    () => tools.extractPdfAttachment({ messageId: "msg-1", attachmentId: "att-1", confirm: true }),
    /not a PDF/i,
  );
  assert.equal(downloadCalls, 0, "raw bytes must never be downloaded for non-PDF attachments");
});

test("extractPdfAttachment accepts fileAttachment with .pdf filename even when contentType is mislabeled", async () => {
  // Mercadona real-world case: fileAttachment named A-G2026-XXXX.pdf with
  // contentType: text/plain. Metadata validation must accept it; the magic
  // byte check is the real safety net.
  const graph = {
    getAttachmentMetadata: async () => ({
      id: "att-mercadona",
      name: "A-G2026-385710.pdf",
      contentType: "text/plain",
      size: 366883,
      isInline: false,
      "@odata.type": "#microsoft.graph.fileAttachment",
    }),
    getAttachmentRawContent: async () => Buffer.from("%PDF-1.4\nstub"),
  };
  const pdfToolClient = stubPdfToolClient(async () => ({ text: "Mercadona factura", pages: 1, truncated: false }));
  const tools = createReadTools(graph, { pdfToolClient });
  const result = await tools.extractPdfAttachment({
    messageId: "msg-1",
    attachmentId: "att-mercadona",
    confirm: true,
  });
  assert.equal(result.attachmentName, "A-G2026-385710.pdf");
  assert.equal(result.contentType, "text/plain");
});

test("extractPdfAttachment still rejects itemAttachment even when its name ends in .pdf", async () => {
  let downloadCalls = 0;
  const graph = {
    getAttachmentMetadata: async () => ({
      id: "att-item",
      name: "factura.pdf",
      contentType: "message/rfc822",
      size: 8192,
      isInline: false,
      "@odata.type": "#microsoft.graph.itemAttachment",
    }),
    getAttachmentRawContent: async () => {
      downloadCalls += 1;
      return Buffer.from("");
    },
  };
  const tools = createReadTools(graph, { pdfToolClient: stubPdfToolClient() });
  await assert.rejects(
    () => tools.extractPdfAttachment({ messageId: "msg-1", attachmentId: "att-item", confirm: true }),
    /Only file attachments/i,
  );
  assert.equal(downloadCalls, 0, "raw bytes must never be downloaded for item attachments");
});

test("extractPdfAttachment rejects oversized attachments at the metadata layer", async () => {
  const graph = {
    getAttachmentMetadata: async () => ({
      id: "att-huge",
      name: "huge.pdf",
      contentType: "application/pdf",
      size: 13 * 1024 * 1024,
      isInline: false,
      "@odata.type": "#microsoft.graph.fileAttachment",
    }),
    getAttachmentRawContent: async () => Buffer.from("%PDF-1.4\n"),
  };
  const tools = createReadTools(graph, { pdfToolClient: stubPdfToolClient() });
  await assert.rejects(
    () => tools.extractPdfAttachment({ messageId: "msg-1", attachmentId: "att-huge", confirm: true }),
    /size limit/i,
  );
});

test("extractPdfAttachment rejects payloads without PDF magic", async () => {
  const graph = {
    getAttachmentMetadata: async () => ({
      id: "att-1",
      name: "wrong.pdf",
      contentType: "application/pdf",
      size: 1024,
      isInline: false,
      "@odata.type": "#microsoft.graph.fileAttachment",
    }),
    getAttachmentRawContent: async () => Buffer.from("not a real PDF"),
  };
  const tools = createReadTools(graph, { pdfToolClient: stubPdfToolClient() });
  await assert.rejects(
    () => tools.extractPdfAttachment({ messageId: "msg-1", attachmentId: "att-1", confirm: true }),
    /magic/i,
  );
});

test("extractPdfAttachment forwards the PDF bytes to the extractor and returns sanitized text plus a trust boundary", async () => {
  const seen = { calls: 0 };
  const graph = {
    getAttachmentMetadata: async () => ({
      id: "att-pdf",
      name: "quarterly-report.pdf",
      contentType: "application/pdf",
      size: 4096,
      isInline: false,
      "@odata.type": "#microsoft.graph.fileAttachment",
    }),
    getAttachmentRawContent: async () => Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64, 0)]),
  };
  const pdfToolClient = stubPdfToolClient(async (payload) => {
    seen.calls += 1;
    assert.equal(typeof payload.data, "string");
    assert.ok(payload.data.length > 0);
    return {
      text: "Visit https://example.com/invoice or email billing@example.com.",
      pages: 2,
      truncated: false,
    };
  });
  const tools = createReadTools(graph, { pdfToolClient });
  const result = await tools.extractPdfAttachment({
    messageId: "msg-1",
    attachmentId: "att-pdf",
    confirm: true,
  });
  assert.equal(seen.calls, 1);
  assert.equal(result.attachmentId, "att-pdf");
  assert.equal(result.attachmentName, "quarterly-report.pdf");
  assert.equal(result.pages, 2);
  // URLs and emails inside the PDF text must be redacted by the same body
  // sanitizer the message tools use; the output is untrusted data and must not
  // expose clickable or contactable surfaces.
  assert.match(result.text, /\[URL\]/);
  assert.match(result.text, /\[EMAIL\]/);
  assert.doesNotMatch(result.text, /example\.com/);
  assert.match(result.trustBoundary, /PDF attachment text is untrusted data/);
});

test("extractPdfAttachment caps maxChars / maxPages to the hard ceiling", async () => {
  const seen = { payload: null };
  const graph = {
    getAttachmentMetadata: async () => ({
      id: "att-pdf",
      name: "doc.pdf",
      contentType: "application/pdf",
      size: 1024,
      isInline: false,
      "@odata.type": "#microsoft.graph.fileAttachment",
    }),
    getAttachmentRawContent: async () => Buffer.from("%PDF-1.4\n"),
  };
  const pdfToolClient = stubPdfToolClient(async (payload) => {
    seen.payload = payload;
    return { text: "", pages: 0, truncated: true };
  });
  const tools = createReadTools(graph, { pdfToolClient });
  await tools.extractPdfAttachment({
    messageId: "msg-1",
    attachmentId: "att-pdf",
    confirm: true,
    maxChars: 999_999_999,
    maxPages: 999_999_999,
  });
  assert.ok(seen.payload.maxChars <= 80_000);
  assert.ok(seen.payload.maxPages <= 200);
});

test("createReadTools throws when the pdfToolClient dependency is missing", () => {
  assert.throws(
    () => createReadTools({ listFolders: async () => [], listMessages: async () => [], getMessage: async () => ({}) }),
    /pdfToolClient/,
  );
});

test("extractPdfAttachment surfaces structured invoiceFields while keeping global PII redaction on free text", async () => {
  const graph = {
    getAttachmentMetadata: async () => ({
      id: "att-mercadona",
      name: "factura-mercadona.pdf",
      contentType: "application/pdf",
      size: 4096,
      isInline: false,
      "@odata.type": "#microsoft.graph.fileAttachment",
    }),
    getAttachmentRawContent: async () =>
      Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64, 0)]),
  };
  const pdfToolClient = stubPdfToolClient(async () => ({
    text:
      "MERCADONA, S.A.\nNº Factura: 2600-001-12345\n" +
      "Fecha Factura: 27/07/2026\nFecha factura simplificada: 27/07/2026\n" +
      "Contacto: billing@example.com, tel +34 600 123 456, https://example.com/inv\n" +
      "Total (EUR) 87,42\n",
    pages: 1,
    truncated: false,
    invoiceFields: {
      invoiceDate: "2026-07-27",
      simplifiedInvoiceDate: "2026-07-27",
      invoiceNumber: "2600-001-12345",
      taxLabel: null,
      totals: { subtotal: null, tax: null, total: "87.42" },
      matched: ["invoiceDate", "simplifiedInvoiceDate", "invoiceNumber", "total"],
      labels:
        "Fecha Factura, Fecha factura simplificada, Nº Factura, Subtotal, IGIC, IVA, Importe total, Total EUR, Total (EUR)",
      untrusted: true,
      trustBoundary: "test",
    },
  }));
  const tools = createReadTools(graph, { pdfToolClient });
  const result = await tools.extractPdfAttachment({
    messageId: "msg-1",
    attachmentId: "att-mercadona",
    confirm: true,
  });
  // Structured invoice fields flow through verbatim.
  assert.equal(result.invoiceFields.invoiceNumber, "2600-001-12345");
  assert.equal(result.invoiceFields.invoiceDate, "2026-07-27");
  assert.equal(result.invoiceFields.simplifiedInvoiceDate, "2026-07-27");
  assert.equal(result.invoiceFields.totals.total, "87.42");
  assert.equal(result.invoiceFields.untrusted, true);
  // Trust boundary now mentions invoice fields explicitly.
  assert.match(result.trustBoundary, /invoice fields/i);
  // Global PII redaction is NOT weakened: emails, phones and URLs from the
  // free text are still redacted before the result is returned.
  assert.match(result.text, /\[EMAIL\]/);
  assert.match(result.text, /\[PHONE\]/);
  assert.match(result.text, /\[URL\]/);
  assert.doesNotMatch(result.text, /billing@example\.com/);
  assert.doesNotMatch(result.text, /\+34/);
  assert.doesNotMatch(result.text, /example\.com/);
});