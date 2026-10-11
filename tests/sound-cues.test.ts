import { afterEach, expect, test } from "bun:test";
import { armSoundCues, playSoundCue } from "../src/lib/sound-cues";

interface Tone {
  end: number;
  start: number;
}

/** Records the pitch sweep of every tone routed to the speakers. */
class RecordingAudioContext {
  static readonly instances: RecordingAudioContext[] = [];
  readonly currentTime = 0;
  readonly destination = {};
  readonly tones: Tone[] = [];
  state: "suspended" | "running" = "suspended";

  constructor() {
    RecordingAudioContext.instances.push(this);
  }

  resume() {
    this.state = "running";
    return Promise.resolve();
  }

  createGain() {
    return {
      connect: (_target: object) => undefined,
      gain: {
        exponentialRampToValueAtTime: (_value: number, _time: number) => undefined,
        setValueAtTime: (_value: number, _time: number) => undefined,
      },
    };
  }

  createOscillator() {
    const tone: Tone = { end: 0, start: 0 };
    return {
      connect: (_target: object) => {
        this.tones.push(tone);
      },
      frequency: {
        exponentialRampToValueAtTime: (value: number, _time: number) => {
          tone.end = value;
        },
        setValueAtTime: (value: number, _time: number) => {
          tone.start = value;
          tone.end = value;
        },
      },
      start: (_time: number) => undefined,
      stop: (_time: number) => undefined,
      type: "sine",
    };
  }
}

const original = Reflect.get(globalThis, "AudioContext");

afterEach(() => {
  Reflect.set(globalThis, "AudioContext", original);
  RecordingAudioContext.instances.length = 0;
});

test("sound cues stay silent when the runtime has no audio output", () => {
  Reflect.set(globalThis, "AudioContext", undefined);
  expect(() => playSoundCue("added")).not.toThrow();
  expect(() => playSoundCue("removed")).not.toThrow();
});

test("adding a torrent rises in pitch and removing one falls", () => {
  Reflect.set(globalThis, "AudioContext", RecordingAudioContext);
  const target = new EventTarget();
  const disarm = armSoundCues(target);
  target.dispatchEvent(new Event("pointerdown"));
  disarm();
  const [context] = RecordingAudioContext.instances;
  expect(context?.state).toBe("running");

  playSoundCue("added");
  const added = context?.tones.splice(0) ?? [];
  playSoundCue("removed");
  const removed = context?.tones.splice(0) ?? [];

  expect(added.length).toBeGreaterThan(0);
  expect(removed.length).toBeGreaterThan(0);
  expect(added.at(-1)?.end).toBeGreaterThan(added[0]?.start ?? 0);
  expect(removed.at(-1)?.end).toBeLessThan(removed[0]?.start ?? 0);
  expect(RecordingAudioContext.instances).toHaveLength(1);
});
