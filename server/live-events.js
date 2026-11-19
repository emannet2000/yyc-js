// Server-sent change signal. After any successful write the server tells every
// open browser that something changed; each browser then reloads its own view
// through the normal access-filtered state request. Events carry no delivery
// data, so nothing here can expose information to the wrong account.
export function createLiveEvents({ maxClients = 500, heartbeatMs = 25000 } = {}) {
  const clients = new Set();
  return {
    subscribe(req, res) {
      // Transports that cannot stream answer 501; the browser then polls instead.
      if (typeof res.write !== 'function') {
        res.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({ error: 'Live updates are not available on this connection.' }),
        );
        return true;
      }
      if (clients.size >= maxClients) return false;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      const client = { res };
      clients.add(client);
      const heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
      heartbeat.unref?.();
      req.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(client);
      });
      return true;
    },
    publish() {
      for (const { res } of clients) res.write('event: changed\ndata: {}\n\n');
    },
    count: () => clients.size,
    closeAll() {
      for (const { res } of clients) res.end();
      clients.clear();
    },
  };
}
