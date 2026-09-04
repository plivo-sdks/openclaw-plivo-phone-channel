import { describe, expect, it } from "vitest";
import {
  answerXml,
  checkpoint,
  clearAudio,
  parseFrame,
  playAudio,
  sendDtmf,
  STREAM_CONTENT_TYPE,
} from "./audio-streaming.js";

/**
 * Fixtures F1 and F4 come from plivo-kb/voice-audio-streaming.md, generated
 * from plivo-python. A conforming implementation reproduces them exactly.
 */
describe("golden fixtures from the Plivo KB", () => {
  it("F1: the answer XML matches plivoxml byte for byte", () => {
    expect(answerXml("wss://example.com/ws", "audio/x-mulaw;rate=8000")).toBe(
      '<Response><Stream bidirectional="true" contentType="audio/x-mulaw;rate=8000" ' +
        'keepCallAlive="true">wss://example.com/ws</Stream></Response>',
    );
  });

  it("F4: playAudio carries contentType, sampleRate and payload", () => {
    expect(JSON.parse(playAudio("QUJD"))).toEqual({
      event: "playAudio",
      media: {
        contentType: "audio/x-mulaw",
        sampleRate: 8000,
        payload: "QUJD",
      },
    });
  });

  it("F2: a start frame parses and exposes streamId and callId", () => {
    const frame = parseFrame(
      JSON.stringify({
        event: "start",
        sequenceNumber: 1,
        start: {
          callId: "abc",
          streamId: "str-1",
          tracks: ["inbound"],
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000 },
        },
      }),
    );
    expect(frame?.event).toBe("start");
    expect((frame as { start: { streamId: string } }).start.streamId).toBe(
      "str-1",
    );
  });

  it("F3: a media frame parses and exposes its payload", () => {
    const frame = parseFrame(
      JSON.stringify({
        event: "media",
        sequenceNumber: 42,
        streamId: "str-1",
        media: {
          track: "inbound",
          timestamp: "1705312200000",
          chunk: 41,
          payload: "QUJD",
        },
      }),
    );
    expect((frame as { media: { payload: string } }).media.payload).toBe(
      "QUJD",
    );
  });
});

describe("the codec the stream is opened with", () => {
  it("names mu-law at 8 kHz explicitly", () => {
    // Plivo defaults <Stream> to audio/x-l16;rate=8000, so leaving contentType
    // unset silently opens the stream in the wrong encoding.
    expect(STREAM_CONTENT_TYPE).toBe("audio/x-mulaw;rate=8000");
  });

  it("never opens at 16 kHz", () => {
    expect(answerXml("wss://example.com/ws")).not.toContain("16000");
  });
});

describe("frames sent back to Plivo", () => {
  it("uses clearAudio for barge-in rather than only stopping the send loop", () => {
    expect(JSON.parse(clearAudio("str-1"))).toEqual({
      event: "clearAudio",
      streamId: "str-1",
    });
  });

  it("uses checkpoint, which Plivo answers with playedStream", () => {
    expect(JSON.parse(checkpoint("str-1", "turn-7"))).toEqual({
      event: "checkpoint",
      streamId: "str-1",
      name: "turn-7",
    });
  });

  it("sends keypad digits as a single dtmf string", () => {
    expect(JSON.parse(sendDtmf("1234#"))).toEqual({
      event: "sendDTMF",
      dtmf: "1234#",
    });
  });
});

describe("frame parsing refuses anything it cannot trust", () => {
  it("returns null on malformed JSON rather than throwing into the socket loop", () => {
    expect(parseFrame("{not json")).toBeNull();
  });

  it("returns null when no event name is present", () => {
    expect(
      parseFrame(JSON.stringify({ media: { payload: "QUJD" } })),
    ).toBeNull();
  });
});

describe("XML escaping", () => {
  it("escapes a URL carrying query separators", () => {
    expect(answerXml("wss://example.com/ws?a=1&b=2")).toContain("a=1&amp;b=2");
  });
});
