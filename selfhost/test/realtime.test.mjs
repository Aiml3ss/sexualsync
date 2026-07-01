// Deterministic unit tests for the self-host realtime engine: the zero-dep
// WebSocket frame codec and the in-process room registry. No network.
//
// Run with: npm run selfhost:test

import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, FrameParser, OPCODES, acceptKey } from "../lib/ws-protocol.mjs";
import { RoomRegistry, createRoomsNamespace } from "../lib/ws-room.mjs";

// Build a masked client->server frame the way a browser does.
function clientFrame(opcode, text, fin = true) {
  const payload = Buffer.from(text, "utf8");
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i & 3];
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  header[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  return Buffer.concat([header, mask, masked]);
}

test("acceptKey matches the RFC 6455 example vector", () => {
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("FrameParser decodes a masked client text frame", () => {
  const parser = new FrameParser();
  let got = null;
  parser.push(clientFrame(OPCODES.TEXT, "hello room"), { onMessage: (m) => { got = m; } });
  assert.equal(got, "hello room");
});

test("encodeFrame round-trips back through the parser (server frame unmasked)", () => {
  const parser = new FrameParser();
  let got = null;
  parser.push(encodeFrame(OPCODES.TEXT, Buffer.from("server says hi")), { onMessage: (m) => { got = m; } });
  assert.equal(got, "server says hi");
});

test("FrameParser handles a frame split across TCP chunks", () => {
  const frame = clientFrame(OPCODES.TEXT, "split me up across tcp chunks");
  const parser = new FrameParser();
  let got = null;
  parser.push(frame.subarray(0, 3), { onMessage: (m) => { got = m; } });
  assert.equal(got, null);
  parser.push(frame.subarray(3), { onMessage: (m) => { got = m; } });
  assert.equal(got, "split me up across tcp chunks");
});

test("FrameParser reassembles fragmented messages", () => {
  const parser = new FrameParser();
  let got = null;
  const handlers = { onMessage: (m) => { got = m; } };
  parser.push(clientFrame(OPCODES.TEXT, "foo", false), handlers);
  parser.push(clientFrame(OPCODES.CONT, "bar", true), handlers);
  assert.equal(got, "foobar");
});

test("FrameParser handles a 16-bit length payload", () => {
  const big = "x".repeat(1000);
  const parser = new FrameParser();
  let got = null;
  parser.push(clientFrame(OPCODES.TEXT, big), { onMessage: (m) => { got = m; } });
  assert.equal(got, big);
});

// FakeWs mirrors the WsConnection surface the registry depends on.
class FakeWs {
  constructor() { this.sent = []; this._l = { message: [], close: [] }; }
  on(event, fn) { (this._l[event] ||= []).push(fn); return this; }
  emit(event, arg) { for (const fn of this._l[event] || []) fn(arg); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.emit("close"); }
}
const connState = (email, name, seq = 0) => ({ workspaceId: "ws1", actorEmail: email, actorName: name, lastEventSeq: seq });

test("registry: hello on connect, presence fan-out, broadcast, and replay", () => {
  const reg = new RoomRegistry();

  const a = new FakeWs();
  reg.connect("ws1", a, connState("a@x.test", "A"));
  assert.equal(a.sent[0].type, "room.hello");
  assert.equal(a.sent[0].latestSeq, 0);

  const b = new FakeWs();
  reg.connect("ws1", b, connState("b@x.test", "B"));
  assert.ok(a.sent.some((m) => m.type === "room.presence" && m.status === "online" && m.actorEmail === "b@x.test"));
  assert.equal(b.sent[0].type, "room.hello");

  const result = reg.broadcastEvent("ws1", { resource: "request", action: "created", actorEmail: "a@x.test" });
  assert.equal(result.ok, true);
  assert.equal(result.seq, 1);
  assert.equal(result.delivered, 2);
  assert.ok(a.sent.some((m) => m.type === "room.event" && m.seq === 1));
  assert.ok(b.sent.some((m) => m.type === "room.event" && m.seq === 1));

  const after = reg.eventsAfter("ws1", 0);
  assert.equal(after.latestSeq, 1);
  assert.equal(after.events.length, 1);

  // A late joiner with lastEventSeq=0 gets the missed event replayed after hello.
  const c = new FakeWs();
  reg.connect("ws1", c, connState("c@x.test", "C", 0));
  assert.equal(c.sent[0].type, "room.hello");
  assert.ok(c.sent.some((m) => m.type === "room.event" && m.seq === 1));

  a.close();
  assert.ok(b.sent.some((m) => m.type === "room.presence" && m.status === "offline" && m.actorEmail === "a@x.test"));
});

test("registry: presence dedups across one actor's multiple sockets (DO parity, rule #4)", () => {
  const reg = new RoomRegistry();
  const b = new FakeWs();
  reg.connect("ws1", b, connState("b@x.test", "B"));

  const onlineForA = () => b.sent.filter((m) => m.type === "room.presence" && m.status === "online" && m.actorEmail === "a@x.test").length;
  const offlineForA = () => b.sent.filter((m) => m.type === "room.presence" && m.status === "offline" && m.actorEmail === "a@x.test").length;

  const a1 = new FakeWs();
  reg.connect("ws1", a1, connState("a@x.test", "A"));
  assert.equal(onlineForA(), 1, "A's first socket announces online once");

  // A second tab / reconnect flap for the SAME actor must not re-announce online.
  const a2 = new FakeWs();
  reg.connect("ws1", a2, connState("a@x.test", "A"));
  assert.equal(onlineForA(), 1, "a second socket for the same actor must NOT re-announce online");

  // Closing one of A's two sockets must not announce offline — A is still here.
  a1.close();
  assert.equal(offlineForA(), 0, "closing one of A's two sockets must NOT announce offline");

  // Closing A's last socket announces offline exactly once.
  a2.close();
  assert.equal(offlineForA(), 1, "closing A's last socket announces offline exactly once");
});

test("registry: heartbeat gets a pong; presence rebroadcasts to others", () => {
  const reg = new RoomRegistry();
  const a = new FakeWs();
  const b = new FakeWs();
  reg.connect("ws1", a, connState("a@x.test", "A"));
  reg.connect("ws1", b, connState("b@x.test", "B"));

  a.emit("message", JSON.stringify({ type: "heartbeat" }));
  assert.ok(a.sent.some((m) => m.type === "room.pong"));

  const before = b.sent.length;
  a.emit("message", JSON.stringify({ type: "presence" }));
  assert.ok(b.sent.slice(before).some((m) => m.type === "room.presence" && m.status === "active" && m.actorEmail === "a@x.test"));
});

test("registry: keep-first dedupe does not advance the sequence", () => {
  const reg = new RoomRegistry();
  const a = new FakeWs();
  reg.connect("ws1", a, connState("a@x.test", "A"));
  const first = reg.broadcastEvent("ws1", { resource: "focus", action: "focused", id: "dup-1", dedupe: "keep-first" });
  const second = reg.broadcastEvent("ws1", { resource: "focus", action: "focused", id: "dup-1", dedupe: "keep-first" });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 1);
  assert.equal(reg.eventsAfter("ws1", 0).events.length, 1);
});

test("registry: events missing resource/action are rejected", () => {
  const reg = new RoomRegistry();
  const result = reg.broadcastEvent("ws1", { actorEmail: "a@x.test" });
  assert.equal(result.ok, false);
});

test("createRoomsNamespace exposes /broadcast and /events over fetch (env.ROOMS shim)", async () => {
  const reg = new RoomRegistry();
  const ns = createRoomsNamespace(reg);
  const stub = ns.get(ns.idFromName("workspace:ws1"));

  const broadcast = await stub.fetch("https://room.internal/broadcast", {
    method: "POST",
    body: JSON.stringify({ resource: "shelf", action: "added" })
  });
  assert.equal(broadcast.status, 202);

  const events = await stub.fetch("https://room.internal/events?after=0");
  const body = await events.json();
  assert.equal(body.latestSeq, 1);
  assert.equal(body.events.length, 1);
});

test("createRoomsNamespace.fetch accepts a Request object (broadcastRoomEvent / DO convention)", async () => {
  // Production calls stub.fetch(new Request(url, init)) — NOT (urlString, init).
  // broadcastRoomEvent uses that path; the string-only test above never exercised
  // it, so a Request that throws inside `new URL(...)` was swallowed and every
  // HTTP-triggered room event was silently dropped on self-host. Guard it.
  const reg = new RoomRegistry();
  const ns = createRoomsNamespace(reg);
  const stub = ns.get(ns.idFromName("workspace:ws1"));

  const broadcast = await stub.fetch(new Request("https://room.internal/broadcast", {
    method: "POST",
    body: JSON.stringify({ resource: "fantasy-backlog", action: "created", entityId: "k1" })
  }));
  assert.equal(broadcast.status, 202, "a Request-based broadcast must be accepted");
  const result = await broadcast.json();
  assert.equal(result.ok, true);
  assert.equal(result.seq, 1);

  const events = await stub.fetch(new Request("https://room.internal/events?after=0"));
  const body = await events.json();
  assert.equal(body.latestSeq, 1);
  assert.equal(body.events[0].entityId, "k1", "the Request body must be parsed, not dropped");
});
