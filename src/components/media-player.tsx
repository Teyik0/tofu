import { useMutation } from "@teyik0/furin/client";
import type { Player, Track, VLC } from "libvlc-wasm";
import { version } from "libvlc-wasm/package.json";
import {
  ArrowLeftIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  MaximizeIcon,
  MinimizeIcon,
  PauseIcon,
  PlayIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/client";
import { errorMessage } from "../lib/errors";
import { Button } from "./ui/button";

// The engine is loaded at runtime from the server so its worker and WebAssembly files resolve
// next to it.
const engineUrl = `/api/player/engine/${version}/src/index.js`;

function clock(seconds: number) {
  const total = Number.isFinite(seconds) ? Math.max(Math.floor(seconds), 0) : 0;
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return total >= 3600
    ? `${Math.floor(total / 3600)}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
}

function trackLabel(track: Track) {
  return (
    [
      track.language && track.language !== "und" ? track.language.toUpperCase() : null,
      track.name,
      track.codecName ?? track.codec,
      track.channels ? `${track.channels} ch` : null,
    ]
      .filter(Boolean)
      .join(" · ") || track.id
  );
}

type PlaybackState = "loading" | "playing" | "paused" | "ended" | "error";

export function MediaPlayer({
  back,
  index,
  name,
  source,
  torrentId,
  unavailable,
}: {
  back: string;
  index: number;
  name: string;
  source: string;
  torrentId: string;
  unavailable: string | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const audio = useRef<AudioContext | null>(null);
  const [attempt, setAttempt] = useState(0);
  // VLC reports the input cache fill from 0 to 1.
  const [buffering, setBuffering] = useState(1);
  const [player, setPlayer] = useState<Player | null>(null);
  const [state, setState] = useState<PlaybackState>(unavailable ? "error" : "loading");
  const [error, setError] = useState<string | null>(unavailable);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [idle, setIdle] = useState(false);
  // Without a user gesture, WebKit keeps audio suspended and VLC's audio clock stops playback.
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const openExternally = useMutation(api.torrents({ id: torrentId }).files({ index }).open.post);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry deliberately replaces the complete player and engine.
  useEffect(() => {
    const target = canvas.current;
    if (unavailable || !target) {
      return;
    }
    setState("loading");
    setError(null);
    setPlayer(null);
    setTime(0);
    setDuration(0);
    setScrub(null);
    setTracks([]);
    setVolume(1);
    setMuted(false);
    setIdle(false);
    setBuffering(1);
    setAudioBlocked(false);
    let disposed = false;
    let engine: VLC | null = null;
    let current: Player | null = null;
    const subscriptions: (() => void)[] = [];
    // Each attempt owns its context and releases it when the player is replaced.
    const context = new AudioContext({ latencyHint: "interactive" });
    audio.current = context;
    const audioChanged = () => setAudioBlocked(context.state !== "running");
    context.addEventListener("statechange", audioChanged);
    const start = async () => {
      try {
        const { createVLC } = (await import(engineUrl)) as typeof import("libvlc-wasm");
        if (disposed) {
          return;
        }
        engine = await createVLC({ logLevel: "error" });
        if (disposed) {
          await engine.destroy();
          return;
        }
        subscriptions.push(
          engine.on("error", (cause) => {
            setError(cause.message || "The playback engine stopped. Retry to reconnect.");
            setState("error");
          })
        );
        current = await engine.createPlayer({ audioContext: context, canvas: target });
        if (disposed) {
          await current.destroy();
          await engine.destroy();
          return;
        }
        const selected = current;
        subscriptions.push(
          selected.on("statechange", (next) => {
            if (next === "playing" || next === "paused") {
              setState(next);
            }
          })
        );
        subscriptions.push(selected.on("buffering", setBuffering));
        subscriptions.push(selected.on("ended", () => setState("ended")));
        subscriptions.push(selected.on("timeupdate", setTime));
        subscriptions.push(selected.on("durationchange", setDuration));
        subscriptions.push(
          selected.on("volumechange", (next) => {
            setVolume(next.volume);
            setMuted(next.muted);
          })
        );
        subscriptions.push(
          selected.on("error", (cause) => {
            setError(cause.message);
            setState("error");
          })
        );
        subscriptions.push(selected.on("tracks", (list) => setTracks([...list])));
        // Anime releases expect their subtitles on: select the first track before playback so
        // the opening lines are not missed.
        await selected.open(new URL(source, window.location.href).href, {
          autoplay: false,
          options: [":sub-track=0"],
        });
        if (disposed) {
          return;
        }
        setPlayer(selected);
        // WebKit keeps resume() pending until a user gesture when autoplay is restricted.
        await Promise.race([context.resume(), new Promise((resolve) => setTimeout(resolve, 300))]);
        if (disposed) {
          return;
        }
        if (context.state === "running") {
          await selected.play();
        } else {
          setAudioBlocked(true);
          setState("paused");
        }
      } catch (cause) {
        if (!disposed) {
          setError(errorMessage(cause, "Unable to start the player"));
          setState("error");
        }
      }
    };
    void start();
    return () => {
      disposed = true;
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
      context.removeEventListener("statechange", audioChanged);
      void current?.destroy();
      void engine?.destroy();
      void context.close();
    };
  }, [source, unavailable, attempt]);

  useEffect(() => {
    // The page renders on the server first, where full screen support is unknown.
    setFullscreenSupported(document.fullscreenEnabled);
    const changed = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);

  useEffect(() => {
    if (state !== "playing" || idle) {
      return;
    }
    const timer = setTimeout(() => setIdle(true), 2500);
    return () => clearTimeout(timer);
  }, [idle, state]);

  const toggle = async () => {
    if (!player) {
      return;
    }
    if (audioBlocked) {
      await audio.current?.resume();
      await player.play();
      return;
    }
    await (state === "ended" ? player.seek(0) : player.togglePause());
  };
  const toggleFullscreen = async () => {
    await (document.fullscreenElement
      ? document.exitFullscreen()
      : shell.current?.requestFullscreen());
  };

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!player || event.target instanceof HTMLSelectElement) {
        return;
      }
      setIdle(false);
      if (event.key === " " || event.key === "k") {
        event.preventDefault();
        void toggle();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        void player.seek(Math.max(player.currentTime + (event.key === "ArrowLeft" ? -10 : 10), 0));
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        player.volume = Math.min(
          Math.max(player.volume + (event.key === "ArrowUp" ? 0.1 : -0.1), 0),
          1
        );
      } else if (event.key === "m") {
        player.muted = !player.muted;
      } else if (event.key === "f") {
        void toggleFullscreen();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  const audioTracks = tracks.filter((track) => track.type === "audio");
  const textTracks = tracks.filter((track) => track.type === "text");
  const position = scrub ?? time;
  const commitScrub = async () => {
    if (scrub !== null && player) {
      setScrub(null);
      await player.seek(scrub);
    }
  };
  const controlsVisible = !idle || state !== "playing" || audioBlocked;

  return (
    <div
      className="fixed inset-0 z-50 flex select-none flex-col bg-black text-white"
      data-idle={!controlsVisible}
      onPointerMove={() => setIdle(false)}
      ref={shell}
      style={{ cursor: controlsVisible ? "default" : "none" }}
    >
      <canvas
        aria-label={name}
        className="absolute inset-0 size-full"
        onClick={() => void toggle()}
        onDoubleClick={() => void toggleFullscreen()}
        ref={canvas}
      />
      <div
        className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-3 bg-linear-to-b from-black/70 to-transparent p-4 transition-opacity"
        style={{ opacity: controlsVisible ? 1 : 0 }}
      >
        <Button
          aria-label="Back to the library"
          className="pointer-events-auto text-white hover:bg-white/15 hover:text-white"
          onClick={() => window.location.assign(back)}
          size="icon"
          variant="ghost"
        >
          <ArrowLeftIcon />
        </Button>
        <h1 className="truncate font-medium text-sm">{name}</h1>
      </div>
      {state === "loading" || audioBlocked || state === "error" || buffering < 1 ? (
        <div className="absolute inset-0 grid place-items-center p-6">
          {state === "loading" ? (
            <LoaderCircleIcon aria-label="Loading" className="size-10 animate-spin text-white/70" />
          ) : null}
          {buffering < 1 && state !== "loading" && state !== "error" && !audioBlocked ? (
            <div className="flex items-center gap-3 text-sm text-white/80" role="status">
              <LoaderCircleIcon className="size-5 animate-spin" />
              Buffering… {Math.round(buffering * 100)}%
            </div>
          ) : null}
          {audioBlocked && state !== "loading" && state !== "error" ? (
            <Button onClick={() => void toggle()} size="lg">
              <PlayIcon data-icon="inline-start" />
              Play
            </Button>
          ) : null}
          {state === "error" ? (
            <div className="flex max-w-md flex-col items-center gap-4 text-center">
              <p className="text-sm text-white/80" role="alert">
                {error ?? "This file cannot be played."}
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {unavailable ? null : (
                  <Button onClick={() => setAttempt((value) => value + 1)} variant="secondary">
                    Retry
                  </Button>
                )}
                <Button onClick={() => window.location.assign(back)} variant="secondary">
                  Back
                </Button>
                <Button
                  onClick={async () => {
                    try {
                      await openExternally.mutateAsync({});
                    } catch (cause) {
                      setError(errorMessage(cause, "Unable to open the file"));
                    }
                  }}
                >
                  <ExternalLinkIcon data-icon="inline-start" />
                  Open with system player
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      <div
        className="absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-linear-to-t from-black/80 to-transparent px-4 pt-10 pb-3 transition-opacity"
        style={{ opacity: controlsVisible && player ? 1 : 0 }}
      >
        <input
          aria-label="Seek"
          className="w-full accent-white"
          disabled={!player || duration === 0}
          max={duration || 0}
          min={0}
          onBlur={() => void commitScrub()}
          onChange={(event) => setScrub(Number(event.target.value))}
          onKeyUp={() => void commitScrub()}
          onPointerUp={() => void commitScrub()}
          step={0.1}
          type="range"
          value={Math.min(position, duration || 0)}
        />
        <div className="flex items-center gap-2 text-sm">
          <Button
            aria-label={state === "playing" ? "Pause" : "Play"}
            className="text-white hover:bg-white/15 hover:text-white"
            disabled={!player}
            onClick={() => void toggle()}
            size="icon"
            variant="ghost"
          >
            {state === "playing" ? <PauseIcon /> : <PlayIcon />}
          </Button>
          <Button
            aria-label={muted ? "Unmute" : "Mute"}
            className="text-white hover:bg-white/15 hover:text-white"
            disabled={!player}
            onClick={() => {
              if (player) {
                player.muted = !player.muted;
              }
            }}
            size="icon"
            variant="ghost"
          >
            {muted || volume === 0 ? <VolumeXIcon /> : <Volume2Icon />}
          </Button>
          <input
            aria-label="Volume"
            className="w-24 accent-white"
            disabled={!player}
            max={1}
            min={0}
            onChange={(event) => {
              if (player) {
                player.volume = Number(event.target.value);
              }
            }}
            step={0.05}
            type="range"
            value={muted ? 0 : Math.min(volume, 1)}
          />
          <span className="font-mono text-white/80 text-xs tabular-nums">
            {clock(position)} / {clock(duration)}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {audioTracks.length > 1 ? (
              <select
                aria-label="Audio track"
                className="h-8 max-w-56 rounded-md bg-white/10 px-2 text-xs"
                onChange={(event) => void player?.selectTrack(event.target.value)}
                value={audioTracks.find((track) => track.selected)?.id ?? ""}
              >
                {audioTracks.map((track) => (
                  <option key={track.id} value={track.id}>
                    {trackLabel(track)}
                  </option>
                ))}
              </select>
            ) : null}
            {textTracks.length > 0 ? (
              <select
                aria-label="Subtitles"
                className="h-8 max-w-56 rounded-md bg-white/10 px-2 text-xs"
                onChange={(event) =>
                  void (event.target.value
                    ? player?.selectTrack(event.target.value)
                    : player?.disableTrack("text"))
                }
                value={textTracks.find((track) => track.selected)?.id ?? ""}
              >
                <option value="">Subtitles off</option>
                {textTracks.map((track) => (
                  <option key={track.id} value={track.id}>
                    {trackLabel(track)}
                  </option>
                ))}
              </select>
            ) : null}
            {fullscreenSupported ? (
              <Button
                aria-label={fullscreen ? "Exit full screen" : "Full screen"}
                className="text-white hover:bg-white/15 hover:text-white"
                onClick={() => void toggleFullscreen()}
                size="icon"
                variant="ghost"
              >
                {fullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
