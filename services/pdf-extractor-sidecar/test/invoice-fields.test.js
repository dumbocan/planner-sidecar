import assert from "node:assert/strict";
import test from "node:test";
import {
  extractInvoiceFields,
  INVOICE_FIELD_LIMITS,
  INVOICE_LABEL_HINT,
} from "../src/extract.js";

test("extractInvoiceFields returns structured fields for a typical Mercadona simplified invoice", () => {
  const text = [
    "MERCADONA, S.A.",
    "CIF A-12345678",
    "Nº Factura: 2600-001-12345",
    "Fecha factura simplificada: 27/07/2026",
    "Total (EUR) 87,42",
    "Gracias por su compra.",
  ].join("\n");

  const fields = extractInvoiceFields(text);
  assert.equal(fields.invoiceNumber, "2600-001-12345");
  assert.equal(fields.simplifiedInvoiceDate, "2026-07-27");
  // Mercadona simplified invoices normally do not include a "Fecha Factura" line.
  assert.equal(fields.invoiceDate, null);
  assert.equal(fields.totals.total, "87.42");
  assert.equal(fields.totals.subtotal, null);
  assert.equal(fields.totals.tax, null);
  assert.equal(fields.taxLabel, null);
  assert.ok(fields.matched.includes("simplifiedInvoiceDate"));
  assert.ok(fields.matched.includes("invoiceNumber"));
  assert.ok(fields.matched.includes("total"));
  assert.equal(fields.untrusted, true);
});

test("extractInvoiceFields picks up both Fecha Factura and Fecha factura simplificada when both appear", () => {
  const text = [
    "MERCADONA, S.A.",
    "Nº Factura: A-2600/00123",
    "Fecha Factura: 27/07/2026",
    "Fecha factura simplificada: 27/07/2026",
    "Importe total: 87,42 EUR",
  ].join("\n");

  const fields = extractInvoiceFields(text);
  assert.equal(fields.invoiceDate, "2026-07-27");
  assert.equal(fields.simplifiedInvoiceDate, "2026-07-27");
  assert.equal(fields.invoiceNumber, "A-2600/00123");
  assert.equal(fields.totals.total, "87.42");
});

test("extractInvoiceFields parses IGIC (Canary tax) totals and tax label where present", () => {
  const text = [
    "Proveedor Ejemplo S.L.",
    "Nº Factura: F-2026-0001",
    "Fecha Factura: 15/06/2026",
    "Subtotal: 100,00 EUR",
    "IGIC (7%): 7,00 EUR",
    "Total: 107,00 EUR",
  ].join("\n");

  const fields = extractInvoiceFields(text);
  assert.equal(fields.invoiceDate, "2026-06-15");
  assert.equal(fields.invoiceNumber, "F-2026-0001");
  assert.equal(fields.taxLabel, "IGIC");
  assert.equal(fields.totals.subtotal, "100.00");
  assert.equal(fields.totals.tax, "7.00");
  assert.equal(fields.totals.total, "107.00");
  assert.ok(fields.matched.includes("subtotal"));
  assert.ok(fields.matched.includes("tax"));
  assert.ok(fields.matched.includes("taxLabel"));
});

test("extractInvoiceFields normalizes Spanish decimal commas to ISO dots and enforces two decimal places", () => {
  const text = [
    "Fecha Factura: 1/2/2026",
    "Total EUR 1.234,56",
    "Nº Factura: 9",
  ].join("\n");
  const fields = extractInvoiceFields(text);
  assert.equal(fields.invoiceDate, "2026-02-01");
  // Thousands-separator dot stripped, decimal comma becomes the only decimal separator.
  assert.equal(fields.totals.total, "1234.56");
});

test("extractInvoiceFields rejects out-of-range or malformed dates", () => {
  const bad = [
    "Fecha Factura: 32/13/2026",   // impossible day/month
    "Fecha Factura: 2026-02-30",   // impossible feb 30
    "Fecha Factura: 13/13/2026",   // repeated month
    "Fecha Factura: 27/07/26",     // 2-digit year, NOT normalized; rejected
  ];
  for (const line of bad) {
    const fields = extractInvoiceFields(`Nº Factura: X-1\n${line}\n`);
    assert.equal(fields.invoiceDate, null, `expected null invoiceDate for ${line}`);
  }
});

test("extractInvoiceFields rejects malformed decimal totals", () => {
  const bad = [
    "Total: not-a-number",
    "Total: 12,3,4",         // two decimals
    "Total: 12.34.56",
    "Total: -12,00",         // negatives not accepted
    "Total: 0",              // zero rejected (totals must be > 0 and ≤ cap)
  ];
  for (const line of bad) {
    const fields = extractInvoiceFields(`Nº Factura: X-1\n${line}\n`);
    assert.equal(fields.totals.total, null, `expected null total for ${line}`);
  }
});

test("extractInvoiceFields caps totals at INVOICE_FIELD_LIMITS.maxTotal", () => {
  const over = INVOICE_FIELD_LIMITS.maxTotal + 1;
  const text = `Fecha Factura: 01/01/2026\nNº Factura: X-1\nTotal: ${over.toFixed(2)} EUR\n`;
  const fields = extractInvoiceFields(text);
  assert.equal(fields.totals.total, null, "total above cap must be rejected");
});

test("extractInvoiceFields rejects oversized invoice numbers and dates and labels", () => {
  const hugeInvoiceNumber = "X".repeat(INVOICE_FIELD_LIMITS.maxInvoiceNumber + 1);
  const fields = extractInvoiceFields(`Nº Factura: ${hugeInvoiceNumber}\nFecha Factura: 27/07/2026\n`);
  assert.equal(fields.invoiceNumber, null, "oversized invoice number must be rejected");
  assert.equal(fields.invoiceDate, "2026-07-27");
});

test("extractInvoiceFields falls back gracefully on free text with no invoice labels", () => {
  const text = "Some PDF without any invoice markers.\nNo totals here.";
  const fields = extractInvoiceFields(text);
  assert.equal(fields.invoiceNumber, null);
  assert.equal(fields.invoiceDate, null);
  assert.equal(fields.simplifiedInvoiceDate, null);
  assert.equal(fields.taxLabel, null);
  assert.deepEqual(fields.totals, { subtotal: null, tax: null, total: null });
  assert.deepEqual(fields.matched, []);
  assert.equal(fields.untrusted, true);
});

test("extractInvoiceFields flags untrusted on every result regardless of matched fields", () => {
  const trusted = extractInvoiceFields("");
  const matched = extractInvoiceFields("Fecha Factura: 27/07/2026\n");
  assert.equal(trusted.untrusted, true);
  assert.equal(matched.untrusted, true);
});

test("extractInvoiceFields never echoes surrounding sentence text into invoice fields", () => {
  const text = [
    "Fake header line that should not leak in.",
    "Real label line:",
    "Nº Factura: F-2026-9",
    "Trailing junk that should not leak.",
  ].join("\n");
  const fields = extractInvoiceFields(text);
  assert.equal(fields.invoiceNumber, "F-2026-9");
  assert.equal(fields.untrusted, true);
});

test("extractInvoiceFields rejects dates outside the supported range (year 1900..2100)", () => {
  const tooOld = "Fecha Factura: 01/01/1800";
  const tooNew = "Fecha Factura: 01/01/2200";
  assert.equal(extractInvoiceFields(`${tooOld}\n`).invoiceDate, null);
  assert.equal(extractInvoiceFields(`${tooNew}\n`).invoiceDate, null);
});

test("extractInvoiceFields accepts dotted thousands separators and normalizes them away", () => {
  const text = "Total: 12.345,67 EUR";
  const fields = extractInvoiceFields(text);
  assert.equal(fields.totals.total, "12345.67");
});

test("INVOICE_LABEL_HINT surfaces the labels it scans so the agent prompt can quote them", () => {
  assert.match(INVOICE_LABEL_HINT, /Fecha Factura/);
  assert.match(INVOICE_LABEL_HINT, /Fecha factura simplificada/);
  assert.match(INVOICE_LABEL_HINT, /Nº Factura/);
  assert.match(INVOICE_LABEL_HINT, /IGIC/);
});