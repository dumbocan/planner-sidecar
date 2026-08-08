import assert from "node:assert/strict";
import test from "node:test";
import { parseMercadonaLines } from "../src/mercadona-parser.js";

function fixture50Items() {
  const lines = [
    "COMERCIANTE MINORISTA",
    "MERCADONA S.A. DATOS FISCALES",
    "Descripción Unid. P.Unitario B.Imp. IGIC Cuota IGIC Importe",
  ];
  const items = [
    ["PARKING (19:07:00 - 20:12:00)", "1", "0,0000", "0,0000", "EX", "0,0000", "0,0000"],
    ["BEBIDA AVENA", "1", "6,0000", "6,0000", "EX", "0,0000", "6,0000"],
    ["LECHE DESN P6", "1", "5,2200", "5,2200", "EX", "0,0000", "5,2200"],
    ["MINI CARITA CACAO", "1", "1,4000", "1,4000", "EX", "0,0000", "1,4000"],
    ["COPO INTEGRAL CHOCO", "1", "2,3500", "2,3500", "EX", "0,0000", "2,3500"],
  ];
  for (const row of items) {
    lines.push(`${row[0]} ${row[1]} ${row[2]} ${row[3]} ${row[4]} ${row[5]} ${row[6]}`);
  }
  lines.push("TOTAL (€) 19,1700 0,00 19,1700");
  lines.push("Total Factura 19,17€");
  return lines.join("\n");
}

function fixtureWithIgic() {
  return [
    "PIMIENTO TRICO 1 2,5200 2,5200 IGIC 0,1500 2,6700",
    "PAVO A TACOS 1 4,0200 4,0200 IGIC (7%) 0,2800 4,3000",
    "BURGER MEAT VACUNO 1 5,3000 5,3000 IGIC (0%) 0,0000 5,3000",
    "IVA 7% item 1 1,0000 1,0000 IVA 7% 0,0700 1,0700",
  ].join("\n");
}

test("parser detects Mercadona line items and skips headers", () => {
  const result = parseMercadonaLines(fixture50Items());
  assert.equal(result.stats.lineItemsDetected, 5);
  assert.equal(result.stats.lineItemsSkipped, 0);
  assert.equal(result.lineItems[0].description, "PARKING (19:07:00 - 20:12:00)");
  assert.equal(result.lineItems[1].unit_price_eur, 6);
  assert.equal(result.lineItems[4].total_eur, 2.35);
  assert.equal(result.stats.sumLineItemTotals, 14.97);
});

test("parser extracts items from a single-line, multi-space PDF dump (pdfjs output)", () => {
  // Real sidecar output: everything on one line, runs of spaces between tokens.
  const text = [
    "COMERCIANTE MINORISTA Firmado digitalmente por SELLO DE ENTIDAD MERCADONA",
    "Fecha: 2026.05.13 09:39:59 +02:00 Fdo. MERCADONA S.A.",
    "PÁGINA   1   DE   2 MERCADONA   S.A.   A-46103834",
    "Descripción   Unid.   P.Unitario   B.Imp.   IGIC   Cuota   IGIC   Importe",
    "PARKING   (19:07:00   -   20:12:00)   1   0,0000   0,0000   EX   0,0000   0,0000",
    "BEBIDA AVENA   1   6,0000   6,0000   EX   0,0000   6,0000",
    "PAVO A TACOS   1   4,0200   4,0200   EX   0,0000   4,0200",
    "CEBOLLA TUBO   1   2,5000   2,5000   EX   0,0000   2,5000",
    "TOTAL   (€)   12,5200   0,00   12,5200   Total   Factura   12,52€",
    "FORMA DE PAGO TARJETA BANCARIA 12,52 €",
  ].join("\n");
  const result = parseMercadonaLines(text);
  assert.equal(result.stats.lineItemsDetected, 4);
  assert.equal(result.lineItems[0].description, "PARKING (19:07:00 - 20:12:00)");
  assert.equal(result.lineItems[1].description, "BEBIDA AVENA");
  assert.equal(result.lineItems[2].description, "PAVO A TACOS");
  assert.equal(result.lineItems[3].description, "CEBOLLA TUBO");
  assert.equal(result.stats.sumLineItemTotals, 12.52);
});

test("parser accepts IGIC, IGIC (0%), IGIC (7%), IVA 7% tax labels", () => {
  const result = parseMercadonaLines(fixtureWithIgic());
  assert.equal(result.stats.lineItemsDetected, 4);
  assert.equal(result.lineItems[0].tax_label, "IGIC");
  assert.equal(result.lineItems[1].tax_label, "IGIC (7%)");
  assert.equal(result.lineItems[2].tax_label, "IGIC (0%)");
  assert.equal(result.lineItems[3].tax_label, "IVA 7%");
});

test("parser returns no items for plain prose (a user manual)", () => {
  const prose = [
    "BG-NAC-2-NAC-3 Calibration Manual",
    "Chapter 1: Safety Precautions",
    "Always disconnect power before opening the chassis.",
    "Use only manufacturer-approved replacement parts.",
    "Calibration must be performed annually by a certified technician.",
    "Failure to follow these instructions may void the warranty.",
  ].join("\n");
  const result = parseMercadonaLines(prose);
  assert.equal(result.stats.lineItemsDetected, 0);
  assert.equal(result.lineItems.length, 0);
});

test("parser dedupes accidental repeats", () => {
  const text = [
    "BEBIDA AVENA 1 6,0000 6,0000 EX 0,0000 6,0000",
    "BEBIDA AVENA 1 6,0000 6,0000 EX 0,0000 6,0000",
  ].join("\n");
  const result = parseMercadonaLines(text);
  assert.equal(result.stats.lineItemsDetected, 1);
});

test("parser handles mixed Mercadona rows + prose", () => {
  const text = [
    "PIMIENTO TRICO 1 2,5200 2,5200 EX 0,0000 2,5200",
    "PAVO A TACOS 1 4,0200 4,0200 EX 0,0000 4,0200",
    "Continuamos con la lista de la compra",
    "BURGER MEAT VACUNO 1 5,3000 5,3000 EX 0,0000 5,3000",
  ].join("\n");
  const result = parseMercadonaLines(text);
  assert.equal(result.stats.lineItemsDetected, 3);
  assert.equal(result.lineItems[1].description, "PAVO A TACOS");
  assert.equal(result.lineItems[2].description, "BURGER MEAT VACUNO");
});

test("parser ignores empty lines and trailing periods", () => {
  const text = [
    "BEBIDA AVENA 1 6,0000 6,0000 EX 0,0000 6,0000.",
    "",
    "   ",
    "PAVO A TACOS 1 4,0200 4,0200 EX 0,0000 4,0200",
  ].join("\n");
  const result = parseMercadonaLines(text);
  assert.equal(result.stats.lineItemsDetected, 2);
});

test("parser sums totals with two-decimal rounding", () => {
  const text = [
    "ITEM A 1 0,1000 0,1000 EX 0,0000 0,1000",
    "ITEM B 1 0,2000 0,2000 EX 0,0000 0,2000",
    "ITEM C 1 0,3300 0,3300 EX 0,0000 0,3300",
  ].join("\n");
  const result = parseMercadonaLines(text);
  assert.equal(result.stats.sumLineItemTotals, 0.63);
});

test("parser skips the line item header row Descripción Unid. P.Unitario...", () => {
  const text = "Descripción Unid. P.Unitario B.Imp. IGIC Cuota IGIC Importe BEBIDA AVENA 1 6,0000 6,0000 EX 0,0000 6,0000";
  const result = parseMercadonaLines(text);
  assert.equal(result.stats.lineItemsDetected, 1);
  assert.equal(result.lineItems[0].description, "BEBIDA AVENA");
});

test("parser skips the total row TOTAL (€) ... Total Factura", () => {
  const text = "BEBIDA AVENA 1 6,0000 6,0000 EX 0,0000 6,0000 TOTAL (€) 6,0000 0,00 6,0000 Total Factura 6,00€";
  const result = parseMercadonaLines(text);
  assert.equal(result.stats.lineItemsDetected, 1);
});
