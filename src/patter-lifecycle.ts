/**
 * Lazy lifecycle for the embedded Patter server.
 *
 * The Patter HTTP server + cloudflared tunnel are expensive to start
 * (tunnel handshake, agent provisioning) and not every MCP session
 * actually places a call. We defer that startup to the first tool
 * invocation by default, behind a memoized promise so concurrent
 * tool calls coalesce to a single boot.
 *
 * Modes:
 *   - Default (lazy): first call to `getPatter()` boots the server.
 *   - PATTER_EAGER=1: server boots at MCP startup (legacy behaviour).
 *   - WEBHOOK_URL=https://...: production webhook, no tunnel needed.
 *   - PATTER_TUNNEL_HOSTNAME=...: named cloudflared tunnel (stable URL).
 */

import { PatterServer } from "./patter-server.js";

const PATTER_PORT = parseInt(process.env.PATTER_PORT ?? "8000", 10);

function log(msg: string): void {
  process.stderr.write(`[patter-mcp] ${msg}\n`);
}

let patterPromise: Promise<PatterServer> | null = null;
let patterInstance: PatterServer | null = null;

/**
 * Construct the PatterServer eagerly so config errors surface at MCP
 * startup, not at first tool call. The expensive `startServer()` step
 * (tunnel + agent boot) is still deferred to `getPatter()`.
 */
export function createPatter(): PatterServer {
  if (patterInstance) return patterInstance;
  patterInstance = new PatterServer();
  return patterInstance;
}

/**
 * Boot the Patter HTTP server + tunnel on first call; subsequent calls
 * return the same in-flight or settled promise.
 *
 * Errors clear the cached promise so a transient failure (e.g. tunnel
 * misconfig) doesn't permanently poison the lifecycle — the next tool
 * call retries cleanly.
 */
export function getPatter(): Promise<PatterServer> {
  if (patterPromise) return patterPromise;

  const defaultPrompt =
    "You are a helpful AI assistant accessible by phone. " +
    "You can read files, run commands, and search code when asked. " +
    "Be concise and clear — this is a phone conversation.";

  patterPromise = (async () => {
    const patter = createPatter();
    log("Booting Patter server (first tool call, lazy mode)...");
    await patter.startServer(
      process.env.AGENT_SYSTEM_PROMPT ?? defaultPrompt,
      process.env.AGENT_FIRST_MESSAGE ?? "Hello! I'm your AI assistant. How can I help?",
      process.env.AGENT_VOICE ?? "nova",
      PATTER_PORT,
    );
    return patter;
  })().catch((err) => {
    patterPromise = null;
    throw err;
  });

  return patterPromise;
}

/** True when the Patter server has been started (or is starting). */
export function isPatterBooting(): boolean {
  return patterPromise !== null;
}

/**
 * Boot Patter immediately at MCP startup when PATTER_EAGER=1.
 * Errors are logged but do not crash the MCP server — the user can
 * still inspect /health and retry by issuing a tool call.
 */
export async function maybeEagerBoot(): Promise<void> {
  if (process.env.PATTER_EAGER !== "1") return;
  log("PATTER_EAGER=1 → booting Patter server now.");
  try {
    await getPatter();
  } catch (err) {
    log(`Eager boot failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
