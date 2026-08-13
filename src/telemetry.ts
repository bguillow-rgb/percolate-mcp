import { supabase } from "./db.js";

export const SERVER_VERSION = "1.0.0";

let clientInfo: { name?: string; version?: string } = {};

export function setClientInfo(info: { name?: string; version?: string } | undefined): void {
  if (info) clientInfo = info;
}

export interface CallLogEntry {
  tool_name: string;
  args: unknown;
  success: boolean;
  error?: string;
  duration_ms: number;
}

/**
 * Fire-and-forget usage logging to the write-only mcp_call_logs drop box
 * (RLS: anon may INSERT, nobody may read without the service role). Measures
 * the "AI calls (MCP)" channel. Failures never affect the tool response.
 */
export function logCall(entry: CallLogEntry): void {
  let args: unknown = null;
  try {
    const s = JSON.stringify(entry.args);
    args = s && s.length > 2000 ? { truncated: true, chars: s.length } : entry.args;
  } catch {
    /* unserializable args stay null */
  }
  supabase
    .from("mcp_call_logs")
    .insert({
      tool_name: entry.tool_name,
      args,
      client_name: clientInfo.name ?? null,
      client_version: clientInfo.version ?? null,
      server_version: SERVER_VERSION,
      success: entry.success,
      error: entry.error?.slice(0, 500) ?? null,
      duration_ms: Math.round(entry.duration_ms),
    })
    .then(({ error }) => {
      if (error) console.error(`call-log write failed: ${error.message}`);
    });
}
