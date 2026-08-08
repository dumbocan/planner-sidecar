#!/usr/bin/env python3
"""A/B: pdf-tool-sidecar (pipeline completo) vs MiniMax-M3 (LLM con texto).

A = the running pdf-tool-sidecar (pdfjs + sanitizer + Mercadona parser).
B = MiniMax-M3, fed with the SAME text the sidecar returns, JSON-mode prompt.

For every PDF we measure precision + recall per field against the ground truth
in /home/node/.openclaw/workspace/mercadona.db (openclaw's discarded Python
output is the only reproducible truth we have).

API key is read from env var MINIMAX_API_KEY. Never logged.
"""

import json
import os
import re
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path

WORKSPACE = Path("/home/node/.openclaw/workspace")
DB_PATH = WORKSPACE / "mercadona.db"
SIDECAR_URL = "http://pdf-tool-sidecar:3000/mcp"
LLM_BASE = "https://api.minimax.io/v1"
LLM_MODEL = "MiniMax-M3"

PDFS = [
    ("mercadona", "A-G2026-246011.pdf"),
    ("mercadona", "A-G2026-246024.pdf"),
    ("mercadona", "A-G2026-372617.pdf"),
    ("manuales", "BG-NAC-2-NAC-3-manual-calibracion.pdf"),
]


def fetch_sidecar(pdf_path):
    req = urllib.request.Request(
        SIDECAR_URL,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                         "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                                    "clientInfo": {"name": "ab", "version": "0"}}}).encode(),
        headers={"Content-Type": "application/json",
                 "Accept": "application/json, text/event-stream"},
        method="POST",
    )
    resp = urllib.request.urlopen(req, timeout=30)
    sid = resp.headers.get("mcp-session-id")
    urllib.request.urlopen(urllib.request.Request(
        SIDECAR_URL,
        data=json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}).encode(),
        headers={"Content-Type": "application/json", "Mcp-Session-Id": sid,
                 "Accept": "application/json, text/event-stream"},
        method="POST",
    ), timeout=30).read()
    req = urllib.request.Request(
        SIDECAR_URL,
        data=json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                         "params": {"name": "extract_pdf_from_path",
                                    "arguments": {"path": str(pdf_path)}}}).encode(),
        headers={"Content-Type": "application/json", "Mcp-Session-Id": sid,
                 "Accept": "application/json, text/event-stream"},
        method="POST",
    )
    raw = urllib.request.urlopen(req, timeout=60).read().decode()
    payload = None
    for line in raw.split("\n"):
        if line.startswith("data:"):
            try:
                payload = json.loads(line[5:].strip())
                break
            except json.JSONDecodeError:
                continue
    return json.loads(payload["result"]["content"][0]["text"])


def ground_truth(num_factura):
    """Return {cabecera, lineas} for the given invoice number, or None."""
    if not DB_PATH.exists():
        return None
    # Try padded + unpadded forms
    candidates = [num_factura]
    m = re.match(r"^([A-Z])-([A-Z])(\d{4})-(\d+)$", num_factura or "")
    if m:
        candidates.append("%s-%s%s-%08d" % (m.group(1), m.group(2), m.group(3), int(m.group(4))))
    conn = sqlite3.connect(str(DB_PATH))
    try:
        c = conn.cursor()
        c.execute("SELECT id, fecha_factura, fecha_simplificada, total, num_factura FROM facturas WHERE num_factura IN (%s, %s)" % ("?", "?"),
                  (candidates[0], candidates[1] if len(candidates) > 1 else candidates[0]))
        row = c.fetchone()
        if not row:
            return None
        fid, fecha, fecha_simp, total, db_num = row
        c.execute("SELECT descripcion, unidades, precio_unit, base_imponible, tipo_iva, cuota_iva, importe FROM lineas WHERE factura_id = ? ORDER BY id", (fid,))
        lineas = []
        for r in c.fetchall():
            lineas.append({
                "descripcion": (r[0] or "").strip(),
                "unidades": r[1],
                "precio_unit": r[2],
                "base_imponible": r[3],
                "tipo_iva": r[4],
                "cuota_iva": r[5],
                "importe": r[6],
            })
        return {
            "num_factura": db_num,
            "fecha_factura": fecha,
            "fecha_simplificada": fecha_simp,
            "total": total,
            "lineas": lineas,
        }
    finally:
        conn.close()


def to_float(x):
    if x is None:
        return None
    if isinstance(x, (int, float)):
        return float(x)
    s = str(x).replace(".", "").replace(",", ".")
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def call_llm_header(api_key, text, pdf_name):
    """Call LLM for header fields only — short prompt, fast."""
    prompt = (
        "Extract ONLY the header fields of this Mercadona invoice PDF text.\n"
        "Return ONLY JSON: {\"num_factura\": \"A-NNNNN-XXXXXX\", "
        "\"fecha_factura\": \"DD/MM/YYYY\", \"fecha_simplificada\": \"DD/MM/YYYY\"|null, "
        "\"total_eur\": number}.\n"
        "PDF name: " + pdf_name + "\n\n=== PDF text ===\n" + text
    )
    body = json.dumps({
        "model": LLM_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 1000,
        "temperature": 0.0,
        "thinking": {"type": "adaptive"},
    }).encode()
    req = urllib.request.Request(
        LLM_BASE + "/chat/completions",
        data=body,
        headers={"Authorization": "Bearer " + api_key,
                 "Content-Type": "application/json"},
        method="POST",
    )
    raw = urllib.request.urlopen(req, timeout=120).read().decode()
    payload = json.loads(raw)
    usage = payload.get("usage", {})
    content = re.sub(r"<\|?think\|?>", "", payload["choices"][0]["message"]["content"]).strip()
    m = re.search(r"\{.*\}", content, re.DOTALL)
    if not m:
        return None, usage
    try:
        return json.loads(m.group(0)), usage
    except json.JSONDecodeError:
        return None, usage


def call_llm_items(api_key, item_region_text, pdf_name):
    """Call LLM for line items only — fed the pre-extracted tabular region."""
    prompt = (
        "Extract ALL line items from this Mercadona invoice tabular region.\n"
        "Return ONLY JSON: {\"lineItems\": [{\"descripcion\": str, \"unidades\": number, "
        "\"precio_unit\": number, \"base_imponible\": number, "
        "\"tipo_iva\": str, \"cuota_iva\": number, \"importe\": number}], "
        "\"total_eur\": number}.\n"
        "Columns: Descripcion | Unid. | P.Unitario | B.Imp. | tax_label | Cuota | Importe.\n"
        "tax_label examples: EX, IGIC, IGIC (0%), IGIC (7%), IVA 0%, IVA 7%.\n"
        "Decimal separator in PDF is comma. Convert to float with dot.\n"
        "Skip header/footer rows.\n"
        "PDF name: " + pdf_name + "\n\n=== Item region ===\n" + item_region_text
    )
    body = json.dumps({
        "model": LLM_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 16000,
        "temperature": 0.0,
        "thinking": {"type": "adaptive"},
    }).encode()
    req = urllib.request.Request(
        LLM_BASE + "/chat/completions",
        data=body,
        headers={"Authorization": "Bearer " + api_key,
                 "Content-Type": "application/json"},
        method="POST",
    )
    raw = urllib.request.urlopen(req, timeout=180).read().decode()
    payload = json.loads(raw)
    usage = payload.get("usage", {})
    content = re.sub(r"<\|?think\|?>", "", payload["choices"][0]["message"]["content"]).strip()
    m = re.search(r"\{.*\}", content, re.DOTALL)
    if not m:
        return [], None, usage
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return [], None, usage
    items = []
    for it in (data.get("lineItems") or []):
        try:
            items.append({
                "descripcion": str(it.get("descripcion") or ""),
                "unidades": float(it.get("unidades") or 0),
                "precio_unit": float(it.get("precio_unit") or 0),
                "base_imponible": float(it.get("base_imponible") or 0),
                "tipo_iva": str(it.get("tipo_iva") or ""),
                "cuota_iva": float(it.get("cuota_iva") or 0),
                "importe": float(it.get("importe") or 0),
            })
        except (TypeError, ValueError):
            continue
    return items, data.get("total_eur"), usage


def call_llm(api_key, raw_text, pdf_name, manual):
    """Two-call LLM: header first, items second. Returns (header_dict, lineas_list, total_eur, total_tokens)."""
    if manual:
        prompt = (
            "Extract the main fields of this PDF document as JSON. Return: "
            "{\"num_factura\": str|null, \"fecha_factura\": str|null, "
            "\"fecha_simplificada\": str|null, \"total_eur\": number|null, "
            "\"titulo_documento\": str|null, \"resumen\": str|null, "
            "\"lineItems\": []}. PDF name: " + pdf_name + "\n\n=== PDF text ===\n" + raw_text
        )
        body = json.dumps({
            "model": LLM_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 4000,
            "temperature": 0.0,
            "thinking": {"type": "adaptive"},
        }).encode()
        req = urllib.request.Request(
            LLM_BASE + "/chat/completions",
            data=body,
            headers={"Authorization": "Bearer " + api_key,
                     "Content-Type": "application/json"},
            method="POST",
        )
        raw = urllib.request.urlopen(req, timeout=120).read().decode()
        payload = json.loads(raw)
        usage = payload.get("usage", {})
        content = re.sub(r"<\|?think\|?>", "", payload["choices"][0]["message"]["content"]).strip()
        m = re.search(r"\{.*\}", content, re.DOTALL)
        if not m:
            return None, None, None, usage.get("total_tokens", 0)
        try:
            return json.loads(m.group(0)), [], None, usage.get("total_tokens", 0)
        except json.JSONDecodeError:
            return None, None, None, usage.get("total_tokens", 0)
    # Header call
    hdr, hdr_usage = call_llm_header(api_key, raw_text, pdf_name)
    # Items call on the extracted tabular region
    region = extract_item_region(raw_text)
    lineas, total_eur, items_usage = call_llm_items(api_key, region, pdf_name)
    total_tokens = (hdr_usage or {}).get("total_tokens", 0) + (items_usage or {}).get("total_tokens", 0)
    return hdr or {}, lineas, total_eur, total_tokens


def extract_item_region(raw_text):
    """Port of services/pdf-tool-sidecar/src/mercadona-parser.js. Pull the
    tabulated item region out of the sidecar PDF text."""
    start_markers = [
        "Descripci\u00f3n Unid. P.Unitario B.Imp. IGIC Cuota IGIC Importe",
        "Descripci\u00f3n  Unid.  P.Unitario  B.Imp.  IGIC  Cuota  IGIC  Importe",
        "Descripci\u00f3n Unid. P.Unitario",
    ]
    start = 0
    for marker in start_markers:
        idx = raw_text.find(marker)
        if idx >= 0:
            start = idx + len(marker)
            break
    if start == 0:
        return raw_text
    end = len(raw_text)
    for marker in [
        "Inscrita en el Registro",
        "Total Factura",
        "FORMA DE PAGO",
        "TOTAL (",
        "TOTAL  (",
        "MERCADONA S.A. informa",
        "PARA CUALQUIER DEVOLUCI\u00d3N",
    ]:
        idx = raw_text.find(marker, start)
        if idx > 0 and idx < end:
            end = idx
    return raw_text[start:end]


def sidecar_extract(data):
    """Translate pdf-tool-sidecar JSON to the common shape."""
    lineas = []
    for it in (data.get("lineItems") or []):
        lineas.append({
            "descripcion": (it.get("description") or "").strip(),
            "unidades": it.get("units"),
            "precio_unit": it.get("unit_price_eur"),
            "base_imponible": it.get("base_eur"),
            "tipo_iva": it.get("tax_label"),
            "cuota_iva": it.get("tax_eur"),
            "importe": it.get("total_eur"),
        })
    fields = data.get("invoiceFields") or {}
    return {
        "num_factura": fields.get("invoiceNumber"),
        "fecha_factura": fields.get("invoiceDate"),
        "fecha_simplificada": fields.get("simplifiedInvoiceDate"),
        "total_eur": data.get("parserStats", {}).get("sumLineItemTotals"),
        "lineItems": lineas,
    }


def normalize_invnum(s):
    if not s:
        return None
    m = re.match(r"^([A-Z])-([A-Z])(\d{4})-0+(\d+)$", s)
    if m:
        return "%s-%s%s-%s" % (m.group(1), m.group(2), m.group(3), m.group(4))
    return s


def to_iso_date(s):
    """Accept 'DD/MM/YYYY', 'YYYY-MM-DD', or None; return ISO 'YYYY-MM-DD' or None."""
    if not s:
        return None
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", s)
    if m:
        return s
    m = re.match(r"^(\d{2})/(\d{2})/(\d{4})$", s)
    if m:
        return "%s-%s-%s" % (m.group(3), m.group(2), m.group(1))
    return s


def header_compare(extracted, truth):
    if not truth:
        return {}
    res = {}
    for field in ("num_factura", "fecha_factura", "fecha_simplificada"):
        ext_raw = extracted.get(field)
        tru_raw = truth.get(field)
        if field == "num_factura":
            ext = normalize_invnum(ext_raw)
            tru = normalize_invnum(tru_raw)
        else:
            ext = to_iso_date(ext_raw)
            tru = to_iso_date(tru_raw)
        match = (ext is not None and tru is not None and ext == tru)
        res[field] = {
            "extracted_raw": ext_raw,
            "truth_raw": tru_raw,
            "extracted_normalized": ext,
            "truth_normalized": tru,
            "match": match,
        }
    ext_total = to_float(extracted.get("total_eur"))
    tru_total = to_float(truth.get("total"))
    if ext_total is not None and tru_total is not None:
        diff = abs(ext_total - tru_total)
        res["total_eur"] = {"extracted": ext_total, "truth": tru_total,
                            "match": diff < 0.01, "diff": round(diff, 2)}
    else:
        res["total_eur"] = {"extracted": ext_total, "truth": tru_total, "match": None}
    return res


def lineas_compare(extracted_lineas, truth_lineas, tolerance=0.01):
    """Match by (importe, descripcion first 20 chars). Return TP/FP/FN per field."""
    truth_keys = {(round(t["importe"], 2), t["descripcion"][:20]): t for t in truth_lineas}
    ext_keys = {(round(e["importe"], 2), e["descripcion"][:20]): e for e in extracted_lineas}
    matched_truth = set(truth_keys) & set(ext_keys)
    tp = len(matched_truth)
    fp = len(ext_keys) - tp
    fn = len(truth_keys) - tp
    field_correct = {f: 0 for f in ("descripcion", "unidades", "precio_unit", "base_imponible", "tipo_iva", "cuota_iva", "importe")}
    for k in matched_truth:
        e = ext_keys[k]
        t = truth_keys[k]
        if (e.get("descripcion") or "").strip() == (t.get("descripcion") or "").strip():
            field_correct["descripcion"] += 1
        for f in ("unidades", "precio_unit", "base_imponible", "tipo_iva", "cuota_iva", "importe"):
            ev = to_float(e.get(f))
            tv = to_float(t.get(f))
            if ev is not None and tv is not None and abs(ev - tv) < tolerance:
                field_correct[f] += 1
    return {
        "extracted_count": len(ext_keys),
        "truth_count": len(truth_keys),
        "tp": tp, "fp": fp, "fn": fn,
        "precision": round(tp / (tp + fp), 3) if (tp + fp) else 0,
        "recall": round(tp / (tp + fn), 3) if (tp + fn) else 0,
        "field_accuracy": {f: round(v / tp, 3) if tp else 0 for f, v in field_correct.items()},
    }


def main():
    api_key = os.environ.get("MINIMAX_API_KEY", "")
    if not api_key:
        sys.stderr.write("FATAL: MINIMAX_API_KEY env var required\n")
        sys.exit(2)

    print("=" * 86)
    print("A/B: pdf-tool-sidecar (pipeline completo) vs MiniMax-M3")
    print("=" * 86)
    grand_totals = {"a_ms": 0, "b_ms": 0, "b_tokens": 0}
    for folder, pdf_name in PDFS:
        pdf_path = WORKSPACE / folder / pdf_name
        print("\n--- " + pdf_name + " ---")
        if not pdf_path.exists():
            print("  missing"); continue

        t0 = time.time()
        data = fetch_sidecar(pdf_path)
        a_ms = int((time.time() - t0) * 1000)
        a = sidecar_extract(data)
        a_text = data.get("text", "")
        a_inv = normalize_invnum(a.get("num_factura"))
        manual = (folder == "manuales")
        truth = ground_truth(a_inv) if a_inv else None
        if not truth and not manual:
            # try the padded form
            m = re.match(r"^([A-Z])-([A-Z])(\d{4})-(\d+)$", a_inv or "")
            if m:
                padded = "%s-%s%s-%08d" % (m.group(1), m.group(2), m.group(3), int(m.group(4)))
                truth = ground_truth(padded)

        print("  fetching LLM response...")
        t0 = time.time()
        try:
            b_hdr, b_lineas, b_total, b_tokens = call_llm(api_key, a_text, pdf_name, manual)
        except Exception as e:
            print("  LLM error: " + str(e)[:120])
            b_hdr, b_lineas, b_total, b_tokens = None, None, None, 0
        b_ms = int((time.time() - t0) * 1000)
        grand_totals["a_ms"] += a_ms
        grand_totals["b_ms"] += b_ms
        grand_totals["b_tokens"] += b_tokens

        if manual:
            print("  MANUAL document (no line items expected)")
            print("  A sidecar: " + json.dumps({"title_guess": a_text[:60], "parser": data.get("parser")}))
            print("  B LLM: " + json.dumps(b_hdr, default=str)[:300] if b_hdr else "  B LLM: failed to parse")
            continue

        if not truth:
            print("  no ground truth in DB; printing raw outputs only")
            print("  A sidecar: items=" + str(len(a["lineItems"])) + " total=" + str(a.get("total_eur")))
            print("  B LLM: items=" + str(len(b_lineas or [])) + " total=" + str(b_total))
            continue

        a_hdr = header_compare(a, truth)
        b_hdr_cmp = header_compare(b_hdr or {}, truth)
        a_lines_cmp = lineas_compare(a["lineItems"], truth["lineas"])
        b_lines_cmp = lineas_compare(b_lineas or [], truth["lineas"])

        print("  truth: " + json.dumps({k: truth[k] for k in ("num_factura", "fecha_factura", "fecha_simplificada", "total")}))
        print("  A sidecar: time=" + str(a_ms) + "ms   " + json.dumps(a_hdr)[:200])
        print("                  lines: " + json.dumps(a_lines_cmp))
        print("  B LLM    : time=" + str(b_ms) + "ms  tokens=" + str(b_tokens) + "  " + json.dumps(b_hdr_cmp)[:200])
        print("                  lines: " + json.dumps(b_lines_cmp))

    print("\n" + "=" * 86)
    print("grand totals: A=" + str(grand_totals["a_ms"]) + "ms  B=" + str(grand_totals["b_ms"])
          + "ms  B_tokens=" + str(grand_totals["b_tokens"]))
    print("=" * 86)


if __name__ == "__main__":
    main()
