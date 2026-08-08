#!/usr/bin/env python3
"""A/B test: regex posicional vs MiniMax M3 for structured PDF extraction.

Strategy A: regex ported from services/pdf-tool-sidecar/src/mercadona-parser.js
Strategy B: MiniMax M3 via api.minimax.io, JSON-mode prompt
Strategy C (control): pdfplumber.extract_table auto-detection

Ground truth: /home/node/.openclaw/workspace/mercadona.db (openclaw's prior output).

API key comes from MINIMAX_API_KEY env var. Never logged.
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

MERCADONA_LINE_RE = re.compile(
    r"^(?P<desc>[A-Za-zÀ-ÖØ-öø-ÿ0-9][A-Za-zÀ-ÖØ-öø-ÿ0-9\s\.\-/():,ÁÉÍÓÚÑ°ª%&'+,]*?)\s+"
    r"(?P<units>[0-9]+(?:[.,][0-9]+)?)\s+"
    r"(?P<pu>[0-9]+,[0-9]{4})\s+"
    r"(?P<bi>[0-9]+,[0-9]{4})\s+"
    r"(?P<tax>[A-Z][A-Z0-9 ()\.%]{0,8})\s+"
    r"(?P<cuota>[0-9]+,[0-9]{4})\s+"
    r"(?P<imp>[0-9]+,[0-9]{4})\s*\.?\s*$"
)
HEADER_LINE_RE = re.compile(
    r"^(?:PÁGINA|COMERCIANTE MINORISTA|MERCADONA S\.A\.|DATOS FISCALES|"
    r"Descripción\s+Unid|Inscrita en el Registro|Para cualquier devolución|"
    r"MERCADONA S\.A\.\s+informa|Fdo\.\s+MERCADONA|Firmado digitalmente por|"
    r"SELLO DE ENTIDAD MERCADONA|Fecha:|TOTAL\s*\([€E]\)|Total\s+Factura|FORMA DE PAGO)",
    re.IGNORECASE,
)


def parse_num(s):
    return float(s.replace(".", "").replace(",", "."))


def fetch_text_from_sidecar(pdf_path):
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


def strategy_a_regex(raw_text):
    items, seen = [], set()
    for raw_line in raw_text.split("\n"):
        line = re.sub(r"\s+", " ", raw_line).strip().rstrip(".")
        if not line or HEADER_LINE_RE.match(line):
            continue
        m = MERCADONA_LINE_RE.match(line)
        if not m:
            continue
        key = "%s|%s|%s" % (m.group("desc"), m.group("units"), m.group("imp"))
        if key in seen:
            continue
        seen.add(key)
        items.append({
            "description": m.group("desc").strip(),
            "units": parse_num(m.group("units")),
            "unit_price_eur": parse_num(m.group("pu")),
            "base_eur": parse_num(m.group("bi")),
            "tax_label": m.group("tax").strip(),
            "tax_eur": parse_num(m.group("cuota")),
            "total_eur": parse_num(m.group("imp")),
        })
    return items


def strategy_c_extract_table(pdf_path):
    import pdfplumber
    items, seen = [], set()
    with pdfplumber.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables() or []:
                rows = [[(c or "").strip() for c in row] for row in table if any(c)]
                for row in rows:
                    if len(row) < 7:
                        continue
                    tail = row[-6:]
                    if not re.match(r"^\d+(?:[.,]\d+)?$", tail[0]):
                        continue
                    if not all(re.match(r"^\d+,\d{4}$", c) for c in tail[1:5]):
                        continue
                    desc = " ".join(row[:-6]).strip()
                    key = "%s|%s|%s" % (desc, tail[0], tail[5])
                    if key in seen:
                        continue
                    seen.add(key)
                    items.append({
                        "description": desc,
                        "units": parse_num(tail[0]),
                        "unit_price_eur": parse_num(tail[1]),
                        "base_eur": parse_num(tail[2]),
                        "tax_label": tail[5],
                        "tax_eur": parse_num(tail[3]),
                        "total_eur": parse_num(tail[4]),
                    })
    return items


def strategy_b_llm(api_key, raw_text, pdf_name):
    """Send the whole sidecar text to MiniMax M3 and ask for JSON list."""
    prompt = (
        "You extract structured line items from a Mercadona invoice PDF text.\n"
        "Return ONLY a JSON object: {\"lineItems\":[{\"description\":str,\"units\":number,"
        "\"unit_price_eur\":number,\"base_eur\":number,\"tax_label\":str,\"tax_eur\":number,"
        "\"total_eur\":number}],\"total_eur\":number}.\n"
        "Match these columns exactly: Descripcion (product name) | Unid. (quantity) | "
        "P.Unitario | B.Imp. (base) | tax_label (EX / IGIC / IGIC (X%) / IVA / etc.) | "
        "Cuota (tax amount) | Importe (line total).\n"
        "Decimal fields use comma as the decimal separator. Convert to float with dot.\n"
        "Skip the header row and any non-item rows (totals, tax summaries).\n"
        "If the PDF text is NOT tabular (e.g. manual, contract), return {\"lineItems\":[],"
        "\"total_eur\":null}.\n\n"
        "PDF name: " + pdf_name + "\n\n"
        "=== PDF text ===\n" + raw_text
    )
    body = json.dumps({
        "model": LLM_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 8000,
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
    content = payload["choices"][0]["message"]["content"]
    # Strip thinking blocks if present (M3 returns <think>...</think>)
    content = re.sub(r"<\|?think\|?>", "", content).strip()
    m = re.search(r"\{.*\}", content, re.DOTALL)
    if not m:
        return [], None
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return [], None
    items = data.get("lineItems") or []
    norm = []
    for it in items:
        try:
            norm.append({
                "description": str(it.get("description") or ""),
                "units": float(it.get("units") or 0),
                "unit_price_eur": float(it.get("unit_price_eur") or 0),
                "base_eur": float(it.get("base_eur") or 0),
                "tax_label": str(it.get("tax_label") or ""),
                "tax_eur": float(it.get("tax_eur") or 0),
                "total_eur": float(it.get("total_eur") or 0),
            })
        except (TypeError, ValueError):
            continue
    return norm, data.get("total_eur")


def ground_truth_from_db(num_factura):
    if not DB_PATH.exists():
        return None
    conn = sqlite3.connect(str(DB_PATH))
    try:
        c = conn.cursor()
        c.execute("SELECT id FROM facturas WHERE num_factura = ?", (num_factura,))
        row = c.fetchone()
        if not row:
            return None
        c.execute("SELECT descripcion, unidades, precio_unit, base_imponible, tipo_iva, cuota_iva, importe FROM lineas WHERE factura_id = ? ORDER BY id", (row[0],))
        items = []
        for r in c.fetchall():
            items.append({"description": r[0], "units": r[1], "unit_price_eur": r[2],
                          "base_eur": r[3], "tax_label": r[4], "tax_eur": r[5],
                          "total_eur": r[6]})
        c.execute("SELECT total FROM facturas WHERE id = ?", (row[0],))
        total = c.fetchone()[0]
        return {"items": items, "total": total}
    finally:
        conn.close()


def normalize_invoice_number(raw):
    if not raw:
        return None
    m = re.match(r"^([A-Z])-([A-Z])(\d{4})-0+(\d+)$", raw)
    if m:
        return "%s-%s%s-%s" % (m.group(1), m.group(2), m.group(3), m.group(4))
    return raw


def precision_recall(parsed, truth):
    if not truth or not truth["items"]:
        return None
    truth_set = {(round(t["total_eur"], 2), t["description"][:25]) for t in truth["items"]}
    parsed_set = {(round(p["total_eur"], 2), p["description"][:25]) for p in parsed}
    true_pos = len(truth_set & parsed_set)
    precision = true_pos / len(parsed_set) if parsed_set else 0
    recall = true_pos / len(truth_set) if truth_set else 0
    return {"precision": round(precision, 3), "recall": round(recall, 3),
            "true_positives": true_pos, "truth_n": len(truth_set), "parsed_n": len(parsed_set)}


def main():
    api_key = os.environ.get("MINIMAX_API_KEY", "")
    if not api_key:
        sys.stderr.write("FATAL: MINIMAX_API_KEY env var is required\n")
        sys.exit(2)

    pdfs = [
        ("mercadona", "A-G2026-246011.pdf"),
        ("mercadona", "A-G2026-385710.pdf"),
        ("mercadona", "A-G2026-372617.pdf"),
        ("manuales", "BG-NAC-2-NAC-3-manual-calibracion.pdf"),
    ]
    print("=" * 78)
    print("A/B/C test: regex posicional vs MiniMax-M3 vs pdfplumber.extract_table")
    print("=" * 78)
    for folder, pdf_name in pdfs:
        pdf_path = WORKSPACE / folder / pdf_name
        print("\n--- " + pdf_name + " ---")
        if not pdf_path.exists():
            print("  missing"); continue
        data = fetch_text_from_sidecar(pdf_path)
        text = data["text"]
        inv = normalize_invoice_number(data.get("invoiceFields", {}).get("invoiceNumber"))
        truth = ground_truth_from_db(inv)
        truth_n = len(truth["items"]) if truth and truth["items"] else 0

        t0 = time.time()
        a_items = strategy_a_regex(text)
        a_ms = int((time.time() - t0) * 1000)
        a_metrics = precision_recall(a_items, truth) if truth else None
        a_sum = round(sum(i["total_eur"] for i in a_items), 2)

        t0 = time.time()
        c_items = []
        c_metrics = None
        c_sum = 0
        c_ms = 0
        # Strategy C (pdfplumber.extract_table) requires pdfplumber, not installed in gateway.

        print("  fetching LLM response...")
        t0 = time.time()
        try:
            b_items, b_total = strategy_b_llm(api_key, text, pdf_name)
        except Exception as e:
            print("  LLM error: " + str(e)[:80])
            b_items, b_total = [], None
        b_ms = int((time.time() - t0) * 1000)
        b_metrics = precision_recall(b_items, truth) if truth else None
        b_sum = round(sum(i["total_eur"] for i in b_items), 2)

        truth_total = truth["total"] if truth else None
        print("  ground truth (" + str(inv) + "):  items=" + str(truth_n) + "  total=" + str(truth_total))
        print("  A regex posicional:   items=%3d  sum=%7.2f  time=%4dms  metrics=%s" % (len(a_items), a_sum, a_ms, a_metrics))
        print("  B MiniMax-M3:         items=%3d  sum=%7.2f  time=%4dms  metrics=%s  total=%s" % (len(b_items), b_sum, b_ms, b_metrics, b_total))


if __name__ == "__main__":
    main()
