import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeText } from "../src/sanitize.js";

// Regression for the deployed-sidecar defect: outlook_search_extract_pdf ran the
// PDF text through full phone masking, which destroyed invoice numbers, hours,
// quantities and product codes (PK6, ALCOHOL 96). This asserts the actual
// production path — sanitizeText with maskPhones:false — rather than a helper
// that could drift away from it. The fixtures mirror a real Mercadona invoice.
const CONTACT =
  ["billing", "example.com"].join(String.fromCharCode(64)) + " https://example.com/inv";

test("PDF path keeps every invoice digit and still redacts contacts", () => {
  const invoice = [
    "MERCADONA, S.A.",
    "Nº Factura: A-G2026-412202",
    "Fecha Factura: 27/07/2026",
    "Hora: 17:42",
    "ALCOHOL 96 1 x 2,15",
    "PK6 2 x 1,35",
    "JAMON COCIDO P.1KG 1 x 9,90",
    "LECHE DESN P9123456789,1000",
    "Total (EUR) 123,69",
    `Contacto ${CONTACT}`,
  ].join("\n");

  const result = sanitizeText(invoice, { maskPhones: false });

  for (const token of [
    "A-G2026-412202",
    "27/07/2026",
    "17:42",
    "ALCOHOL 96",
    "PK6",
    "P.1KG",
    "P9123456789",
    "123,69",
  ]) {
    assert.ok(
      result.includes(token),
      `expected ${token} to survive the PDF path, got: ${result}`,
    );
  }

  assert.ok(!result.includes("[PHONE]"), `expected no [PHONE], got: ${result}`);
  assert.match(result, /\[EMAIL\]/);
  assert.match(result, /\[URL\]/);
  assert.ok(!result.includes("example.com"));
});

test("email body path keeps full phone masking (unchanged contract)", () => {
  const result = sanitizeText("Llamame al +34 600 123 456 y paso la factura");
  assert.match(result, /\[PHONE\]/);
  assert.ok(!result.includes("600 123 456"));
});
