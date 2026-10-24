// Ponte stdio <-> HTTP para clientes MCP que iniciam servidores por comando (Claude Code, Claude Desktop).
// Sobe o daemon (server.ts) automaticamente se ele não estiver rodando.

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PARTITURA_PORT ?? 4700);
const BASE = `http://127.0.0.1:${PORT}`;

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(800) });
    return r.ok && (await r.json()).name === 'partitura-mcp';
  } catch { return false; }
}

async function ensureDaemon() {
  if (await healthy()) return;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'src', 'server.ts')], {
    detached: true, stdio: 'ignore', windowsHide: true, cwd: ROOT, env: process.env,
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await healthy()) return;
  }
  throw new Error(`Não consegui iniciar o servidor de partituras em ${BASE}`);
}

await ensureDaemon();

const headers: Record<string, string> = {};
if (process.env.PARTITURA_TOKEN) headers.authorization = `Bearer ${process.env.PARTITURA_TOKEN}`;

const upstream = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers } });
const local = new StdioServerTransport();

local.onmessage = async (msg: JSONRPCMessage) => {
  try {
    await upstream.send(msg);
  } catch (e) {
    // o daemon pode ter caído: tenta subir de novo e reenviar uma vez
    try {
      await ensureDaemon();
      await upstream.send(msg);
    } catch {
      if ('id' in msg && msg.id !== undefined && 'method' in msg) {
        await local.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `Servidor de partituras indisponível: ${(e as Error).message}` } });
      }
    }
  }
};
upstream.onmessage = (msg) => { void local.send(msg); };
upstream.onerror = (e) => console.error('[partitura-bridge]', e.message);
local.onclose = () => { void upstream.close(); process.exit(0); };

await upstream.start();
await local.start();
