#!/usr/bin/env python3
"""Re-fill the mercadona.db with totals from the sidecar.

For every factura in the DB, look up the matching PDF in workspace/mercadona
and call pdf-tool-sidecar to get sumLineItemTotals. Update the total column
where the sidecar gives us a positive number. Also update fecha_factura and
fecha_simplificada to ISO format if needed (DB stores DD/MM/YYYY).

Pure stdlib. Run inside the gateway container.
"""

import json
import re
import sqlite3
import urllib.request
from datetime import datetime
from pathlib import Path

WORKSPACE = Path("/home/node/.openclaw/workspace")
PDF_DIR = WORKSPACE / "mercadona"
DB_PATH = WORKSPACE / "mercadona.db"
SIDECAR_URL = "http://pdf-tool-sidecar:3000/mcp"


def fetch_sidecar(pdf_path):
    req = urllib.request.Request(
        SIDECAR_URL,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                         "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                                    "clientInfo": {"name": "refill", "version": "0"}}}).encode(),
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


def to_iso(s):
    if not s:
        return None
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", s)
    if m:
        return s
    m = re.match(r"^(\d{2})/(\d{2})/(\d{4})$", s)
    if m:
        return "%s-%s-%s" % (m.group(3), m.group(2), m.group(1))
    return None


def normalize_invnum(s):
    if not s:
        return None
    m = re.match(r"^([A-Z])-([A-Z])(\d{4})-0+(\d+)$", s)
    if m:
        return "%s-%s%s-%s" % (m.group(1), m.group(2), m.group(3), m.group(4))
    return s


def pdf_for(num_factura):
    """Find the PDF in workspace/mercadona that matches the invoice number."""
    m = re.match(r"^([A-Z])-([A-Z])(\d{4})-(\d+)$", num_factura or "")
    if not m:
        return None
    short = "%s-%s%s-%s.pdf" % (m.group(1), m.group(2), m.group(3), m.group(4))
    candidate = PDF_DIR / short
    if candidate.exists():
        return candidate
    return None


def main():
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    c.execute("SELECT id, num_factura, total FROM facturas ORDER BY id")
    rows = c.fetchall()
    updated = 0
    skipped = 0
    failed = 0
    for fid, num, current_total in rows:
        pdf_path = pdf_for(num)
        if not pdf_path:
            skipped += 1
            continue
        try:
            data = fetch_sidecar(pdf_path)
        except Exception as e:
            print("FETCH FAIL", num, e, flush=True)
            failed += 1
            continue
        stats = data.get("parserStats") or {}
        sum_total = stats.get("sumLineItemTotals") or 0
        inv_field = (data.get("invoiceFields") or {}).get("invoiceNumber")
        fecha_iso = to_iso((data.get("invoiceFields") or {}).get("invoiceDate"))
        fecha_simp_iso = to_iso((data.get("invoiceFields") or {}).get("simplifiedInvoiceDate"))
        # Sidecar fecha is ISO; DB is DD/MM/YYYY. Convert ISO back to DD/MM/YYYY for the DB.
        def iso_to_ddmmyyyy(iso):
            if not iso:
                return None
            m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", iso)
            if m:
                return "%s/%s/%s" % (m.group(3), m.group(2), m.group(1))
            return None
        fecha_db = iso_to_ddmmyyyy(fecha_iso)
        fecha_simp_db = iso_to_ddmmyyyy(fecha_simp_iso)
        updates = []
        if sum_total > 0:
            updates.append(("total", round(sum_total, 2)))
        if fecha_db:
            updates.append(("fecha_factura", fecha_db))
        if fecha_simp_db:
            updates.append(("fecha_simplificada", fecha_simp_db))
        if updates:
            sets = ", ".join("%s = ?" % col for col, _ in updates)
            params = [v for _, v in updates] + [fid]
            c.execute("UPDATE facturas SET " + sets + " WHERE id = ?", params)
            updated += 1
            print("UPDATED", num, "items=" + str(stats.get("lineItemsDetected") or 0),
                  "total=" + str(round(sum_total, 2)) if sum_total else "total=unchanged",
                  "fecha=" + str(fecha_db), flush=True)
        else:
            skipped += 1
            print("SKIPPED", num, "no total from sidecar", flush=True)
    conn.commit()
    conn.close()
    print("done updated=" + str(updated) + " skipped=" + str(skipped) + " failed=" + str(failed), flush=True)


if __name__ == "__main__":
    main()
