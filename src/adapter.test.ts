import { describe, expect, it } from "vitest";
import { createPlivoStream, type StreamSession } from "./adapter.js";

type FakeWs = {
  readyState: number;
  sent: string[];
  send: (payload: string) => void;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
};

function fakeWs(readyState = 1): FakeWs {
  const sent: string[] = [];
  return {
    readyState,
    sent,
    send: (payload: string) => sent.push(payload),
    on: () => undefined,
  };
}

function recorder() {
  const audio: Buffer[] = [];
  const marks: (string | undefined)[] = [];
  const digits: string[] = [];
  let closed = false;
  const session: StreamSession = {
    sendAudio: (buf) => audio.push(buf),
    acknowledgeMark: (name) => marks.push(name),
    sendDigit: (digit) => digits.push(digit),
    close: () => {
      closed = true;
    },
  };
  return { session, audio, marks, digits, isClosed: () => closed };
}

function start(streamId = "str-1", callId = "call-1") {
  return JSON.stringify({ event: "start", start: { streamId, callId } });
}

describe("the sink maps onto Plivo frame names", () => {
  it("sends caller audio as playAudio", () => {
    const ws = fakeWs();
    const rec = recorder();
    const stream = createPlivoStream({ ws: ws as never, session: rec.session });
    stream.sink.sendAudio(Buffer.from("ABC"));
    expect(JSON.parse(ws.sent[0] ?? "{}").event).toBe("playAudio");
  });

  it("sends a mark as checkpoint, which is what Plivo acks", () => {
    const ws = fakeWs();
    const rec = recorder();
    const stream = createPlivoStream({ ws: ws as never, session: rec.session });
    stream.handleFrame(start());
    stream.sink.sendMark("turn-1");
    expect(JSON.parse(ws.sent[0] ?? "{}")).toEqual({
      event: "checkpoint",
      streamId: "str-1",
      name: "turn-1",
    });
  });

  it("sends an interrupt as clearAudio, so Plivo drops what it buffered", () => {
    const ws = fakeWs();
    const rec = recorder();
    const stream = createPlivoStream({ ws: ws as never, session: rec.session });
    stream.handleFrame(start());
    stream.sink.clearAudio();
    expect(JSON.parse(ws.sent[0] ?? "{}").event).toBe("clearAudio");
  });

  it("holds a mark and an interrupt until the start frame supplies a streamId", () => {
    // Both frames carry streamId. Sending them before start would name an empty
    // stream and Plivo would discard them silently.
    const ws = fakeWs();
    const rec = recorder();
    const stream = createPlivoStream({ ws: ws as never, session: rec.session });
    stream.sink.sendMark("turn-1");
    stream.sink.clearAudio();
    expect(ws.sent).toEqual([]);
  });

  it("reports closed when the socket is not open, so the bridge stops writing", () => {
    const rec = recorder();
    const stream = createPlivoStream({
      ws: fakeWs(3) as never,
      session: rec.session,
    });
    expect(stream.sink.isOpen()).toBe(false);
  });

  it("drops a frame on a closed socket instead of throwing into the media loop", () => {
    const rec = recorder();
    const stream = createPlivoStream({
      ws: fakeWs(3) as never,
      session: rec.session,
    });
    expect(() => stream.sink.sendAudio(Buffer.from("ABC"))).not.toThrow();
  });
});

describe("inbound frames reach the session", () => {
  it("decodes a media payload and forwards the bytes", () => {
    const rec = recorder();
    const stream = createPlivoStream({
      ws: fakeWs() as never,
      session: rec.session,
    });
    stream.handleFrame(start());
    stream.handleFrame(
      JSON.stringify({ event: "media", media: { payload: "QUJD" } }),
    );
    expect(rec.audio[0]?.toString()).toBe("ABC");
  });

  it("turns playedStream into a mark acknowledgement", () => {
    // Without this the bridge never learns the audio was heard rather than sent,
    // and anything sequenced after a reply waits out its timeout.
    const rec = recorder();
    const stream = createPlivoStream({
      ws: fakeWs() as never,
      session: rec.session,
    });
    stream.handleFrame(start());
    stream.handleFrame(
      JSON.stringify({ event: "playedStream", name: "turn-1" }),
    );
    expect(rec.marks).toEqual(["turn-1"]);
  });

  it("forwards a keypad digit", () => {
    const rec = recorder();
    const stream = createPlivoStream({
      ws: fakeWs() as never,
      session: rec.session,
    });
    stream.handleFrame(start());
    stream.handleFrame(JSON.stringify({ event: "dtmf", dtmf: { digit: "5" } }));
    expect(rec.digits).toEqual(["5"]);
  });

  it("ignores clearedAudio, which needs no action", () => {
    const rec = recorder();
    const stream = createPlivoStream({
      ws: fakeWs() as never,
      session: rec.session,
    });
    stream.handleFrame(start());
    stream.handleFrame(JSON.stringify({ event: "clearedAudio" }));
    expect(rec.isClosed()).toBe(false);
  });

  it("survives a malformed frame without closing the call", () => {
    const rec = recorder();
    const stream = createPlivoStream({
      ws: fakeWs() as never,
      session: rec.session,
    });
    expect(() => stream.handleFrame("{not json")).not.toThrow();
    expect(rec.isClosed()).toBe(false);
  });

  it("ignores an event name it does not know", () => {
    const rec = recorder();
    const stream = createPlivoStream({
      ws: fakeWs() as never,
      session: rec.session,
    });
    stream.handleFrame(JSON.stringify({ event: "somethingNew" }));
    expect(rec.isClosed()).toBe(false);
  });

  it("records the ids the start frame carries", () => {
    const rec = recorder();
    const stream = createPlivoStream({
      ws: fakeWs() as never,
      session: rec.session,
    });
    stream.handleFrame(start("s-9", "c-9"));
    expect([stream.streamId(), stream.callId()]).toEqual(["s-9", "c-9"]);
  });

  it("ends the call on a stop frame, when one arrives", () => {
    // The current protocol reference documents no stop input, so this is an
    // early exit rather than the signal relied on. Socket close is authoritative.
    const rec = recorder();
    const stream = createPlivoStream({
      ws: fakeWs() as never,
      session: rec.session,
    });
    stream.handleFrame(start());
    stream.handleFrame(JSON.stringify({ event: "stop" }));
    expect(rec.isClosed()).toBe(true);
  });
});

describe("agent-driven keypad output", () => {
  it("sends digits as one sendDTMF frame", () => {
    const ws = fakeWs();
    const rec = recorder();
    const stream = createPlivoStream({ ws: ws as never, session: rec.session });
    stream.handleFrame(start());
    stream.sendDigits("1234#");
    expect(JSON.parse(ws.sent[0] ?? "{}")).toEqual({
      event: "sendDTMF",
      dtmf: "1234#",
    });
  });
});
