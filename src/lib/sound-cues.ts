export type SoundCue = "added" | "removed";

interface Note {
  /** Seconds after the cue starts. */
  at: number;
  duration: number;
  from: number;
  to: number;
  volume: number;
}

/** Short synthesized cues: a bright rising chime for additions, a soft falling tone for removals. */
const cues: { [Cue in SoundCue]: Note[] } = {
  added: [
    { at: 0, duration: 0.12, from: 660, to: 880, volume: 0.08 },
    { at: 0.07, duration: 0.18, from: 990, to: 1320, volume: 0.06 },
  ],
  removed: [
    { at: 0, duration: 0.1, from: 520, to: 420, volume: 0.07 },
    { at: 0.06, duration: 0.22, from: 360, to: 180, volume: 0.07 },
  ],
};

let context: AudioContext | null = null;

function audioContext() {
  const Context: typeof AudioContext | undefined = Reflect.get(globalThis, "AudioContext");
  if (context === null && typeof Context === "function") {
    try {
      context = new Context();
    } catch {
      return null;
    }
  }
  return context;
}

function unlock() {
  const current = audioContext();
  if (current?.state === "suspended") {
    void current.resume().catch(() => undefined);
  }
  return current;
}

/**
 * WebKit only starts audio from a user gesture, while cues play after the API responds.
 * Resume the shared context on the first interaction so later cues are audible.
 */
export function armSoundCues(target: EventTarget) {
  const events = ["pointerdown", "keydown"];
  const listener = () => {
    if (unlock()?.state !== "suspended") {
      disarm();
    }
  };
  const disarm = () => {
    for (const event of events) {
      target.removeEventListener(event, listener, true);
    }
  };
  for (const event of events) {
    target.addEventListener(event, listener, true);
  }
  return disarm;
}

/** Plays a cue when audio output is available; stays silent otherwise. */
export function playSoundCue(cue: SoundCue) {
  const current = unlock();
  if (current === null) {
    return;
  }
  try {
    const start = current.currentTime;
    for (const note of cues[cue]) {
      const oscillator = current.createOscillator();
      const gain = current.createGain();
      const begin = start + note.at;
      const end = begin + note.duration;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(note.from, begin);
      oscillator.frequency.exponentialRampToValueAtTime(note.to, end);
      gain.gain.setValueAtTime(0.0001, begin);
      gain.gain.exponentialRampToValueAtTime(note.volume, begin + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.connect(gain);
      gain.connect(current.destination);
      oscillator.start(begin);
      oscillator.stop(end + 0.02);
    }
  } catch {
    // Audio feedback is decorative; never let it break the action that triggered it.
  }
}
