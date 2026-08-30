import { WebSocketServer } from 'ws';

let wss = null;

export function attachWebSocketServer(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'hello', message: 'connected to SignalForge live feed' }));
  });
  console.log('[wsHub] WebSocket server attached at /ws');
  return wss;
}

/** Broadcast a JSON-serializable event to every connected browser client. */
export function broadcast(event) {
  if (!wss) return;
  const payload = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}
