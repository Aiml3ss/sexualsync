// Minimal zero-dependency WebSocket server protocol (RFC 6455): the handshake
// and frame codec. Node ships a WebSocket *client* (global `WebSocket`) but no
// server, and we don't want a dependency, so this implements just the subset
// the live room needs: text messages, ping/pong, close, and fragmentation.

import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const OPCODES = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

export function acceptKey(secWebSocketKey) {
  return createHash("sha1").update(String(secWebSocketKey) + GUID).digest("base64");
}

function handshakeResponse(secWebSocketKey) {
  return [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey(secWebSocketKey)}`,
    "",
    ""
  ].join("\r\n");
}

// Encode a server -> client frame. Server frames are never masked.
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
  return Buffer.concat([header, data]);
}

// Room-protocol messages are small JSON (heartbeat/presence; the HTTP
// /broadcast seam caps events at 4 KB). 64 KB is generous headroom while
// still bounding what a client-declared frame length can make us allocate —
// without a cap, a single crafted header could OOM the Node process.
export const MAX_INBOUND_FRAME_BYTES = 64 * 1024;

// Streaming parser for incoming (client -> server, masked) frames. Feed chunks
// with push(); it invokes the handler callbacks for each complete message.
// A frame declaring a length above MAX_INBOUND_FRAME_BYTES calls
// handlers.onOversized (the connection should close 1009) and the parser goes
// dead — nothing after a protocol violation is trustworthy.
export class FrameParser {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.dead = false;
  }

  push(chunk, handlers) {
    if (this.dead) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    for (;;) {
      const frame = this._tryParse();
      if (!frame) break;
      this._dispatch(frame, handlers);
      if (this.oversized) break;
    }
    if (this.oversized) {
      this.dead = true;
      this.buf = Buffer.alloc(0);
      this.fragments = [];
      handlers.onOversized?.();
    }
  }

  _tryParse() {
    if (this.oversized) return null;
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (b.length < offset + 2) return null;
      len = b.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (b.length < offset + 8) return null;
      len = Number(b.readBigUInt64BE(offset));
      offset += 8;
    }
    if (len > MAX_INBOUND_FRAME_BYTES) {
      this.oversized = true;
      return null;
    }
    let maskKey = null;
    if (masked) {
      if (b.length < offset + 4) return null;
      maskKey = b.subarray(offset, offset + 4);
      offset += 4;
    }
    if (b.length < offset + len) return null;
    let payload = b.subarray(offset, offset + len);
    if (masked) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i += 1) out[i] = payload[i] ^ maskKey[i & 3];
      payload = out;
    } else {
      payload = Buffer.from(payload);
    }
    this.buf = b.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _dispatch(frame, handlers) {
    const { fin, opcode, payload } = frame;
    if (opcode === OPCODES.CLOSE) { handlers.onClose?.(); return; }
    if (opcode === OPCODES.PING) { handlers.onPing?.(payload); return; }
    if (opcode === OPCODES.PONG) { handlers.onPong?.(payload); return; }
    if (opcode === OPCODES.CONT) {
      // The per-frame cap alone doesn't bound a fragmented message — many
      // sub-cap continuation frames could still accumulate without limit.
      if (this._fragmentBytes() + payload.length > MAX_INBOUND_FRAME_BYTES) {
        this.oversized = true;
        return;
      }
      this.fragments.push(payload);
      if (fin) {
        const full = Buffer.concat(this.fragments);
        const op = this.fragmentOpcode;
        this.fragments = [];
        this.fragmentOpcode = null;
        if (op === OPCODES.TEXT) handlers.onMessage?.(full.toString("utf8"));
      }
      return;
    }
    // TEXT / BINARY
    if (!fin) {
      this.fragments = [payload];
      this.fragmentOpcode = opcode;
      return;
    }
    if (opcode === OPCODES.TEXT) handlers.onMessage?.(payload.toString("utf8"));
    // Binary frames are unused by the room protocol and ignored.
  }

  _fragmentBytes() {
    let total = 0;
    for (const fragment of this.fragments) total += fragment.length;
    return total;
  }
}

// Wraps a raw net.Socket as a small WebSocket connection: send(text),
// close(code), and on("message"|"close", fn).
export class WsConnection {
  constructor(socket) {
    this.socket = socket;
    this.closed = false;
    this.parser = new FrameParser();
    this._listeners = { message: [], close: [] };

    const handlers = {
      onMessage: (m) => this._emit("message", m),
      onClose: () => this.close(1000),
      onPing: (p) => this._write(encodeFrame(OPCODES.PONG, p)),
      onPong: () => {},
      // 1009 = "message too big". The parser is dead at this point; drop the
      // connection rather than trusting anything after a protocol violation.
      onOversized: () => this.close(1009)
    };
    this._handlers = handlers;
    socket.on("data", (chunk) => this.parser.push(chunk, handlers));
    const onGone = () => this._finish();
    socket.on("close", onGone);
    socket.on("error", onGone);
    socket.on("end", onGone);
  }

  on(event, fn) {
    (this._listeners[event] ||= []).push(fn);
    return this;
  }

  _emit(event, arg) {
    for (const fn of this._listeners[event] || []) {
      try { fn(arg); } catch { /* listener errors must not break the socket loop */ }
    }
  }

  _write(buf) {
    if (this.closed) return;
    try { this.socket.write(buf); } catch { /* peer gone */ }
  }

  send(text) {
    this._write(encodeFrame(OPCODES.TEXT, Buffer.from(String(text), "utf8")));
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    this._emit("close");
  }

  close(code = 1000) {
    if (this.closed) {
      try { this.socket.end(); } catch { /* already gone */ }
      return;
    }
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this._write(encodeFrame(OPCODES.CLOSE, payload));
    this.closed = true;
    try { this.socket.end(); } catch { /* already gone */ }
    this._emit("close");
  }
}

// Perform the upgrade on a raw Node socket and return a WsConnection.
export function attachWebSocket(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    try { socket.destroy(); } catch { /* ignore */ }
    return null;
  }
  try {
    socket.setNoDelay(true);
    socket.setTimeout(0);
  } catch { /* ignore */ }
  socket.write(handshakeResponse(key));
  const conn = new WsConnection(socket);
  if (head && head.length) {
    conn.parser.push(head, conn._handlers);
  }
  return conn;
}
