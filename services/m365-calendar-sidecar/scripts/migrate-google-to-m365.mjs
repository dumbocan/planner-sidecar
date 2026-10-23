#!/usr/bin/env node
/**
 * migrate-google-to-m365.mjs
 * 
 * Migrates all events from Google Calendar to Microsoft 365 Calendar.
 * 
 * Usage:
 *   node scripts/migrate-google-to-m365.mjs [--dry-run] [--account laia]
 * 
 * This script:
 *   1. Lists all calendars from Google
 *   2. Fetches all events from each calendar (full history)
 *   3. Creates each event in Microsoft 365
 *   4. Reports results (success/fail/skip counts)
 * 
 * Environment:
 *   GOOGLE_READ_URL  - Google Read sidecar URL (default: http://google-read-sidecar:3000/mcp)
 *   M365_CALENDAR_URL - M365 Calendar sidecar URL (default: http://m365-calendar-sidecar:3000/mcp)
 */

import { parseArgs } from 'node:util';

const GOOGLE_READ_URL = process.env.GOOGLE_READ_URL || 'http://google-read-sidecar:3000/mcp';
const M365_CALENDAR_URL = process.env.M365_CALENDAR_URL || 'http://m365-calendar-sidecar:3000/mcp';

// Parse CLI args
const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    account: { type: 'string', default: 'laia' },
  },
  strict: false,
});

const DRY_RUN = values['dry-run'] ?? false;
const ACCOUNT = values.account ?? 'laia';

// ─── MCP Client Helper ─────────────────────────────────────────────

let sessionId = null;

async function mcpCall(url, method, params = {}, id = 1) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (sessionId) {
    headers['Mcp-Session-Id'] = sessionId;
  }

  const body = JSON.stringify({ jsonrpc: '2.0', method, id, params });
  const resp = await fetch(url, { method: 'POST', headers, body });

  // Capture session ID from init
  const newSessionId = resp.headers.get('mcp-session-id');
  if (newSessionId) sessionId = newSessionId;

  const text = await resp.text();
  
  // Parse SSE response
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      try {
        const data = JSON.parse(line.slice(6));
        if (data.error) {
          throw new Error(`MCP error: ${data.error.message} (code: ${data.error.code})`);
        }
        return data.result;
      } catch (e) {
        if (e.message.startsWith('MCP error')) throw e;
        // Skip parse errors for non-JSON lines
      }
    }
  }
  
  throw new Error(`No valid MCP response from ${url}`);
}

async function mcpInit(url) {
  sessionId = null;
  await mcpCall(url, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'migrate-script', version: '1.0' },
  });
}

async function mcpTool(url, toolName, args = {}, id = 1) {
  return mcpCall(url, 'tools/call', { name: toolName, arguments: args }, id);
}

// ─── Google Calendar ────────────────────────────────────────────────

async function googleListCalendars() {
  await mcpInit(GOOGLE_READ_URL);
  const result = await mcpTool(GOOGLE_READ_URL, 'google-read__calendar_list_events', {
    account: ACCOUNT,
    time_min: '2020-01-01T00:00:00Z',
    time_max: '2030-12-31T23:59:59Z',
    max_results: 1,
  });
  // We just need to know calendars exist; the real listing comes next
  return result;
}

async function googleListEvents(account, timeMin, timeMax, pageToken = null) {
  const args = {
    account,
    time_min: timeMin,
    time_max: timeMax,
    max_results: 250,
  };
  if (pageToken) args.page_token = pageToken;
  
  return mcpTool(GOOGLE_READ_URL, 'google-read__calendar_list_events', args);
}

// ─── Microsoft 365 Calendar ────────────────────────────────────────

async function m365ListCalendars() {
  await mcpInit(M365_CALENDAR_URL);
  const result = await mcpTool(M365_CALENDAR_URL, 'calendar_list_calendars', {});
  return parseToolText(result);
}

async function m365CreateEvent(event, calendarId = null) {
  const args = {
    subject: event.summary || '(No title)',
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
    body: event.description || '',
    location: event.location?.displayName || event.location || '',
    is_all_day: !!event.start?.date,
  };
  
  if (calendarId) {
    args.calendar_id = calendarId;
  }
  
  // Add attendees if present
  if (event.attendees && event.attendees.length > 0) {
    args.attendees = event.attendees
      .filter(a => a.email)
      .map(a => ({ email: a.email, name: a.displayName || a.email }));
  }
  
  return mcpTool(M365_CALENDAR_URL, 'calendar_create_event', args);
}

// ─── Helpers ────────────────────────────────────────────────────────

function parseToolText(result) {
  if (!result?.content?.[0]?.text) return null;
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return result.content[0].text;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Main Migration ────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Google Calendar → Microsoft 365 Calendar Migration');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Account: ${ACCOUNT}`);
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`  Google: ${GOOGLE_READ_URL}`);
  console.log(`  M365:   ${M365_CALENDAR_URL}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const stats = {
    total: 0,
    created: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  // Step 1: List Google events (full history)
  console.log('📅 Step 1: Fetching events from Google Calendar...');
  
  const timeMin = '2020-01-01T00:00:00Z';
  const timeMax = '2030-12-31T23:59:59Z';
  let allEvents = [];
  let pageToken = null;
  let page = 0;

  do {
    page++;
    console.log(`  Fetching page ${page}...`);
    
    const result = await googleListEvents(ACCOUNT, timeMin, timeMax, pageToken);
    const data = parseToolText(result);
    
    if (data && Array.isArray(data.events)) {
      allEvents = allEvents.concat(data.events);
      console.log(`  Found ${data.events.length} events (total: ${allEvents.length})`);
    }
    
    pageToken = data?.next_page_token || null;
    
    // Rate limit
    if (pageToken) await sleep(500);
  } while (pageToken);

  console.log(`\n✅ Total events from Google: ${allEvents.length}\n`);

  if (allEvents.length === 0) {
    console.log('No events to migrate. Done!');
    return stats;
  }

  // Step 2: Get M365 calendars
  console.log('📋 Step 2: Listing Microsoft 365 calendars...');
  const m365Calendars = await m365ListCalendars();
  const defaultCalendar = Array.isArray(m365Calendars)
    ? m365Calendars.find(c => c.is_default) || m365Calendars[0]
    : null;
  
  if (defaultCalendar) {
    console.log(`  Using calendar: ${defaultCalendar.name} (${defaultCalendar.id})\n`);
  }

  // Step 3: Migrate events
  console.log('🔄 Step 3: Migrating events...\n');
  
  for (let i = 0; i < allEvents.length; i++) {
    const event = allEvents[i];
    stats.total++;
    
    const title = event.summary || '(No title)';
    const date = event.start?.dateTime || event.start?.date || 'unknown';
    const progress = `[${i + 1}/${allEvents.length}]`;
    
    // Skip cancelled events
    if (event.status === 'cancelled') {
      console.log(`  ${progress} ⏭️  SKIP (cancelled): ${title}`);
      stats.skipped++;
      continue;
    }

    // Skip all-day events that are multi-day (Google shows them as spanning)
    // unless they're single-day all-day events
    if (event.start?.date && event.end?.date) {
      const start = new Date(event.start.date);
      const end = new Date(event.end.date);
      const days = (end - start) / (1000 * 60 * 60 * 24);
      if (days > 1) {
        console.log(`  ${progress} ⏭️  SKIP (multi-day ${days}d): ${title}`);
        stats.skipped++;
        continue;
      }
    }

    console.log(`  ${progress} 📝 ${title} (${date})`);
    
    if (DRY_RUN) {
      console.log(`        → Would create in M365`);
      stats.created++;
      continue;
    }

    try {
      const result = await m365CreateEvent(event, defaultCalendar?.id);
      const data = parseToolText(result);
      
      if (data && !data.error) {
        console.log(`        ✅ Created`);
        stats.created++;
      } else {
        console.log(`        ❌ Failed: ${data?.error || 'unknown error'}`);
        stats.failed++;
        stats.errors.push({ title, error: data?.error || 'unknown' });
      }
    } catch (e) {
      console.log(`        ❌ Error: ${e.message}`);
      stats.failed++;
      stats.errors.push({ title, error: e.message });
    }

    // Rate limit: 100ms between creates
    if (i < allEvents.length - 1) {
      await sleep(100);
    }
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Migration Complete');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Total events:  ${stats.total}`);
  console.log(`  Created:       ${stats.created}`);
  console.log(`  Skipped:       ${stats.skipped}`);
  console.log(`  Failed:        ${stats.failed}`);
  
  if (stats.errors.length > 0) {
    console.log('\n  Errors:');
    for (const e of stats.errors) {
      console.log(`    - ${e.title}: ${e.error}`);
    }
  }
  
  console.log('═══════════════════════════════════════════════════════════');

  return stats;
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
