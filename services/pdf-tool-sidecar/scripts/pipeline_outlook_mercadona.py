#!/usr/bin/env python3
"""Mercadona invoice pipeline (Outlook → workspace → DB).

Runs inside the gateway container. Calls:
  - outlook-mail-sidecar MCP for search + save
  - pdf-tool-sidecar MCP for extract
  - sqlite3 directly for DB persistence
"""
import json
import os
import re
import sqlite3
import urllib.request
from pathlib import Path

OUTLOOK_MCP = "http://outlook-mail-sidecar:3000/mcp"
PDF_TOOL_MCP = "http://pdf-tool-sidecar:3000/mcp"
WORKSPACE_PDF_DIR = Path("/home/node/.openclaw/workspace/mercadona")
DB_PATH = Path("/home/node/.openclaw/workspace/mercadona.db")
INGEST_SCRIPT = os.environ.get("INGEST_SCRIPT", "/home/node/.openclaw/workspace/.runners/ingest_mercadona.py")
BACKUP_DB = "/home/node/.openclaw/workspace/mercadona.db.bak-pre-pipeline-"


def mcp_request(url, method, params=None, session_id=None, request_id=1, expect_response=True):
    payload = {"jsonrpc": "2.0", "method": method, "params": params or {}}
    if expect_response:
        payload["id"] = request_id
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=120) as response:
        sid = response.headers.get("mcp-session-id")
        if sid and not session_id:
            session_id = sid
        text = response.read().decode()
    if not expect_response:
        return None, session_id
    for line in text.split("\n"):
        if line.startswith("data:"):
            try:
                d = json.loads(line[5:].strip())
                if "error" in d:
                    raise RuntimeError("mcp error: " + str(d["error"]))
                return d.get("result"), session_id
            except json.JSONDecodeError:
                continue
    return None, session_id


def call_tool(url, sid, name, args, rid):
    res, sid = mcp_request(url, "tools/call", {"name": name, "arguments": args}, sid, rid)
    if not isinstance(res, dict):
        raise RuntimeError("tool result not a dict")
    content = res.get("content", [])
    text = ""
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            text += block.get("text", "")
    return json.loads(text) if text else res, sid


def init_session(url, name):
    _, sid = mcp_request(url, "initialize", {
        "protocolVersion": "2025-03-26", "capabilities": {},
        "clientInfo": {"name": name, "version": "0"},
    })
    mcp_request(url, "notifications/initialized", {}, sid, expect_response=False)
    return sid


def normalize_invnum(s):
    if not s:
        return None
    m = re.match(r"^([A-Z])-([A-Z])(\d{4})-(\d+)$", s)
    if m:
        return "%s-%s%s-%s" % (m.group(1), m.group(2), m.group(3), m.group(4))
    return s


def existing_invoice_numbers():
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    c.execute("SELECT num_factura FROM facturas")
    rows = [r[0] for r in c.fetchall()]
    conn.close()
    norm = set()
    for r in rows:
        n = normalize_invnum(r)
        if n:
            norm.add(n)
    return norm


def main():
    import shutil
    from datetime import datetime
    stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    shutil.copy2(str(DB_PATH), BACKUP_DB + stamp)
    print(f"[backup] {BACKUP_DB}{stamp}")

    existing = existing_invoice_numbers()
    print(f"[init] {len(existing)} unique invoices already in DB")

    o_sid = init_session(OUTLOOK_MCP, "outlook-pipeline")
    rid = 2

    # Search Mercadona messages
    search_res, o_sid = call_tool(OUTLOOK_MCP, o_sid, "outlook_search_messages",
                                 {"query": "mercadona", "limit": 50}, rid)
    rid += 1
    if not isinstance(search_res, list):
        print(f"[outlook] search returned non-list: {search_res}")
        return
    print(f"[outlook] {len(search_res)} Mercadona messages")

    # Collect PDF candidates
    candidates = []
    for msg in search_res:
        if not isinstance(msg, dict):
            continue
        message_id = msg.get("messageId")
        if not message_id:
            continue
        try:
            atts, o_sid = call_tool(OUTLOOK_MCP, o_sid, "outlook_list_pdf_attachments",
                                    {"messageId": message_id, "limit": 5}, rid)
            rid += 1
        except Exception as e:
            print(f"[outlook] list_attachments {message_id}: {e}")
            continue
        if not isinstance(atts, list):
            continue
        for att in atts:
            if not isinstance(att, dict):
                continue
            name = att.get("name") or ""
            m = re.match(r"^([A-Z])-([A-Z])(\d{4})-(\d+)\.pdf$", name)
            if not m:
                continue
            short_num = "%s-%s%s-%s" % (m.group(1), m.group(2), m.group(3), m.group(4))
            candidates.append((message_id, att.get("attachmentId"), name, short_num))

    print(f"[outlook] {len(candidates)} Mercadona PDF candidates across messages")

    # Filter NEW
    to_download = [c for c in candidates if c[3] not in existing]
    print(f"[filter] {len(to_download)} NEW (skipped {len(candidates) - len(to_download)} already in DB)")

    if not to_download:
        print("[done] DB is up to date.")
        return

    # Download each new invoice
    WORKSPACE_PDF_DIR.mkdir(parents=True, exist_ok=True)
    downloaded = []
    for message_id, att_id, name, short_num in to_download:
        print(f"[download] {name} (num={short_num})")
        try:
            res, o_sid = call_tool(OUTLOOK_MCP, o_sid, "outlook_save_pdf_attachment", {
                "messageId": message_id,
                "attachmentId": att_id,
                "confirm": True,
                "outDir": "mercadona",
            }, rid)
            rid += 1
        except Exception as e:
            print(f"  FAIL: {e}")
            continue
        if not isinstance(res, dict) or not res.get("savedPath"):
            print(f"  FAIL: no savedPath in {res}")
            continue
        downloaded.append((res.get("savedPath"), name, short_num))
        print(f"  saved {res.get('savedPath')} (sha={res.get('sha256','')[:12]})")

    if not downloaded:
        print("[done] No downloads succeeded.")
        return

    # The outlook-sidecar now writes directly to /home/node/.openclaw/workspace/mercadona/
    # because OUTLOOK_WORKSPACE_ROOT is set. Confirm files exist.
    print("\n[verify] files in workspace/mercadona/:")
    for _, name, _ in downloaded:
        p = WORKSPACE_PDF_DIR / name
        if p.exists():
            print(f"  ✓ {p.name} ({p.stat().st_size} bytes)")
        else:
            print(f"  ✗ {p.name} MISSING")

    # Run the existing ingest-mercadona.py
    print("\n[ingest] running " + INGEST_SCRIPT)
    import subprocess
    r = subprocess.run(["python3", INGEST_SCRIPT], capture_output=True, text=True)
    print(r.stdout[-1500:] if r.stdout else "(no stdout)")
    if r.stderr:
        print("STDERR:", r.stderr[-500:])
    print(f"[ingest] exit={r.returncode}")

    # Report
    print("\n[report]")
    conn = sqlite3.connect(str(DB_PATH))
    c = conn.cursor()
    c.execute("SELECT COUNT(*) FROM facturas")
    print(f"  total facturas in DB: {c.fetchone()[0]}")
    c.execute("SELECT COUNT(*) FROM lineas")
    print(f"  total lineas in DB: {c.fetchone()[0]}")
    c.execute("""SELECT num_factura, fecha_factura, total FROM facturas
                 WHERE num_factura IN (""" + ",".join("?" for _ in downloaded) + """)
                 ORDER BY fecha_factura DESC""",
              [n[2] for n in downloaded])
    print("  added invoices:")
    for r in c.fetchall():
        print(f"    {r[0]}  fecha={r[1]}  total={r[2]}")
    conn.close()


if __name__ == "__main__":
    main()
