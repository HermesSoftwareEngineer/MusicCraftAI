// Daemon local: visualizador (HTTP + WebSocket) e endpoint MCP Streamable HTTP em /mcp.
// Um único processo => Claude, GPT e o navegador enxergam a mesma partitura.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { workspace, ROOT, blankScore } from './store.ts';
import { toMEI, measureXmlId } from './mei.ts';
import type { NoteMeta } from './mei.ts';
import { renderLive, pagedSvgs } from './render.ts';
import { svgPagesToPdf } from './pdf.ts';
import { staffCount } from './model.ts';
import type { Doc } from './store.ts';
import { openInSibelius } from './sibelius.ts';
import { registerTools, INSTRUCTIONS } from './tools.ts';

const PORT = Number(process.env.PARTITURA_PORT ?? 4700);
const HOST = process.env.PARTITURA_HOST ?? '127.0.0.1';
const TOKEN = process.env.PARTITURA_TOKEN; // exigido em /mcp se definido (útil ao expor por túnel)
const EXTRA_HOSTS = (process.env.PARTITURA_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const VIEWER_URL = `http://localhost:${PORT}/`;
const BUILD = Date.now(); // a página recarrega se o servidor reiniciar

// ---------------- render + broadcast ----------------

const clients = new Set<WebSocket>();
const pagedClients = new Set<WebSocket>(); // navegadores no modo "páginas"
let lastMsg: Record<string, unknown> | null = null;
let pagesCache = { key: '', html: '' };

function pagesOf(d: Doc): string[] {
  return d.kind === 'score' ? pagedSvgs(toMEI(d.score), staffCount(d.score)) : pagedSvgs(d.raw, 4);
}

function pagesHtmlFor(d: Doc): string {
  const key = `${d.name}@${d.version}`;
  if (pagesCache.key !== key) pagesCache = { key, html: pagesOf(d).map((p) => `<div class="page">${p}</div>`).join('') };
  return pagesCache.html;
}

/** Envia a última renderização a um navegador, no modo (contínuo/páginas) que ele escolheu. */
function sendScore(c: WebSocket, resend = false) {
  if (!lastMsg || c.readyState !== WebSocket.OPEN) return;
  let msg = resend ? { ...lastMsg, changed: [] } : lastMsg;
  const d = workspace.currentOrNull;
  if (lastMsg.type === 'score' && pagedClients.has(c) && d && d.name === lastMsg.doc) {
    try { msg = { ...msg, svg: pagesHtmlFor(d), paged: true }; } catch { /* cai para o contínuo */ }
  }
  c.send(JSON.stringify(msg));
}
let pending: ReturnType<typeof setTimeout> | null = null;
let changedIds = new Set<string>();
let lastLabel = '';

function broadcast(msg: string) {
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}

function workspaceMsg() {
  return JSON.stringify({
    type: 'workspace', build: BUILD, active: workspace.active,
    files: workspace.listFiles(),
    trash: workspace.listTrash().slice(0, 30),
    tabs: [...workspace.docs.values()].map((d) => ({ name: d.name, title: d.title, kind: d.kind })),
  });
}

function renderActive() {
  pending = null;
  const d = workspace.currentOrNull;
  if (!d) {
    lastMsg = { type: 'empty', build: BUILD };
    for (const c of clients) sendScore(c);
    return;
  }
  let msg: Record<string, unknown>;
  try {
    const meta = new Map<string, NoteMeta>();
    const r = d.kind === 'score' ? renderLive(toMEI(d.score, meta), meta) : renderLive(d.raw);
    msg = {
      type: 'score', build: BUILD, doc: d.name, kind: d.kind, version: d.version, title: d.title, label: lastLabel,
      svg: r.svg, midi: r.midi, notes: r.notes, measures: r.measures, changed: [...changedIds].map(measureXmlId),
      canUndo: d.undoStack.length > 0, canRedo: d.redoStack.length > 0,
    };
  } catch (e) {
    msg = { type: 'error', doc: d.name, message: String((e as Error).message ?? e) };
  }
  changedIds = new Set();
  lastLabel = '';
  lastMsg = msg;
  for (const c of clients) sendScore(c);
}

const scheduleRender = () => { if (!pending) pending = setTimeout(renderActive, 30); };

let autoOpened = false;
workspace.on((e) => {
  if (e.type === 'workspace') {
    broadcast(workspaceMsg());
    if (!lastMsg || (lastMsg.doc ?? null) !== workspace.active) { changedIds = new Set(); scheduleRender(); }
    return;
  }
  broadcast(workspaceMsg()); // título pode ter mudado
  if (e.doc !== workspace.active) return;
  e.measures.forEach((id) => changedIds.add(id));
  lastLabel = e.label;
  scheduleRender();
  if (!clients.size && !autoOpened) openViewer(false);
});

function openViewer(force: boolean) {
  if (process.env.PARTITURA_NO_BROWSER) return;
  if (!force && (clients.size || autoOpened)) return;
  autoOpened = true;
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', VIEWER_URL]]
    : process.platform === 'darwin' ? ['open', [VIEWER_URL]] : ['xdg-open', [VIEWER_URL]];
  try {
    spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* sem navegador disponível */ }
}

// ---------------- MCP ----------------

function buildMcp() {
  const server = new McpServer({ name: 'partitura', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  registerTools(server, { viewerUrl: VIEWER_URL, openViewer: () => openViewer(true) });
  return server;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

function hostAllowed(req: http.IncomingMessage) {
  const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  return ['localhost', '127.0.0.1', '[::1]'].includes(host) || EXTRA_HOSTS.includes(host);
}

function originAllowed(req: http.IncomingMessage) {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    const h = new URL(o).hostname.toLowerCase();
    return ['localhost', '127.0.0.1', '[::1]'].includes(h) || EXTRA_HOSTS.includes(h);
  } catch { return false; }
}

const json = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (!hostAllowed(req)) return json(res, 403, { error: 'host não permitido' });

  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(readFileSync(join(ROOT, 'public', 'index.html')));
  }
  if (url.pathname === '/upload' && req.method === 'POST') {
    if (!originAllowed(req)) return json(res, 403, { error: 'origem não permitida' });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 25 * 1024 * 1024) return json(res, 413, { error: 'arquivo maior que 25 MB' });
      chunks.push(c as Buffer);
    }
    try {
      const name = workspace.upload(url.searchParams.get('name') ?? '', Buffer.concat(chunks));
      return json(res, 200, { name });
    } catch (e) {
      return json(res, 400, { error: String((e as Error).message ?? e) });
    }
  }
  if (url.pathname === '/pdf' && req.method === 'GET') {
    const d = workspace.currentOrNull;
    if (!d) return json(res, 404, { error: 'nenhum arquivo aberto' });
    try {
      const pdf = await svgPagesToPdf(pagesOf(d), d.title);
      const fname = `${d.name.replace(/\.[^.]+$/, '')}.pdf`;
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${fname.replace(/[^\w.-]/g, '_')}"` });
      return res.end(pdf);
    } catch (e) {
      return json(res, 500, { error: String((e as Error).message ?? e) });
    }
  }
  if (url.pathname === '/health') return json(res, 200, { ok: true, name: 'partitura-mcp', active: workspace.active, version: workspace.currentOrNull?.version ?? null, viewers: clients.size });

  if (url.pathname === '/mcp') {
    if (!originAllowed(req)) return json(res, 403, { error: 'origem não permitida' });
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: 'token inválido' });
    if (req.method !== 'POST') {
      return json(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Método não permitido (servidor sem sessão)' }, id: null });
    }
    const server = buildMcp();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      const body = await readBody(req);
      await server.connect(transport);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !['content-length', 'host', 'connection', 'transfer-encoding'].includes(k)) headers.set(k, v);
      const webReq = new Request(`http://localhost${req.url}`, { method: 'POST', headers, body: JSON.stringify(body ?? null) });
      const resp = await transport.handleRequest(webReq, { parsedBody: body });
      const out = Buffer.from(await resp.arrayBuffer());
      const h: Record<string, string> = {};
      resp.headers.forEach((v, k) => { if (k !== 'transfer-encoding' && k !== 'content-length') h[k] = v; });
      res.writeHead(resp.status, h).end(out);
    } catch (e) {
      if (!res.headersSent) json(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: String(e) }, id: null });
    } finally {
      void transport.close();
      void server.close();
    }
    return;
  }
  json(res, 404, { error: 'não encontrado' });
});

const wss = new WebSocketServer({ noServer: true });
httpServer.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws' || !hostAllowed(req) || !originAllowed(req)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.send(workspaceMsg());
    if (lastMsg) sendScore(ws, true); else renderActive();
    ws.on('message', (data) => {
      // ações do visualizador: abas, arquivos, desfazer/refazer
      let m: { type?: string; name?: string; title?: string; newName?: string };
      try { m = JSON.parse(String(data)); } catch { return; }
      try {
        const d = workspace.currentOrNull;
        if (m.type === 'undo' && d?.kind === 'score') d.undo();
        if (m.type === 'redo' && d?.kind === 'score') d.redo();
        if (m.type === 'open' && m.name) workspace.open(m.name, true);
        if (m.type === 'close' && m.name) workspace.close(m.name);
        if (m.type === 'open-sibelius') {
          if (!d) throw new Error('Nenhum arquivo aberto.');
          const path = openInSibelius(d);
          ws.send(JSON.stringify({ type: 'toast', message: `Abrindo no Sibelius: ${basename(path)}` }));
        }
        if (m.type === 'import' && m.name) {
          const { doc: nd, warnings } = workspace.importXml(m.name);
          ws.send(JSON.stringify({ type: 'toast', message: `Editável: ${nd.name}${warnings.length ? ` (${warnings.length} aviso(s): ${warnings[0]})` : ''}` }));
        }
        if (m.type === 'view') {
          if ((m as { pages?: boolean }).pages) pagedClients.add(ws); else pagedClients.delete(ws);
          sendScore(ws, true);
        }
        if (m.type === 'rename' && m.name && m.newName?.trim()) {
          const n = workspace.rename(m.name, m.newName.trim());
          ws.send(JSON.stringify({ type: 'toast', message: `Renomeado para ${n}` }));
        }
        if (m.type === 'delete' && m.name) {
          workspace.remove(m.name);
          ws.send(JSON.stringify({ type: 'toast', message: `"${m.name}" foi para a lixeira` }));
        }
        if (m.type === 'restore' && m.name) {
          const n = workspace.restore(m.name);
          ws.send(JSON.stringify({ type: 'toast', message: `Restaurado: ${n}` }));
        }
        if (m.type === 'new') {
          const title = (m.title ?? '').trim() || 'Sem título';
          workspace.create(title, blankScore(title));
        }
      } catch (e) {
        ws.send(JSON.stringify({ type: 'toast', message: String((e as Error).message ?? e) }));
      }
    });
    ws.on('close', () => { clients.delete(ws); pagedClients.delete(ws); });
  });
});

httpServer.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Porta ${PORT} já está em uso — o servidor provavelmente já está rodando (${VIEWER_URL}).`);
    process.exit(0);
  }
  throw e;
});

httpServer.listen(PORT, HOST, () => {
  console.error(`partitura-mcp rodando: visualizador ${VIEWER_URL}  |  MCP http://localhost:${PORT}/mcp`);
  // alguns navegadores resolvem "localhost" para ::1 — escuta também no loopback IPv6
  if (!process.env.PARTITURA_HOST) {
    const v6 = http.createServer((req, res) => httpServer.emit('request', req, res));
    v6.on('upgrade', (req, socket, head) => httpServer.emit('upgrade', req, socket, head));
    v6.on('error', () => { /* sem IPv6: ignora */ });
    v6.listen(PORT, '::1');
  }
});
