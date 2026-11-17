import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errText } from '../util.js';
import type { Hub } from './hub.js';
import { TOOL_DEFS } from './tools.js';

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 5_000_000) {
        reject(new Error('Anfrage zu groß'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        reject(new Error('Ungültiges JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Lokaler Server nur auf 127.0.0.1. Jede Sitzung hat einen eigenen Zugangsschlüssel.
 * - GET  /tools            Werkzeugliste (für den MCP-Server)
 * - POST /tool             Werkzeug aufrufen
 * - POST /hook/<schlüssel>/<ereignis>   Hook aus Claude Code
 */
export async function startServer(hub: Hub): Promise<{ url: string; close: () => Promise<void> }> {
  let port = 0;
  const server = createServer((req, res) => {
    void (async () => {
      try {
        // Nur Programme auf diesem Rechner, keine Webseiten: Host muss 127.0.0.1:<port> sein
        // (schützt vor DNS-Rebinding), und Browser-Anfragen (mit Origin) werden abgewiesen.
        const host = String(req.headers.host ?? '');
        if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: 'Falscher Host' });
        if (req.headers.origin) return send(res, 403, { error: 'Keine Anfragen aus dem Browser' });
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const parts = url.pathname.split('/').filter(Boolean);
        const isHook = parts[0] === 'hook';
        const token = isHook ? (parts[1] ?? '') : String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        const agent = token ? hub.agentByToken(token) : undefined;
        if (!agent) return send(res, 401, { error: 'Unbekannter Zugangsschlüssel' });

        if (req.method === 'GET' && url.pathname === '/tools') {
          return send(res, 200, { agent: agent.name, tools: TOOL_DEFS });
        }
        if (req.method !== 'POST') return send(res, 404, { error: 'Nicht gefunden' });
        const body = await readBody(req);
        if (url.pathname === '/tool') {
          const r = await hub.callTool(agent.name, String(body.name ?? ''), (body.args ?? {}) as Record<string, unknown>);
          return send(res, 200, r);
        }
        if (isHook) {
          const event = parts[2] ?? String(body.hook_event_name ?? '');
          const out = (await agent.adapter?.onHook?.(event, body)) ?? null;
          return out ? send(res, 200, out) : send(res, 200);
        }
        return send(res, 404, { error: 'Nicht gefunden' });
      } catch (e) {
        send(res, 500, { error: errText(e) });
      }
    })();
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  hub.url = url;
  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
