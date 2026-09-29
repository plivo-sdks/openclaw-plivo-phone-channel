import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachCloseHandling,
  createCallLimits,
  createPlivoStream,
  type StreamSession,
} from "./adapter.js";

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
  const timestamps: number[] = [];
  const order: string[] = [];
  let closed = false;
  const session: StreamSession = {
    sendAudio: (buf) => {
      audio.push(buf);
      order.push("audio");
    },
    setMediaTimestamp: (ms) => {
      timestamps.push(ms);
      order.push("timestamp");
    },
    acknowledgeMark: (name) => marks.push(name),
    sendDigit: (digit) => digits.push(digit),
    close: () => {
      closed = true;
    },
  };
  return { session, audio, marks, digits, timestamps, order, isClosed: () => closed };
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

describe("caller audio always reaches the session", () => {
  /**
   * Suppressing caller audio while a reply plays looks like the fix for a
   * speakerphone returning the agent's own words, and the SDK exports
   * extendRealtimeVoiceOutputEchoSuppression for exactly that. It is wrong
   * here. createRealtimeVoiceBridgeSession forwards sendAudio straight to the
   * provider's bridge, and this provider sets handlesInputAudioBargeIn, so the
   * provider only learns the caller interrupted by hearing them over the
   * reply. These tests exist to fail if the guard is ever reintroduced.
   */
  const media = (payload = "AAAA") =>
    JSON.stringify({ event: "media", media: { payload } });

  function harness() {
    const ws = fakeWs();
    const rec = recorder();
    const stream = createPlivoStream({ ws: ws as never, session: rec.session });
    stream.handleFrame(start());
    return { ws, rec, stream };
  }

  it("passes caller audio through while a reply is playing", () => {
    const h = harness();
    h.stream.sink.sendAudio(Buffer.alloc(8000)); // a full second still playing
    h.stream.handleFrame(media());
    expect(h.rec.audio).toHaveLength(1);
  });

  it("passes caller audio through immediately after a long reply is queued", () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) {
      h.stream.sink.sendAudio(Buffer.alloc(8000)); // five seconds queued
    }
    h.stream.handleFrame(media());
    h.stream.handleFrame(media());
    expect(h.rec.audio).toHaveLength(2);
  });

  it("passes caller audio through after a barge-in clears the buffer", () => {
    const h = harness();
    h.stream.sink.sendAudio(Buffer.alloc(8000));
    h.stream.sink.clearAudio();
    h.stream.handleFrame(media());
    expect(h.rec.audio).toHaveLength(1);
  });

  it("still delivers keypad input during playback", () => {
    const h = harness();
    h.stream.sink.sendAudio(Buffer.alloc(8000));
    h.stream.handleFrame(
      JSON.stringify({ event: "dtmf", dtmf: { digit: "5" } }),
    );
    expect(h.rec.digits).toEqual(["5"]);
  });
});

describe("a stream that ends reaps the Plivo call", () => {
  /**
   * The answer XML sets keepCallAlive, which lets a dropped socket reconnect and
   * equally leaves a dead one billing until streamTimeout, a day by default.
   * plivo-kb voice-audio-streaming.md mistake 12. Closing the session alone left
   * the caller in billed silence.
   */
  function harness() {
    const handlers: Record<string, (arg?: unknown) => void> = {};
    const ws = {
      readyState: 1,
      sent: [] as string[],
      send: (p: string) => ws.sent.push(p),
      on: (event: string, h: (arg?: unknown) => void) => {
        handlers[event] = h;
      },
    };
    const closed: string[] = [];
    const reaped: string[] = [];
    attachCloseHandling({
      ws: ws as never,
      session: { close: () => closed.push("session") } as never,
      onEnd: () => reaped.push("call"),
    });
    return { handlers, closed, reaped };
  }

  it("hangs up the call when the socket closes", () => {
    const h = harness();
    h.handlers.close?.();
    expect(h.closed).toEqual(["session"]);
    expect(h.reaped).toEqual(["call"]);
  });

  it("hangs up the call when the socket errors", () => {
    const h = harness();
    h.handlers.error?.(new Error("reset by peer"));
    expect(h.reaped).toEqual(["call"]);
  });

  it("hangs up once when close and error both fire", () => {
    /** Both fire on an abnormal end, and a second hangup reports a false error. */
    const h = harness();
    h.handlers.error?.(new Error("reset by peer"));
    h.handlers.close?.();
    expect(h.reaped).toEqual(["call"]);
    expect(h.closed).toEqual(["session"]);
  });

  it("closes the session before reaping the call", () => {
    /** Reaping first would race the session's own teardown writes. */
    const order: string[] = [];
    const handlers: Record<string, () => void> = {};
    attachCloseHandling({
      ws: {
        readyState: 1,
        on: (e: string, fn: () => void) => {
          handlers[e] = fn;
        },
      } as never,
      session: { close: () => order.push("session") } as never,
      onEnd: () => order.push("call"),
    });
    handlers.close?.();
    expect(order).toEqual(["session", "call"]);
  });
});

describe("the call limits", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends a call that goes quiet for the idle timeout", () => {
    vi.useFakeTimers();
    const reasons: string[] = [];
    createCallLimits({
      idleTimeoutSeconds: 60,
      maxCallSeconds: 0,
      onExpire: (why) => reasons.push(why),
    });
    vi.advanceTimersByTime(59_000);
    expect(reasons).toEqual([]);
    vi.advanceTimersByTime(2_000);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("no sound");
  });

  it("restarts the idle countdown on every sound", () => {
    vi.useFakeTimers();
    const reasons: string[] = [];
    const limits = createCallLimits({
      idleTimeoutSeconds: 60,
      maxCallSeconds: 0,
      onExpire: (why) => reasons.push(why),
    });
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(50_000);
      limits.touch();
    }
    expect(reasons).toEqual([]);
  });

  it("ends a call that reaches the maximum length even while both parties talk", () => {
    vi.useFakeTimers();
    const reasons: string[] = [];
    const limits = createCallLimits({
      idleTimeoutSeconds: 60,
      maxCallSeconds: 600,
      onExpire: (why) => reasons.push(why),
    });
    for (let i = 0; i < 20; i += 1) {
      vi.advanceTimersByTime(40_000);
      limits.touch();
    }
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("600s call limit");
  });

  it("expires once, not once per timer", () => {
    vi.useFakeTimers();
    const reasons: string[] = [];
    createCallLimits({
      idleTimeoutSeconds: 10,
      maxCallSeconds: 10,
      onExpire: (why) => reasons.push(why),
    });
    vi.advanceTimersByTime(60_000);
    expect(reasons).toHaveLength(1);
  });

  it("treats zero as disabled, which is what the configuration documents", () => {
    vi.useFakeTimers();
    const reasons: string[] = [];
    createCallLimits({
      idleTimeoutSeconds: 0,
      maxCallSeconds: 0,
      onExpire: (why) => reasons.push(why),
    });
    vi.advanceTimersByTime(86_400_000);
    expect(reasons).toEqual([]);
  });

  it("stays quiet after stop, so a closed socket is not hung up twice", () => {
    vi.useFakeTimers();
    const reasons: string[] = [];
    const limits = createCallLimits({
      idleTimeoutSeconds: 10,
      maxCallSeconds: 20,
      onExpire: (why) => reasons.push(why),
    });
    limits.stop();
    vi.advanceTimersByTime(60_000);
    expect(reasons).toEqual([]);
  });
});

describe("calibrating barge-in", () => {
  const media = (fields: Record<string, string>) =>
    JSON.stringify({ event: "media", media: fields });

  it("forwards Plivo's media timestamp to the session", () => {
    // Without this the provider keeps its initial zero, computes a played
    // duration of zero, falls under the minimum and returns before clearing
    // audio, so a caller cannot interrupt a reply. The audio path being the
    // barge-in sensor is only half of it, because the sensor needs calibrating.
    const rec = recorder();
    const stream = createPlivoStream({ ws: fakeWs() as never, session: rec.session });
    stream.handleFrame(media({ timestamp: "3000", payload: "AAA=" }));
    expect(rec.timestamps).toEqual([3000]);
  });

  it("forwards the timestamp before the audio it belongs to", () => {
    const rec = recorder();
    const stream = createPlivoStream({ ws: fakeWs() as never, session: rec.session });
    stream.handleFrame(media({ timestamp: "20", payload: "AAA=" }));
    expect(rec.order).toEqual(["timestamp", "audio"]);
  });

  it("still forwards audio when a frame carries no timestamp", () => {
    const rec = recorder();
    const stream = createPlivoStream({ ws: fakeWs() as never, session: rec.session });
    stream.handleFrame(media({ payload: "AAA=" }));
    expect(rec.audio).toHaveLength(1);
    expect(rec.timestamps).toEqual([]);
  });

  it("ignores a timestamp that is not a number", () => {
    const rec = recorder();
    const stream = createPlivoStream({ ws: fakeWs() as never, session: rec.session });
    stream.handleFrame(media({ timestamp: "later", payload: "AAA=" }));
    expect(rec.timestamps).toEqual([]);
    expect(rec.audio).toHaveLength(1);
  });
});
