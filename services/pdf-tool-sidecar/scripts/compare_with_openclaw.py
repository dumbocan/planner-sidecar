#!/usr/bin/env python3
"""Compare openclaw's parse_mercadona_factura.py against our pdf-tool-sidecar.

Three conditions for the SAME PDFs:
  A) pdf-tool-sidecar (full pipeline, what we already ship)
  B) parse_mercadona_factura.parse_mercadona_lines on the RAW sidecar text
     (no preprocessing — would be the failure case if openclaw didn't preprocess)
  C) parse_mercadona_factura.parse_mercadona_lines AFTER a light pre-split
     (one item per line). This is what openclaw's agent presumably did.

Ground truth: mercadona.db lineas for A-G2026-246011, 246024, 372617.
"""
import importlib.util
import json
import re
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path

WORKSPACE = Path("/home/node/.openclaw/workspace")
DB_PATH = WORKSPACE / "mercadona.db"
SIDECAR_URL = "http://pdf-tool-sidecar:3000/mcp"
PARSER_PATH = "/tmp/parse_mercadona_factura.py"  # copied in via docker cp

# Load openclaw's parser as a module
spec = importlib.util.spec_from_file_location("pmm", PARSER_PATH)
pmm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pmm)


def fetch_sidecar(pdf_path):
    req = urllib.request.Request(
        SIDECAR_URL,
        data=json.dumps({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"ab","version":"0"}}}).encode(),
        headers={"Content-Type":"application/json","Accept":"application/json, text/event-stream"},
        method="POST",
    )
    resp = urllib.request.urlopen(req, timeout=30)
    sid = resp.headers.get("mcp-session-id")
    urllib.request.urlopen(urllib.request.Request(
        SIDECAR_URL,
        data=json.dumps({"jsonrpc":"2.0","method":"notifications/initialized"}).encode(),
        headers={"Content-Type":"application/json","Mcp-Session-Id":sid,"Accept":"application/json, text/event-stream"},
        method="POST",
    ), timeout=30).read()
    req = urllib.request.Request(
        SIDECAR_URL,
        data=json.dumps({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"extract_pdf_from_path","arguments":{"path":str(pdf_path)}}}).encode(),
        headers={"Content-Type":"application/json","Mcp-Session-Id":sid,"Accept":"application/json, text/event-stream"},
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
    if not DB_PATH.exists():
        return None
    conn = sqlite3.connect(str(DB_PATH))
    try:
        c = conn.cursor()
        m = re.match(r"^([A-Z])-([A-Z])(\d{4})-(\d+)$", num_factura or "")
        candidates = [num_factura]
        if m:
            # Try both forms: short (no padding) and long (padded to 10 digits)
            digits = m.group(4)
            candidates.append("%s-%s%s-%s" % (m.group(1), m.group(2), m.group(3), digits))
            candidates.append("%s-%s%s-%s" % (m.group(1), m.group(2), m.group(3), digits.zfill(10)))
            candidates.append("%s-%s%s-%s" % (m.group(1), m.group(2), m.group(3), digits.zfill(11)))
        ph = ",".join("?" for _ in candidates)
        # print("DEBUG candidates:", candidates)
        c.execute("SELECT id, num_factura FROM facturas WHERE num_factura IN (" + ph + ")", candidates)
        row = c.fetchone()
        if not row:
            # Try fuzzy match: any invoice containing the same last digits
            digits = re.findall(r"\d+", num_factura or "")
            last = digits[-1] if digits else ""
            if last:
                c.execute("SELECT id, num_factura FROM facturas WHERE num_factura LIKE ?", ("%" + last,))
                row = c.fetchone()
        if not row:
            return None
        c.execute("SELECT descripcion, importe FROM lineas WHERE factura_id = ? ORDER BY id", (row[0],))
        items = []
        for r in c.fetchall():
            items.append({"descripcion": (r[0] or "").strip(), "importe": r[1]})
        return items
    finally:
        conn.close()


def normalize_invnum(s):
    if not s:
        return None
    m = re.match(r"^([A-Z])-([A-Z])(\d{4})-0+(\d+)$", s)
    if m:
        return "%s-%s%s-%s" % (m.group(1), m.group(2), m.group(3), m.group(4))
    return s


def padded_invnum(s):
    if not s:
        return None
    m = re.match(r"^([A-Z])-([A-Z])(\d{4})-(\d+)$", s)
    if m:
        # Pad to match the DB format (e.g. A-G2026-246011 -> A-G2026-00000246011)
        digits = m.group(4)
        padded = digits.zfill(len(digits) + 2)  # heuristic pad
        return "%s-%s%s-%s" % (m.group(1), m.group(2), m.group(3), padded)
    return s


def light_pre_split(raw_text):
    """Approximate what openclaw likely did: split each item into its own
    line. Strategy: insert \n before each MAYÚSCULAS+lowercase word that
    follows a 4-decimal amount."""
    # 1) Strip the header region (anything before "Descripci\u00f3n Unid.")
    start_markers = [
        "Descripci\u00f3n Unid. P.Unitario B.Imp. IGIC Cuota IGIC Importe",
        "Descripci\u00f3n Unid. P.Unitario",
    ]
    s = 0
    for m in start_markers:
        i = raw_text.find(m)
        if i >= 0:
            s = i + len(m)
            break
    e = len(raw_text)
    for m in ["Inscrita en el Registro", "Total Factura", "FORMA DE PAGO", "TOTAL ("]:
        i = raw_text.find(m, s)
        if i > 0 and i < e:
            e = i
    region = raw_text[s:e]
    items = re.split(r"(?<=\d,\d{4})\s{2,}(?=[A-Z][a-zA-Z\u00C0-\u00d6])", region)
    return [s.strip() for s in items if s.strip()]


def openclaw_smart_parse(line):
    """Replication of parse_mercadona_factura.smart_parse (which is private
    inside parse_mercadona_lines)."""
    parts = re.split(r"\s{2,}", line.strip())
    if len(parts) < 7:
        return None
    desc = " ".join(parts[:-6])
    num = parts[-6:]
    if len(num) != 6:
        return None
    unid, p_unit, b_imp, igic, cuota, importe = num
    try:
        imp_val = float(importe.replace(",", "."))
    except (ValueError, AttributeError):
        imp_val = 0.0
    return {
        "descripcion": desc,
        "unidades": unid,
        "importe": importe,
        "imp_val": imp_val,
    }


def sidecar_to_common(data):
    """Translate sidecar output to a flat list of {descripcion, importe}."""
    return [
        {"descripcion": (it.get("description") or "").strip(),
         "importe": it.get("total_eur")}
        for it in (data.get("lineItems") or [])
    ]


def openclaw_to_common(items):
    """Translate parse_mercadona_lines output to {descripcion, importe}."""
    return [{"descripcion": it["descripcion"], "importe": it["imp_val"]} for it in items]


def compare(predicted, truth, label):
    if not truth:
        return {"label": label, "skipped": True}
    truth_keys = {(round(t["importe"], 2), t["descripcion"][:25]) for t in truth}
    pred_keys = {(round(p["importe"], 2), p["descripcion"][:25]) for p in predicted if p.get("importe") is not None}
    tp = len(truth_keys & pred_keys)
    fp = len(pred_keys) - tp
    fn = len(truth_keys) - tp
    return {
        "label": label,
        "extracted_count": len(predicted),
        "truth_count": len(truth),
        "tp": tp, "fp": fp, "fn": fn,
        "precision": round(tp / (tp + fp), 3) if (tp + fp) else 0,
        "recall": round(tp / (tp + fn), 3) if (tp + fn) else 0,
    }


def main():
    pdfs = ["A-G2026-246011.pdf", "A-G2026-246024.pdf", "A-G2026-372617.pdf"]
    print("=" * 96)
    print("Comparison: pdf-tool-sidecar vs openclaw parse_mercadona_lines")
    print("=" * 96)
    for pdf_name in pdfs:
        pdf_path = WORKSPACE / "mercadona" / pdf_name
        print("\n--- " + pdf_name + " ---")
        data = fetch_sidecar(pdf_path)
        text = data.get("text", "")
        inv = normalize_invnum((data.get("invoiceFields") or {}).get("invoiceNumber"))
        truth = ground_truth(inv)
        if not truth:
            print("  no ground truth")
            continue

        # A: sidecar (full pipeline)
        a_items = sidecar_to_common(data)

        # B: openclaw parser on RAW sidecar text (no preprocessing)
        b_raw = pmm.parse_mercadona_lines(text)

        # C: openclaw parser after light pre-split
        c_lines = light_pre_split(text)
        c_items = []
        for line in c_lines:
            parsed = openclaw_smart_parse(line)
            if parsed:
                c_items.append(parsed)
        c_items = [{"descripcion": it["descripcion"], "importe": it["imp_val"]} for it in c_items]
        # Openclaw's script dedupes by (desc, importe) only
        seen = set()
        c_unique = []
        for it in c_items:
            k = (it["descripcion"], it["importe"])
            if k in seen:
                continue
            seen.add(k)
            c_unique.append(it)
        c_items = c_unique

        ra = compare(a_items, truth, "A sidecar")
        rb = compare([{"descripcion": it["descripcion"], "importe": it["imp_val"]} for it in b_raw],
                     truth, "B openclaw RAW")
        rc = compare(c_items, truth, "C openclaw pre-split")
        print("  truth lines: " + str(len(truth)))
        for r in (ra, rb, rc):
            if r.get("skipped"):
                continue
            print("  " + r["label"] + ": extracted=" + str(r["extracted_count"]) +
                  " tp=" + str(r["tp"]) + " fp=" + str(r["fp"]) + " fn=" + str(r["fn"]) +
                  " P=" + str(r["precision"]) + " R=" + str(r["recall"]))

    print("=" * 96)


if __name__ == "__main__":
    main()
