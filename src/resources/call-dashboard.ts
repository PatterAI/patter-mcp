/**
 * Call Dashboard MCP Resources
 *
 * Registers three resources with the MCP server:
 *
 *   patter://dashboard          — Markdown summary of all calls (active + history)
 *   patter://call/{callId}      — Full detail for a single call (transcript + cost)
 *   uiResource "call-dashboard" — MCP Apps widget (rendered by Claude / ChatGPT)
 *
 * The first two are plain Markdown resources that any MCP client can read.
 * The third is a self-contained HTML+JS widget registered via server.uiResource(),
 * using the "mcpApps" type (text/html;profile=mcp-app) so it renders as an
 * interactive iframe in compatible hosts (Claude Desktop, ChatGPT).
 *
 * The widget fetches its data from the /api/dashboard and /api/call/:id HTTP
 * routes that are also registered here on server.app (Hono).
 */

import type { McpServerInstance } from "mcp-use/server";
import type { PatterServer, CallRecord } from "../patter-server.js";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Format a unix-ms timestamp as a locale date-time string (UTC). */
function formatTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

/** Format a duration in seconds as "Xm Ys". */
function formatDuration(seconds: number | undefined): string {
  if (!seconds) return "-";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Extract the total cost from a call's metrics, formatted as a dollar string. */
function formatCost(call: CallRecord): string {
  const metrics = call.metrics as Record<string, Record<string, number>> | undefined;
  const total = metrics?.cost?.total;
  return typeof total === "number" ? `$${total.toFixed(4)}` : "-";
}

/** Return the live duration label for an in-progress call. */
function liveDuration(call: CallRecord): string {
  if (call.status === "in-progress") {
    const elapsed = Math.round((Date.now() - call.startedAt) / 1000);
    return `${formatDuration(elapsed)} (live)`;
  }
  return formatDuration(call.duration);
}

// ---------------------------------------------------------------------------
// Markdown builders
// ---------------------------------------------------------------------------

function buildDashboardMarkdown(calls: ReadonlyMap<string, CallRecord>): string {
  if (calls.size === 0) {
    return (
      "# Patter Call Dashboard\n\n" +
      "_No calls recorded yet. Use `make_call` to start a call._"
    );
  }

  const active: CallRecord[] = [];
  const history: CallRecord[] = [];

  for (const [, call] of calls) {
    if (call.status === "ringing" || call.status === "in-progress") {
      active.push(call);
    } else {
      history.push(call);
    }
  }

  // Sort history by most-recent first
  history.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));

  const lines: string[] = ["# Patter Call Dashboard", ""];

  // ── Active Calls ──────────────────────────────────────────────────────────
  if (active.length > 0) {
    lines.push(`## Active Calls (${active.length})`, "");
    lines.push("| Call ID | Direction | Number | Status | Duration |");
    lines.push("| ------- | --------- | ------ | ------ | -------- |");
    for (const call of active) {
      const number =
        call.direction === "outbound"
          ? (call.to ?? "-")
          : (call.from ?? "-");
      lines.push(
        `| \`${call.callId}\` | ${call.direction} | ${number} | **${call.status}** | ${liveDuration(call)} |`,
      );
    }
    lines.push("");
  } else {
    lines.push("## Active Calls", "", "_None_", "");
  }

  // ── Call History ──────────────────────────────────────────────────────────
  lines.push(`## Call History (${history.length})`, "");

  if (history.length === 0) {
    lines.push("_No completed calls yet._");
  } else {
    lines.push(
      "| Call ID | Dir | Number | Status | Duration | Cost | Turns | Started |",
      "| ------- | --- | ------ | ------ | -------- | ---- | ----- | ------- |",
    );
    for (const call of history) {
      const number =
        call.direction === "outbound"
          ? (call.to ?? "-")
          : (call.from ?? "-");
      const dir = call.direction === "outbound" ? "OUT" : "IN";
      lines.push(
        `| \`${call.callId}\` | ${dir} | ${number} | ${call.status} | ${formatDuration(call.duration)} | ${formatCost(call)} | ${call.transcript.length} | ${formatTime(call.startedAt)} |`,
      );
    }
  }

  // ── Cost Summary ──────────────────────────────────────────────────────────
  const completedWithCost = history.filter((c) => {
    const m = c.metrics as Record<string, Record<string, number>> | undefined;
    return typeof m?.cost?.total === "number";
  });

  if (completedWithCost.length > 0) {
    let totalStt = 0;
    let totalTts = 0;
    let totalLlm = 0;
    let totalTelephony = 0;

    for (const call of completedWithCost) {
      const cost = (call.metrics as Record<string, Record<string, number>>).cost;
      totalStt += cost.stt ?? 0;
      totalTts += cost.tts ?? 0;
      totalLlm += cost.llm ?? 0;
      totalTelephony += cost.telephony ?? 0;
    }

    const grandTotal = totalStt + totalTts + totalLlm + totalTelephony;

    lines.push(
      "",
      "## Cost Summary",
      "",
      `| Component | Total |`,
      `| --------- | ----- |`,
      `| STT (Speech-to-Text) | $${totalStt.toFixed(4)} |`,
      `| TTS (Text-to-Speech) | $${totalTts.toFixed(4)} |`,
      `| LLM | $${totalLlm.toFixed(4)} |`,
      `| Telephony | $${totalTelephony.toFixed(4)} |`,
      `| **Grand Total** | **$${grandTotal.toFixed(4)}** |`,
    );
  }

  lines.push("", `_Use \`get_transcript\` with a call ID to view the full conversation._`);

  return lines.join("\n");
}

function buildCallDetailMarkdown(call: CallRecord): string {
  const number =
    call.direction === "outbound"
      ? `**To:** ${call.to ?? "-"}`
      : `**From:** ${call.from ?? "-"}`;

  const metrics = call.metrics as Record<string, Record<string, number>> | undefined;

  const lines: string[] = [
    `# Call Detail: \`${call.callId}\``,
    "",
    `| Field | Value |`,
    `| ----- | ----- |`,
    `| Direction | ${call.direction} |`,
    `| ${number.split("**")[1].replace(":", "")} | ${number.split(" ").slice(-1)[0]} |`,
    `| Status | **${call.status}** |`,
    `| Started | ${formatTime(call.startedAt)} |`,
    call.endedAt ? `| Ended | ${formatTime(call.endedAt)} |` : "",
    `| Duration | ${liveDuration(call)} |`,
    `| Turns | ${call.transcript.length} |`,
    "",
  ];

  // Cost breakdown
  if (metrics?.cost) {
    const cost = metrics.cost;
    lines.push(
      "## Cost Breakdown",
      "",
      "| Component | Cost |",
      "| --------- | ---- |",
      `| STT (Speech-to-Text) | $${(cost.stt ?? 0).toFixed(4)} |`,
      `| TTS (Text-to-Speech) | $${(cost.tts ?? 0).toFixed(4)} |`,
      `| LLM | $${(cost.llm ?? 0).toFixed(4)} |`,
      `| Telephony | $${(cost.telephony ?? 0).toFixed(4)} |`,
      `| **Total** | **$${(cost.total ?? 0).toFixed(4)}** |`,
      "",
    );
  }

  // Transcript
  if (call.transcript.length > 0) {
    lines.push("## Transcript", "");
    for (const turn of call.transcript) {
      const speaker = turn.role === "assistant" ? "🤖 **Agent**" : "👤 **User**";
      lines.push(`${speaker}: ${turn.text}`, "");
    }
  } else if (call.status === "in-progress") {
    lines.push("## Transcript", "", "_Call is in progress. Transcript will be available after the call ends._");
  } else {
    lines.push("## Transcript", "", "_No transcript recorded._");
  }

  return lines.filter((l) => l !== "").join("\n");
}

// ---------------------------------------------------------------------------
// HTML template for the MCP Apps widget
// ---------------------------------------------------------------------------

/**
 * Build a self-contained HTML template for the call dashboard widget.
 *
 * The template fetches JSON from the /api/dashboard endpoint (served by Hono)
 * and renders the dashboard using vanilla JS + inline CSS.
 * It auto-refreshes every 5 seconds to show live call status changes.
 */
function buildWidgetHtml(serverBaseUrl: string): string {
  const apiUrl = `${serverBaseUrl}/api/dashboard`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Patter Call Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      background: #f8f9fa;
      color: #1a1a1a;
      padding: 16px;
    }
    h1 { font-size: 16px; font-weight: 700; margin-bottom: 12px; color: #0f172a; }
    h2 { font-size: 13px; font-weight: 600; margin: 16px 0 8px; color: #374151; text-transform: uppercase; letter-spacing: 0.05em; }
    .badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 600;
    }
    .badge-active { background: #dcfce7; color: #166534; }
    .badge-completed { background: #f1f5f9; color: #475569; }
    .badge-failed { background: #fee2e2; color: #991b1b; }
    .badge-ringing { background: #fef9c3; color: #854d0e; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
    th { text-align: left; font-size: 11px; font-weight: 600; color: #6b7280; padding: 4px 8px; border-bottom: 1px solid #e5e7eb; }
    td { padding: 6px 8px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
    tr:hover td { background: #f9fafb; }
    .call-id { font-family: monospace; font-size: 11px; color: #6366f1; }
    .empty { color: #9ca3af; font-style: italic; padding: 8px 0; }
    .cost-table td:last-child { font-weight: 600; }
    .cost-total td { font-weight: 700; border-top: 2px solid #e5e7eb; }
    .refresh { font-size: 11px; color: #9ca3af; margin-top: 12px; }
    .error { color: #ef4444; padding: 8px; }
    .dir-out { color: #7c3aed; }
    .dir-in  { color: #0891b2; }
  </style>
</head>
<body>
  <h1>Patter Call Dashboard</h1>
  <div id="root"><p class="empty">Loading…</p></div>
  <p class="refresh" id="refreshLabel"></p>

  <script>
    const API = ${JSON.stringify(apiUrl)};
    let lastFetch = null;

    function badge(status) {
      const cls = status === 'in-progress' ? 'badge-active'
                : status === 'ringing'     ? 'badge-ringing'
                : status === 'failed'      ? 'badge-failed'
                : 'badge-completed';
      return '<span class="badge ' + cls + '">' + status + '</span>';
    }

    function escHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function render(data) {
      const active = data.filter(c => c.status === 'ringing' || c.status === 'in-progress');
      const history = data
        .filter(c => c.status !== 'ringing' && c.status !== 'in-progress')
        .sort((a, b) => (b.endedAt || b.startedAt) - (a.endedAt || a.startedAt));

      let html = '';

      // Active calls
      html += '<h2>Active Calls (' + active.length + ')</h2>';
      if (active.length === 0) {
        html += '<p class="empty">No active calls</p>';
      } else {
        html += '<table><thead><tr><th>Call ID</th><th>Dir</th><th>Number</th><th>Status</th><th>Duration</th></tr></thead><tbody>';
        for (const c of active) {
          const elapsed = Math.round((Date.now() - c.startedAt) / 1000);
          const dur = elapsed >= 60
            ? Math.floor(elapsed / 60) + 'm ' + (elapsed % 60) + 's (live)'
            : elapsed + 's (live)';
          const dir = c.direction === 'outbound' ? 'OUT' : 'IN';
          const num = c.direction === 'outbound' ? (c.to || '-') : (c.from || '-');
          html += '<tr>';
          html += '<td class="call-id">' + escHtml(c.callId.slice(0, 20)) + '</td>';
          html += '<td class="dir-' + (c.direction === 'outbound' ? 'out' : 'in') + '">' + dir + '</td>';
          html += '<td>' + escHtml(num) + '</td>';
          html += '<td>' + badge(c.status) + '</td>';
          html += '<td>' + dur + '</td>';
          html += '</tr>';
        }
        html += '</tbody></table>';
      }

      // History
      html += '<h2>History (' + history.length + ')</h2>';
      if (history.length === 0) {
        html += '<p class="empty">No completed calls</p>';
      } else {
        html += '<table><thead><tr><th>Call ID</th><th>Dir</th><th>Number</th><th>Status</th><th>Duration</th><th>Cost</th><th>Turns</th></tr></thead><tbody>';
        for (const c of history) {
          const dur = c.duration
            ? (c.duration >= 60 ? Math.floor(c.duration/60) + 'm ' + (c.duration%60) + 's' : c.duration + 's')
            : '-';
          const cost = c.metrics && c.metrics.cost ? '$' + c.metrics.cost.total.toFixed(4) : '-';
          const dir = c.direction === 'outbound' ? 'OUT' : 'IN';
          const num = c.direction === 'outbound' ? (c.to || '-') : (c.from || '-');
          html += '<tr>';
          html += '<td class="call-id">' + escHtml(c.callId.slice(0, 20)) + '</td>';
          html += '<td class="dir-' + (c.direction === 'outbound' ? 'out' : 'in') + '">' + dir + '</td>';
          html += '<td>' + escHtml(num) + '</td>';
          html += '<td>' + badge(c.status) + '</td>';
          html += '<td>' + dur + '</td>';
          html += '<td>' + cost + '</td>';
          html += '<td>' + c.transcript.length + '</td>';
          html += '</tr>';
        }
        html += '</tbody></table>';
      }

      // Cost summary
      const withCost = history.filter(c => c.metrics && c.metrics.cost && typeof c.metrics.cost.total === 'number');
      if (withCost.length > 0) {
        let stt = 0, tts = 0, llm = 0, tel = 0;
        for (const c of withCost) {
          stt += c.metrics.cost.stt || 0;
          tts += c.metrics.cost.tts || 0;
          llm += c.metrics.cost.llm || 0;
          tel += c.metrics.cost.telephony || 0;
        }
        const grand = stt + tts + llm + tel;
        html += '<h2>Cost Summary</h2>';
        html += '<table class="cost-table"><tbody>';
        html += '<tr><td>STT (Speech-to-Text)</td><td>$' + stt.toFixed(4) + '</td></tr>';
        html += '<tr><td>TTS (Text-to-Speech)</td><td>$' + tts.toFixed(4) + '</td></tr>';
        html += '<tr><td>LLM</td><td>$' + llm.toFixed(4) + '</td></tr>';
        html += '<tr><td>Telephony</td><td>$' + tel.toFixed(4) + '</td></tr>';
        html += '<tr class="cost-total"><td>Total</td><td>$' + grand.toFixed(4) + '</td></tr>';
        html += '</tbody></table>';
      }

      document.getElementById('root').innerHTML = html;
      lastFetch = new Date();
      document.getElementById('refreshLabel').textContent =
        'Last updated: ' + lastFetch.toLocaleTimeString() + ' · auto-refreshes every 5s';
    }

    function renderError(msg) {
      document.getElementById('root').innerHTML =
        '<p class="error">Error: ' + escHtml(msg) + '</p>';
    }

    async function fetchAndRender() {
      try {
        const res = await fetch(API);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        render(data);
      } catch (err) {
        renderError(err.message);
      }
    }

    fetchAndRender();
    setInterval(fetchAndRender, 5000);
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Registration function
// ---------------------------------------------------------------------------

/**
 * Register the call dashboard resources and the MCP Apps UI widget.
 *
 * Call this once after the MCPServer is constructed, passing both the server
 * instance and the shared PatterServer so resources can read live call data.
 */
export function registerCallDashboard(
  server: McpServerInstance,
  patter: PatterServer,
): void {
  // -- 1. Dashboard summary resource (Markdown) ------------------------------
  server.resource(
    {
      name: "call-dashboard",
      uri: "patter://dashboard",
      title: "Call Dashboard",
      description:
        "Live summary of all calls: active calls with live status, " +
        "call history with duration and cost, and an aggregate cost breakdown.",
      mimeType: "text/markdown",
    },
    async (_ctx) => {
      const calls = patter.getCallsForUser(undefined);
      const md = buildDashboardMarkdown(calls);
      return {
        contents: [{ uri: "patter://dashboard", mimeType: "text/markdown", text: md }],
      };
    },
  );

  // -- 2. Individual call detail resource template (Markdown) ----------------
  server.resourceTemplate(
    {
      name: "call-detail",
      uriTemplate: "patter://call/{callId}",
      title: "Call Detail",
      description:
        "Full detail for a specific call: status, duration, cost breakdown " +
        "per component (STT / TTS / LLM / telephony), and the complete transcript.",
      mimeType: "text/markdown",
    },
    async (uri: URL, params: Record<string, string>) => {
      const callId = params.callId ?? "";
      const call = patter.getCallForUser(callId, undefined);

      if (!call) {
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: "text/markdown",
              text: `# Call Not Found\n\nNo call with ID \`${callId}\` exists.`,
            },
          ],
        };
      }

      const md = buildCallDetailMarkdown(call);
      return {
        contents: [{ uri: uri.toString(), mimeType: "text/markdown", text: md }],
      };
    },
  );

  // -- 3. JSON API endpoint for the HTML widget ------------------------------
  // The MCP Apps widget fetches from /api/dashboard to get live data.
  // We expose call records as a sanitised JSON array (no PII beyond what's
  // already in get_calls, and only for the server operator).
  server.app.get("/api/dashboard", (c) => {
    const calls = patter.getCallsForUser(undefined);
    const payload = Array.from(calls.values()).map((call) => {
      const metrics = call.metrics as Record<string, Record<string, number>> | undefined;
      return {
        callId: call.callId,
        direction: call.direction,
        to: call.to,
        from: call.from,
        status: call.status,
        startedAt: call.startedAt,
        endedAt: call.endedAt,
        duration: call.duration,
        transcript: call.transcript,
        metrics: metrics
          ? { cost: metrics.cost ?? null }
          : null,
      };
    });
    return c.json(payload);
  });

  // -- 4. MCP Apps UI widget -------------------------------------------------
  // serverBaseUrl is set after listen(); default to localhost:3000 when not yet known.
  const baseUrl = server.serverBaseUrl ?? `http://${server.serverHost ?? "localhost"}:${server.serverPort ?? 3000}`;

  server.uiResource({
    type: "mcpApps",
    name: "call-dashboard-widget",
    title: "Call Dashboard",
    description:
      "Interactive call dashboard showing active calls with live status, " +
      "call history with duration and cost per call, and an aggregate cost summary. " +
      "Auto-refreshes every 5 seconds.",
    htmlTemplate: buildWidgetHtml(baseUrl),
    exposeAsTool: false,
    metadata: {
      prefersBorder: true,
      description: "Live call dashboard with auto-refresh",
    },
  });
}
