// Mercadona-style tabular line item parser.
//
// The sidecar upstream (pdfjs) emits the entire page text on a single line
// with no \n between rows. We therefore cannot rely on line splitting.
//
// Strategy: a single global regex that finds every contiguous match of the
// 7-column tail. The desc group is bounded by a leading uppercase letter
// (product names are uppercased) and a tight numeric tail; we then drop any
// match whose desc is a header/footer fragment.

const NUM = String.raw`[0-9]+,[0-9]{4}`;
const TAX = String.raw`[A-Z][A-Z0-9 ()\.%]{0,8}`;

// 7 columns: desc (mixed-case phrase, single line), units, unit_price,
// base, tax, tax_amount, total. We restrict desc to non-newline whitespace
// so the regex cannot bridge across unrelated rows.
const MERCADONA_ITEM_RE = new RegExp(
  String.raw`(?<desc>[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ0-9 \t\.\-/():,°ª%&'+]*?)[ \t]+` +
  String.raw`(?<units>[0-9]+(?:[.,][0-9]+)?)[ \t]+` +
  String.raw`(?<pu>${NUM})[ \t]+` +
  String.raw`(?<bi>${NUM})[ \t]+` +
  String.raw`(?<tax>${TAX})[ \t]+` +
  String.raw`(?<cuota>${NUM})[ \t]+` +
  String.raw`(?<imp>${NUM})`,
  "g",
);

// desc fragments we never want to match as a product. They appear in
// headers, footers, address blocks, and trust-boundary blurbs.
const FORBIDDEN_DESC = [
  "PÁGINA",
  "COMERCIANTE MINORISTA",
  "MERCADONA",
  "DATOS FISCALES",
  "DESCRIPCIÓN",
  "INSCRITA",
  "PARA CUALQUIER",
  "INFORMA",
  "FDO",
  "FIRMADO",
  "SELLO",
  "FECHA",
  "TOTAL",
  "FORMA DE PAGO",
  "TICKET",
  "NIF",
  "RAZÓN",
  "DIRECCIÓN",
  "SUPERMERCADO",
  "TELF",
  "CIF",
  "FACTURA SIMPLIFICADA",
  "Nº FACTURA",
  "PAGINA",
  "COMERCIANTE",
  "MINORISTA",
];

function isPlausibleDescription(desc) {
  const trimmed = desc.trim();
  if (trimmed.length < 3) return false;
  if (trimmed.length > 60) return false;
  // Reject any description that looks like a header/footer/address fragment.
  const upper = trimmed.toUpperCase();
  for (const kw of FORBIDDEN_DESC) {
    if (upper.includes(kw)) return false;
  }
  // Real product names rarely have more than 20 digits (parking rows can
  // hit 12+ via the HH:MM:SS - HH:MM:SS timestamp; an NIF would be 8-9 and a
  // phone 9). Cap at 20 to drop only obvious non-product fragments.
  const digits = (trimmed.match(/\d/g) || []).length;
  if (digits > 20) return false;
  return true;
}

function parseNum(value) {
  return Number(String(value).replace(/\./g, "").replace(",", "."));
}

function extractItemRegion(rawText) {
  // Strip everything before the column header row and everything after the
  // totals/footer. Without this, a global regex matches the header itself as
  // a single huge "item" and consumes the cursor, hiding real items.
  let start = 0;
  const startCandidates = [
    "Descripci\u00f3n Unid. P.Unitario B.Imp. IGIC Cuota IGIC Importe",
    "Descripci\u00f3n  Unid.  P.Unitario  B.Imp.  IGIC  Cuota  IGIC  Importe",
    "Descripci\u00f3n Unid. P.Unitario",
  ];
  for (const marker of startCandidates) {
    const idx = rawText.indexOf(marker);
    if (idx >= 0) {
      start = idx + marker.length;
      break;
    }
  }
  // Fallback: if the column header is unrecognised, take the entire text.
  // The regex global + plausibility filter will still skip bogus matches.
  if (start === 0) return rawText;
  let end = rawText.length;
  const endMarkers = [
    "Inscrita en el Registro",
    "Total Factura",
    "FORMA DE PAGO",
    "TOTAL (",
    "TOTAL  (",
    "MERCADONA S.A. informa",
    "PARA CUALQUIER DEVOLUCI\u00d3N",
  ];
  for (const marker of endMarkers) {
    const idx = rawText.indexOf(marker, start);
    if (idx > 0 && idx < end) end = idx;
  }
  return rawText.slice(start, end);
}

export function parseMercadonaLines(rawText) {
  const items = [];
  const seen = new Set();
  let skipped = 0;
  const region = extractItemRegion(rawText);
  for (const m of region.matchAll(MERCADONA_ITEM_RE)) {
    const desc = m.groups.desc.replace(/\s+/g, " ").trim();
    if (!isPlausibleDescription(desc)) {
      skipped += 1;
      continue;
    }
    const key = `${desc}|${m.groups.units}|${m.groups.imp}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      description: desc,
      units: parseNum(m.groups.units),
      unit_price_eur: parseNum(m.groups.pu),
      base_eur: parseNum(m.groups.bi),
      tax_label: m.groups.tax.trim(),
      tax_eur: parseNum(m.groups.cuota),
      total_eur: parseNum(m.groups.imp),
    });
  }
  const sumLineItemTotals = items.reduce((acc, i) => acc + i.total_eur, 0);
  return {
    lineItems: items,
    stats: {
      lineItemsDetected: items.length,
      lineItemsSkipped: skipped,
      sumLineItemTotals: Math.round(sumLineItemTotals * 100) / 100,
    },
  };
}

export const _internal = { MERCADONA_ITEM_RE, isPlausibleDescription, FORBIDDEN_DESC };
