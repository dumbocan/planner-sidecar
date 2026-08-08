#!/usr/bin/env python3
"""Ingest all *.pdf under /home/node/.openclaw/workspace/mercadona/ into mercadona.db
via the pdf-tool-sidecar MCP. Pure stdlib. Run inside the gateway container.

Idempotent: re-running upserts by num_factura and skips duplicate line items
by (factura_id, descripcion, importe).
"""

import hashlib
import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

WORKSPACE_PDF_DIR = Path("/home/node/.openclaw/workspace/mercadona")
DB_PATH = Path("/home/node/.openclaw/workspace/mercadona.db")
SIDECAR_URL = "http://pdf-tool-sidecar:3000/mcp"


def log(level, msg):
    ts = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    sys.stderr.write(f"[{ts}] {level} {msg}\n")
    sys.stderr.flush()


def mcp_request(method, params, session_id=None, request_id=1, expect_response=True):
    payload = {"jsonrpc": "2.0", "method": method, "params": params}
    if expect_response:
        payload["id"] = request_id
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(SIDECAR_URL, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=60) as response:
        sid = response.headers.get("mcp-session-id")
        if sid and not session_id:
            session_id = sid
        text = response.read().decode("utf-8")
    if not expect_response:
        return None, session_id
    data = None
    for line in text.split("\n"):
        if line.startswith("data:"):
            try:
                data = json.loads(line[5:].strip())
            except json.JSONDecodeError:
                continue
    if data is None:
        raise RuntimeError(f"mcp {method}: empty response")
    if "error" in data:
        raise RuntimeError(f"mcp {method}: {data['error']}")
    return data.get("result"), session_id


def call_extract(path_value):
    init_result, sid = mcp_request(
        "initialize",
        {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "ingest-mercadona", "version": "0.1.0"},
        },
        request_id=1,
    )
    mcp_request("notifications/initialized", {}, sid, expect_response=False)
    result, sid = mcp_request(
        "tools/call",
        {"name": "extract_pdf_from_path", "arguments": {"path": path_value}},
        sid,
        request_id=2,
    )
    content = result.get("content", [])
    text = ""
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            text = block.get("text", "")
            break
    return json.loads(text)


def short_invoice(raw):
    if not raw:
        return None
    # A-G2026-00000246011 → A-G2026-246011
    m = re.match(r"^([A-Z])-([A-Z])(\d{4})-0+(\d+)$", raw)
    if m:
        return f"{m.group(1)}-{m.group(2)}{m.group(3)}-{m.group(4)}"
    return raw


def iso_to_ddmmyyyy(iso):
    if not iso or not re.match(r"^\d{4}-\d{2}-\d{2}$", iso):
        return None
    y, m, d = iso.split("-")
    return f"{d}/{m}/{y}"


def main():
    if not WORKSPACE_PDF_DIR.exists():
        raise SystemExit(f"{WORKSPACE_PDF_DIR} not found")
    if not DB_PATH.exists():
        raise SystemExit(f"{DB_PATH} not found")

    pdfs = sorted(WORKSPACE_PDF_DIR.glob("*.pdf"))
    log("INFO", f"found {len(pdfs)} PDFs in {WORKSPACE_PDF_DIR}")

    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()

    updated = 0
    inserted_lines = 0
    skipped = 0
    failed = 0
    manual_logged = 0

    for pdf in pdfs:
        try:
            log("INFO", f"extract {pdf.name}")
            data = call_extract(str(pdf))
        except Exception as exc:
            log("ERROR", f"extract {pdf.name}: {exc}")
            failed += 1
            continue

        invoice_number = short_invoice(data.get("invoiceFields", {}).get("invoiceNumber"))
        fecha = iso_to_ddmmyyyy(data.get("invoiceFields", {}).get("invoiceDate"))
        fecha_simp = iso_to_ddmmyyyy(data.get("invoiceFields", {}).get("simplifiedInvoiceDate"))
        parser = data.get("parser")
        stats = data.get("parserStats", {})
        line_items = data.get("lineItems") or []
        sum_total = stats.get("sumLineItemTotals") or 0.0

        if not invoice_number:
            if manual_logged < 3:
                first_chars = (data.get("text") or "")[:200].replace("\n", " / ")
                log("INFO", f"non-invoice PDF {pdf.name}: parser={parser} text='{first_chars}'")
                manual_logged += 1
            skipped += 1
            continue

        c.execute(
            """
            INSERT INTO facturas (num_factura, fecha_factura, fecha_simplificada, total)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(num_factura) DO UPDATE SET
              fecha_factura = COALESCE(excluded.fecha_factura, facturas.fecha_factura),
              fecha_simplificada = COALESCE(excluded.fecha_simplificada, facturas.fecha_simplificada),
              total = COALESCE(excluded.total, facturas.total)
            """,
            (invoice_number, fecha, fecha_simp, sum_total if sum_total > 0 else None),
        )
        c.execute("SELECT id FROM facturas WHERE num_factura = ?", (invoice_number,))
        factura_id = c.fetchone()[0]

        for item in line_items:
            c.execute(
                """
                SELECT 1 FROM lineas
                WHERE factura_id = ?
                  AND descripcion = ?
                  AND ABS(importe - ?) < 0.005
                LIMIT 1
                """,
                (factura_id, item.get("description"), float(item.get("total_eur") or 0)),
            )
            if c.fetchone():
                continue
            c.execute(
                """
                INSERT INTO lineas (
                    factura_id, descripcion, unidades, precio_unit,
                    base_imponible, tipo_iva, cuota_iva, importe
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    factura_id,
                    item.get("description"),
                    item.get("units"),
                    item.get("unit_price_eur"),
                    item.get("base_eur"),
                    item.get("tax_label"),
                    item.get("tax_eur"),
                    item.get("total_eur"),
                ),
            )
            inserted_lines += 1

        log(
            "INFO",
            f"upsert {pdf.name} → {invoice_number} fecha={fecha} total={sum_total} "
            f"line_items={len(line_items)} parser={parser}",
        )
        updated += 1

    conn.commit()
    c.execute("SELECT COUNT(*) FROM facturas")
    total_facturas = c.fetchone()[0]
    c.execute("SELECT COUNT(*) FROM lineas")
    total_lineas = c.fetchone()[0]
    conn.close()

    log(
        "INFO",
        f"done updated={updated} skipped={skipped} failed={failed} "
        f"new_lineas={inserted_lines} "
        f"db_facturas={total_facturas} db_lineas={total_lineas}",
    )


if __name__ == "__main__":
    main()
