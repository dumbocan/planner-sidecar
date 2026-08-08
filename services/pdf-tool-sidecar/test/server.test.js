import assert from "node:assert/strict";
import test from "node:test";
import { createServiceTools } from "../src/server.js";
import { parseMercadonaLines } from "../src/mercadona-parser.js";

const VALID_PDF_HEADER = Buffer.from("%PDF-1.7\n");

function pdfBuffer(extraBytes = 32) {
  return Buffer.concat([VALID_PDF_HEADER, Buffer.alloc(extraBytes, 0x20)]);
}

function stubExtractor(text, invoiceFields = null) {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      text,
      pages: 2,
      truncated: false,
      invoiceFields: invoiceFields ?? {
        invoiceDate: "2026-05-13",
        simplifiedInvoiceDate: "2026-03-23",
        invoiceNumber: "A-G2026-00000246011",
        taxLabel: "IGIC",
        totals: { subtotal: null, tax: null, total: null },
        matched: ["invoiceDate", "simplifiedInvoiceDate", "invoiceNumber", "taxLabel"],
        labels: "",
        untrusted: true,
      },
    }),
  });
}

function stubExtract(text, invoiceFields = null) {
  return async () => ({
    text,
    pages: 2,
    truncated: false,
    invoiceFields: invoiceFields ?? {
      invoiceDate: "2026-05-13",
      simplifiedInvoiceDate: "2026-03-23",
      invoiceNumber: "A-G2026-00000246011",
      taxLabel: "IGIC",
      totals: { subtotal: null, tax: null, total: null },
      matched: ["invoiceDate", "simplifiedInvoiceDate", "invoiceNumber", "taxLabel"],
      labels: "",
      untrusted: true,
    },
  });
}

test("failure event shape includes tool and status", async () => {
  const lines = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    if (typeof chunk === "string") lines.push(chunk);
    return original(chunk, ...rest);
  };
  try {
    const tools = await createServiceTools({
      workspaceRoot: "/home/jmon/openclaw/workspace",
      extractorUrl: "http://stub/extract",
      fetchImpl: stubExtractor(""),
    });
    await assert.rejects(
      () => tools.extractPdfFromPath({ path: "/etc/passwd" }),
      (error) => error.status === 400,
    );
  } finally {
    process.stderr.write = original;
  }
  const events = lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))
    .filter((evt) => evt?.event === "pdf_tool_failure");
  assert.equal(events.length, 1);
  assert.equal(events[0].tool, "extract_pdf_from_path");
  assert.equal(events[0].status, 400);
});

test("rejects path traversal outside workspace", async () => {
  const tools = await createServiceTools({
    workspaceRoot: "/home/jmon/openclaw/workspace",
    extractorUrl: "http://stub/extract",
    fetchImpl: stubExtractor(""),
  });
  await assert.rejects(
    () => tools.extractPdfFromPath({ path: "/home/jmon/openclaw/workspace/../etc/passwd" }),
    (error) => error.status === 400 && /outside the workspace/i.test(error.message),
  );
});

test("rejects invalid PDF magic bytes", async () => {
  const tools = await createServiceTools({
    workspaceRoot: "/home/jmon/openclaw/workspace",
    extractorUrl: "http://stub/extract",
    fetchImpl: stubExtractor(""),
  });
  const tmp = "/home/jmon/openclaw/workspace/test-invalid.bin";
  const { writeFile, unlink } = await import("node:fs/promises");
  await writeFile(tmp, Buffer.from("not a pdf"));
  try {
    await assert.rejects(
      () => tools.extractPdfFromPath({ path: tmp }),
      (error) => error.status === 400 && /magic/i.test(error.message),
    );
  } finally {
    await unlink(tmp).catch(() => {});
  }
});

test("happy path returns text, invoiceFields, parsed line items and parser verdict", async () => {
  const text = [
    "Descripción Unid. P.Unitario B.Imp. IGIC Cuota IGIC Importe",
    "BEBIDA AVENA 1 6,0000 6,0000 EX 0,0000 6,0000",
    "PAVO A TACOS 1 4,0200 4,0200 EX 0,0000 4,0200",
    "BURGER MEAT VACUNO 1 5,3000 5,3000 EX 0,0000 5,3000",
  ].join("\n");
  const tools = await createServiceTools({
    workspaceRoot: "/home/jmon/openclaw/workspace",
    extractText: stubExtract(text),
  });
  const tmp = "/home/jmon/openclaw/workspace/test-good.pdf";
  const { writeFile, unlink } = await import("node:fs/promises");
  await writeFile(tmp, pdfBuffer(48));
  try {
    const result = await tools.extractPdfFromPath({ path: tmp });
    assert.equal(result.parser, "mercadona-tabular");
    assert.equal(result.parserStats.lineItemsDetected, 3);
    assert.equal(result.invoiceFields.invoiceNumber, "A-G2026-00000246011");
    assert.equal(result.lineItems[0].description, "BEBIDA AVENA");
    assert.equal(result.size, pdfBuffer(48).length);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
  } finally {
    await unlink(tmp).catch(() => {});
  }
});

test("non-tabular PDF returns parser:plain-text with empty lineItems", async () => {
  const prose = [
    "BG-NAC-2-NAC-3 Calibration Manual",
    "Chapter 1: Safety",
    "Disconnect power before opening the chassis.",
  ].join("\n");
  const tools = await createServiceTools({
    workspaceRoot: "/home/jmon/openclaw/workspace",
    extractText: stubExtract(prose),
  });
  const tmp = "/home/jmon/openclaw/workspace/test-prose.pdf";
  const { writeFile, unlink } = await import("node:fs/promises");
  await writeFile(tmp, pdfBuffer(48));
  try {
    const result = await tools.extractPdfFromPath({ path: tmp });
    assert.equal(result.parser, "plain-text");
    assert.equal(result.lineItems.length, 0);
  } finally {
    await unlink(tmp).catch(() => {});
  }
});

test("extractPdfFromBase64 rejects invalid magic", async () => {
  const tools = await createServiceTools({
    workspaceRoot: "/home/jmon/openclaw/workspace",
    extractorUrl: "http://stub/extract",
    fetchImpl: stubExtractor(""),
  });
  await assert.rejects(
    () => tools.extractPdfFromBase64({ data: Buffer.from("nope").toString("base64") }),
    (error) => error.status === 400 && /magic/i.test(error.message),
  );
});

test("extractPdfFromBase64 succeeds with valid PDF", async () => {
  const text = [
    "BEBIDA AVENA 1 6,0000 6,0000 EX 0,0000 6,0000",
    "PAVO A TACOS 1 4,0200 4,0200 EX 0,0000 4,0200",
    "BURGER MEAT VACUNO 1 5,3000 5,3000 EX 0,0000 5,3000",
  ].join("\n");
  const tools = await createServiceTools({
    workspaceRoot: "/home/jmon/openclaw/workspace",
    extractText: stubExtract(text),
  });
  const data = pdfBuffer(48).toString("base64");
  const result = await tools.extractPdfFromBase64({ data, name: "test.pdf" });
  assert.equal(result.parser, "mercadona-tabular");
  assert.equal(result.lineItems.length, 3);
  assert.equal(result.name, "test.pdf");
  assert.equal(result.path, null);
});

function stubLlm(structured, rawText = "{\"resumen\": \"ok\"}") {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content: rawText } }],
      usage: { total_tokens: 42 },
    }),
  });
}

test("extractPdfWithLlm refuses when MINIMAX_API_KEY is empty", async () => {
  const tools = await createServiceTools({
    workspaceRoot: "/home/jmon/openclaw/workspace",
    extractorUrl: "http://stub/extract",
    fetchImpl: stubExtractor("ignored text"),
    llmApiKey: "",
  });
  await assert.rejects(
    () => tools.extractPdfWithLlm({ path: "/home/jmon/openclaw/workspace/test.pdf" }),
    (error) => error.status === 503 && /MINIMAX_API_KEY/.test(error.message),
  );
});

test("extractPdfWithLlm returns structured JSON when LLM responds", async () => {
  const tmp = "/home/jmon/openclaw/workspace/test-llm.pdf";
  const { writeFile, unlink } = await import("node:fs/promises");
  await writeFile(tmp, pdfBuffer(48));
  try {
    const tools = await createServiceTools({
      workspaceRoot: "/home/jmon/openclaw/workspace",
      extractorUrl: "http://stub/extract",
      fetchImpl: stubExtractor("manual text"),
      llmApiKey: "test-key",
      // Override fetchImpl's LLM call: we need to intercept both calls.
      // Strategy: split fetchImpl calls by URL.
    });
    // Replace fetchImpl with a switcher.
    const realFetch = tools;
    const fetchSwitch = async (url, options) => {
      if (typeof url === "string" && url.includes("/extract")) {
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({
            text: "manual text",
            pages: 1, truncated: false,
            invoiceFields: { invoiceDate: null, invoiceNumber: null,
                              simplifiedInvoiceDate: null, taxLabel: null,
                              totals: {}, matched: [], labels: "", untrusted: true,
                              trustBoundary: "" },
          }),
        };
      }
      // LLM call
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { content: '{"titulo":"Manual X","resumen":"Doc"}' } }],
          usage: { total_tokens: 100 },
        }),
      };
    };
    const tools2 = await createServiceTools({
      workspaceRoot: "/home/jmon/openclaw/workspace",
      extractText: stubExtract("manual text"),
      fetchImpl: fetchSwitch,
      llmApiKey: "test-key",
    });
    const result = await tools2.extractPdfWithLlm({ path: tmp });
    assert.equal(result.structured.titulo, "Manual X");
    assert.equal(result.structured.resumen, "Doc");
    assert.equal(result.llmModel.length > 0, true);
    assert.equal(result.llmUsage.total_tokens, 100);
    assert.equal(result.size, pdfBuffer(48).length);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
  } finally {
    await unlink(tmp).catch(() => {});
  }
});

test("extractPdfWithLlm falls back to raw text when LLM returns non-JSON", async () => {
  const tmp = "/home/jmon/openclaw/workspace/test-llm2.pdf";
  const { writeFile, unlink } = await import("node:fs/promises");
  await writeFile(tmp, pdfBuffer(48));
  try {
    const fetchSwitch = async (url) => {
      if (typeof url === "string" && url.includes("/extract")) {
        return { ok: true, status: 200,
          text: async () => JSON.stringify({
            text: "manual text", pages: 1, truncated: false,
            invoiceFields: { invoiceDate: null, invoiceNumber: null,
                              simplifiedInvoiceDate: null, taxLabel: null,
                              totals: {}, matched: [], labels: "", untrusted: true,
                              trustBoundary: "" },
          }),
        };
      }
      return { ok: true, status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { content: "Sorry I cannot help with that" } }],
          usage: { total_tokens: 10 },
        }),
      };
    };
    const tools = await createServiceTools({
      workspaceRoot: "/home/jmon/openclaw/workspace",
      extractText: stubExtract("manual text"),
      fetchImpl: fetchSwitch,
      llmApiKey: "test-key",
    });
    const result = await tools.extractPdfWithLlm({ path: tmp });
    assert.equal(result.structured, null);
    assert.equal(result.rawResponse, "Sorry I cannot help with that");
    assert.equal(result.llmUsage.total_tokens, 10);
  } finally {
    await unlink(tmp).catch(() => {});
  }
});

test("extractPdfWithLlm uses custom prompt when provided", async () => {
  const tmp = "/home/jmon/openclaw/workspace/test-llm3.pdf";
  const { writeFile, unlink } = await import("node:fs/promises");
  await writeFile(tmp, pdfBuffer(48));
  try {
    let receivedPrompt = null;
    const fetchSwitch = async (url, options) => {
      if (typeof url === "string" && url.includes("/extract")) {
        return { ok: true, status: 200,
          text: async () => JSON.stringify({
            text: "ignored", pages: 1, truncated: false,
            invoiceFields: { invoiceDate: null, invoiceNumber: null,
                              simplifiedInvoiceDate: null, taxLabel: null,
                              totals: {}, matched: [], labels: "", untrusted: true,
                              trustBoundary: "" },
          }),
        };
      }
      const body = JSON.parse(options.body);
      receivedPrompt = body.messages[0].content;
      return { ok: true, status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { content: "{\"k\":\"v\"}" } }],
          usage: { total_tokens: 5 },
        }),
      };
    };
    const tools = await createServiceTools({
      workspaceRoot: "/home/jmon/openclaw/workspace",
      extractText: stubExtract("ignored"),
      fetchImpl: fetchSwitch,
      llmApiKey: "test-key",
    });
    await tools.extractPdfWithLlm({ path: tmp, prompt: "CUSTOM PROMPT" });
    assert.equal(receivedPrompt, "CUSTOM PROMPT");
  } finally {
    await unlink(tmp).catch(() => {});
  }
});
