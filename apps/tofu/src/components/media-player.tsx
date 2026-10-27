import { useMutation } from "@teyik0/furin/client";
import { useAtomValue } from "jotai";
import type { Player, Track, VLC } from "libvlc-wasm";
import {
  ArrowLeftIcon,
  CaptionsIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  ExternalLinkIcon,
  HeadphonesIcon,
  LoaderCircleIcon,
  MaximizeIcon,
  MinimizeIcon,
  PauseIcon,
  PlayIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../../package/ui/src/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../../../../package/ui/src/ui/select";
import { version as tofuVersion, version } from "../../package.json";
import { CanvasVideoFullscreen } from "../lib/canvas-video-fullscreen";
import { api } from "../lib/client";
import { errorMessage } from "../lib/errors";
import { sessionAtom } from "../state/workspace";

// The engine is loaded at runtime from the server so its worker and WebAssembly files resolve
// next to it. Tofu's version also invalidates immutable caches when its engine patch changes.
const engineUrl = `/api/player/engine/${version}/src/index.js?tofu=${tofuVersion}`;
const CHROMIUM_BROWSER = /(?:Chrome|Chromium|Edg)\//;
const IOS_BROWSER = /iPhone|iPad|iPod/;

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
  complete,
  index,
  name,
  mediaKey,
  remoteEpisode,
  initialGrant,
  retrySource,
  serverName,
  source,
  torrentId,
  unavailable,
}: {
  back: string;
  complete: boolean;
  index: number;
  name: string;
  mediaKey: string;
  remoteEpisode?: { mediaId: number; episode: number };
  initialGrant?: { id: string; expiresAt: number; url: string };
  retrySource?: () => Promise<{ id: string; expiresAt: number; url: string }>;
  serverName?: string;
  source: string;
  torrentId: string;
  unavailable: string | null;
}) {
  const session = useAtomValue(sessionAtom);
  const playbackSessionId = useRef(crypto.randomUUID());
  const sequence = useRef(0);
  const latest = useRef<{ duration: number; mediaKey: string; position: number }>({
    duration: 0,
    mediaKey,
    position: 0,
  });
  const intent = useRef<"playing" | "paused">("playing");
  const preferences = useRef<{
    volume: number;
    muted: boolean;
    audio: string | null;
    text: string | null;
  }>({ audio: null, muted: false, text: null, volume: 1 });
  const [playbackSource, setPlaybackSource] = useState(source);
  const [completionAccount, setCompletionAccount] = useState<{ id: number; name: string } | null>(
    null
  );
  useEffect(() => {
    if (!(remoteEpisode && session?.capabilities.administer)) {
      return;
    }
    let active = true;
    const load = async () => {
      const { data, error: failure } = await api.anilist.get();
      if (active && !failure && data.authenticated && data.accountId !== null) {
        setCompletionAccount({
          id: data.accountId,
          name: data.connectedUser ?? "your AniList account",
        });
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [remoteEpisode, session?.capabilities.administer]);
  const [completedPrompt, setCompletedPrompt] = useState(false);
  const [completionDismissed, setCompletionDismissed] = useState(false);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const [temporaryLink, setTemporaryLink] = useState<{
    id: string;
    expiresAt: number;
    url: string;
  } | null>(initialGrant ?? null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const pointerType = useRef("mouse");
  const audio = useRef<AudioContext | null>(null);
  const audioOutput = useRef<GainNode | null>(null);
  const nativeFullscreen = useRef<CanvasVideoFullscreen | null>(null);
  const activePlayer = useRef<Player | null>(null);
  const pendingCommand = useRef<symbol | null>(null);
  const engineMessages = useRef<string[]>([]);
  const cacheFill = useRef(1);
  const playbackFailed = useRef(false);
  const [attempt, setAttempt] = useState(0);
  // VLC reports the input cache fill from 0 to 1.
  const [buffering, setBuffering] = useState(1);
  const [showBuffering, setShowBuffering] = useState(false);
  const [trackMenuOpen, setTrackMenuOpen] = useState(false);
  const [seekFeedback, setSeekFeedback] = useState<{
    seconds: number;
    at: number;
    sequence: number;
  } | null>(null);
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
  const [fullscreenNotice, setFullscreenNotice] = useState<string | null>(null);
  const openExternally = useMutation(api.torrents({ id: torrentId }).files({ index }).open.post);

  const reportFailure = async (
    operation: "start" | "play" | "pause" | "engine" | "media",
    cause: unknown,
    selected: Player | null
  ) => {
    const message = errorMessage(cause, "The player stopped responding. Retry to reconnect.");
    playbackFailed.current = true;
    setError(message);
    setState("error");
    setIdle(false);
    try {
      await api.player.diagnostics.post({
        audioState: audio.current?.state ?? "unavailable",
        buffering: Math.min(Math.max(cacheFill.current, 0), 1),
        engineMessages: [...engineMessages.current],
        fileIndex: index,
        message: message.slice(0, 2048),
        operation,
        playbackState: selected?.state ?? "unavailable",
        time: Math.max(selected?.currentTime ?? 0, 0),
        torrentId,
      });
    } catch {
      // Playback recovery must remain available when the server cannot receive diagnostics.
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: Cache policy is chosen when opening a source; finishing its download must not restart playback.
  useEffect(() => {
    const target = canvas.current;
    if (unavailable || !target) {
      return;
    }
    const resumeAt = latest.current.mediaKey === mediaKey ? latest.current.position : 0;
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
    setSeekFeedback(null);
    setTrackMenuOpen(false);
    engineMessages.current = [];
    cacheFill.current = 1;
    playbackFailed.current = false;
    let disposed = false;
    let engine: VLC | null = null;
    let current: Player | null = null;
    const subscriptions: (() => void)[] = [];
    // Web Audio defaults to ambient on iOS, which obeys the phone's silent switch.
    // A movie must use the media channel, just like a native video element.
    const { audioSession } = navigator as Navigator & { audioSession?: { type: string } };
    const previousAudioType = audioSession?.type;
    if (audioSession) {
      audioSession.type = "playback";
    }
    // Each attempt owns its context and releases it when the player is replaced.
    const context = new AudioContext({ latencyHint: "interactive" });
    audio.current = context;
    const nativeVideo = document.createElement("video") as HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
    };
    const fullscreenContainer = shell.current as HTMLDivElement & {
      webkitRequestFullscreen?: unknown;
    };
    const output =
      nativeVideo.webkitEnterFullscreen &&
      typeof target.captureStream === "function" &&
      !document.fullscreenEnabled &&
      !fullscreenContainer.webkitRequestFullscreen
        ? context.createGain()
        : undefined;
    output?.connect(context.destination);
    audioOutput.current = output ?? null;
    const audioChanged = () => setAudioBlocked(context.state !== "running");
    context.addEventListener("statechange", audioChanged);
    const start = async () => {
      try {
        if (
          !(window.isSecureContext && window.crossOriginIsolated) ||
          typeof SharedArrayBuffer === "undefined"
        ) {
          throw new Error(
            "This player requires a secure, isolated browser context. Open Tofu through HTTPS or copy a temporary playback link for an external player."
          );
        }
        if (
          remoteEpisode &&
          !(CHROMIUM_BROWSER.test(navigator.userAgent) && !IOS_BROWSER.test(navigator.userAgent))
        ) {
          throw new Error(
            "Remote playback in this browser has not passed validation. Copy the temporary playback link for an external player."
          );
        }
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
            if (!disposed) {
              void reportFailure("engine", cause, current);
            }
          }),
          engine.on("log", ({ message }) => {
            engineMessages.current.push(message.slice(0, 1024));
            if (engineMessages.current.length > 8) {
              engineMessages.current.shift();
            }
          })
        );
        current = await engine.createPlayer({
          audioContext: context,
          audioDestination: output,
          canvas: target,
        });
        if (disposed) {
          await current.destroy();
          await engine.destroy();
          return;
        }
        const selected = current;
        subscriptions.push(
          selected.on("statechange", (next) => {
            // biome-ignore lint/suspicious/noUnnecessaryConditions: failure callbacks update this ref after startup.
            if (!playbackFailed.current && (next === "playing" || next === "paused")) {
              setState(next);
            }
          })
        );
        subscriptions.push(
          selected.on("buffering", (next) => {
            cacheFill.current = next;
            setBuffering(next);
          })
        );
        subscriptions.push(
          selected.on("ended", () => {
            // biome-ignore lint/suspicious/noUnnecessaryConditions: failure callbacks update this ref after startup.
            if (!playbackFailed.current) {
              setState("ended");
            }
          })
        );
        subscriptions.push(selected.on("timeupdate", setTime));
        subscriptions.push(selected.on("durationchange", setDuration));
        subscriptions.push(
          selected.on("volumechange", (next) => {
            preferences.current.volume = next.volume;
            preferences.current.muted = next.muted;
            setVolume(next.volume);
            setMuted(next.muted);
          })
        );
        subscriptions.push(
          selected.on("error", (cause) => {
            if (!disposed) {
              void reportFailure("media", cause, selected);
            }
          })
        );
        subscriptions.push(
          selected.on("tracks", (list) => {
            setTracks([...list]);
            const wanted = preferences.current;
            if (
              wanted.audio &&
              list.some((track) => track.id === wanted.audio && !track.selected)
            ) {
              void selected.selectTrack(wanted.audio);
            }
            if (
              wanted.text === "" &&
              list.some((track) => track.type === "text" && track.selected)
            ) {
              void selected.disableTrack("text");
            } else if (
              wanted.text &&
              list.some((track) => track.id === wanted.text && !track.selected)
            ) {
              void selected.selectTrack(wanted.text);
            }
          })
        );
        // Anime releases expect their subtitles on: select the first track before playback so
        // the opening lines are not missed.
        await selected.open(new URL(playbackSource, window.location.href).href, {
          autoplay: false,
          // HTTP sources are mounted as lazy files by the engine, so file-caching applies.
          options: complete ? [":sub-track=0", ":file-caching=100"] : [":sub-track=0"],
        });
        if (disposed) {
          return;
        }
        activePlayer.current = selected;
        const { data: saved, error: progressError } = await api.playback
          .positions({ mediaKey })
          .get();
        const resumePosition =
          resumeAt ||
          (!progressError &&
          saved.position &&
          saved.duration &&
          saved.position < saved.duration * 0.98
            ? saved.position
            : 0);
        if (resumePosition > 0) {
          await selected.seek(resumePosition);
        }
        selected.volume = preferences.current.volume;
        selected.muted = preferences.current.muted;
        if (disposed) {
          return;
        }
        setPlayer(selected);
        // WebKit keeps resume() pending until a user gesture when autoplay is restricted.
        await Promise.race([context.resume(), new Promise((resolve) => setTimeout(resolve, 300))]);
        if (disposed) {
          return;
        }
        if (context.state === "running" && intent.current === "playing") {
          await selected.play();
        } else {
          setAudioBlocked(context.state !== "running");
          setState("paused");
        }
      } catch (cause) {
        if (!disposed) {
          void reportFailure("start", cause, current);
        }
      }
    };
    void start();
    return () => {
      disposed = true;
      nativeFullscreen.current?.destroy();
      nativeFullscreen.current = null;
      audioOutput.current = null;
      activePlayer.current = null;
      pendingCommand.current = null;
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
      context.removeEventListener("statechange", audioChanged);
      if (audioSession?.type === "playback" && previousAudioType) {
        audioSession.type = previousAudioType;
      }
      // The engine owns its players and bounds their shutdown before terminating its worker.
      void engine?.destroy();
      void context.close();
    };
  }, [playbackSource, unavailable, attempt, mediaKey]);

  latest.current = { duration, mediaKey, position: time };
  useEffect(() => {
    const sessionId = playbackSessionId.current;
    const save = async () => {
      const progress = latest.current;
      if (progress.duration <= 0 || progress.mediaKey !== mediaKey) {
        return;
      }
      sequence.current += 1;
      const currentSequence = sequence.current;
      await api.playback.positions({ mediaKey }).put({
        duration: progress.duration,
        position: progress.position,
        sequence: currentSequence,
        sessionId,
      });
    };
    const timer = setInterval(() => void save(), 5000);
    return () => {
      clearInterval(timer);
      void save();
    };
  }, [mediaKey]);
  useEffect(() => {
    if (
      remoteEpisode &&
      completionAccount &&
      duration > 0 &&
      time >= duration * 0.9 &&
      !completionDismissed
    ) {
      setCompletedPrompt(true);
    }
  }, [remoteEpisode, completionAccount, duration, time, completionDismissed]);

  const isBuffering = buffering < 1;
  useEffect(() => {
    if (!isBuffering) {
      setShowBuffering(false);
      return;
    }
    // Short cache refills after seeking should not flash a loading overlay.
    const timer = setTimeout(() => setShowBuffering(true), 250);
    return () => clearTimeout(timer);
  }, [isBuffering]);

  useEffect(() => {
    if (!seekFeedback) {
      return;
    }
    const timer = setTimeout(() => setSeekFeedback(null), 850);
    return () => clearTimeout(timer);
  }, [seekFeedback]);

  useEffect(() => {
    const fullscreenDocument = document as Document & { webkitFullscreenElement?: Element };
    const changed = () => {
      setFullscreen(
        (document.fullscreenElement ?? fullscreenDocument.webkitFullscreenElement) ===
          shell.current || !!nativeFullscreen.current?.video.webkitDisplayingFullscreen
      );
      setIdle(false);
    };
    document.addEventListener("fullscreenchange", changed);
    document.addEventListener("webkitfullscreenchange", changed);
    return () => {
      document.removeEventListener("fullscreenchange", changed);
      document.removeEventListener("webkitfullscreenchange", changed);
    };
  }, []);

  useEffect(() => {
    const target = canvas.current;
    const context = audio.current;
    const output = audioOutput.current;
    const video = document.createElement("video") as HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
    };
    if (
      !(
        player &&
        target &&
        context &&
        output &&
        video.webkitEnterFullscreen &&
        target.captureStream
      )
    ) {
      return;
    }
    const container = shell.current as HTMLDivElement & { webkitRequestFullscreen?: unknown };
    if (document.fullscreenEnabled || container.webkitRequestFullscreen) {
      return;
    }
    let bridge: CanvasVideoFullscreen | null = null;
    const prepare = async () => {
      try {
        bridge = new CanvasVideoFullscreen(
          target,
          player,
          context,
          output,
          (active) => {
            setFullscreen(active);
            setIdle(false);
          },
          (cause) => {
            setFullscreenNotice(errorMessage(cause, "Unable to control full screen playback."));
            setIdle(false);
          }
        );
        nativeFullscreen.current = bridge;
        await bridge.prepare();
      } catch (cause) {
        if (nativeFullscreen.current !== bridge) {
          return;
        }
        setFullscreenNotice(errorMessage(cause, "Unable to prepare full screen video."));
      }
    };
    void prepare();
    return () => {
      if (nativeFullscreen.current === bridge) {
        nativeFullscreen.current = null;
        bridge?.destroy();
      }
    };
  }, [player]);

  useEffect(() => {
    if (state === "error") {
      nativeFullscreen.current?.destroy();
      nativeFullscreen.current = null;
    }
  }, [state]);

  useEffect(() => {
    if (state !== "playing" || idle || trackMenuOpen) {
      return;
    }
    const timer = setTimeout(() => setIdle(true), 2500);
    return () => clearTimeout(timer);
  }, [idle, state, trackMenuOpen]);

  const toggle = async () => {
    if (!player || pendingCommand.current || state === "error") {
      return;
    }
    const selected = player;
    const command = Symbol("playback-command");
    pendingCommand.current = command;
    const pause = selected.state === "playing" && audio.current?.state === "running";
    const expectedState = pause ? "paused" : "playing";
    const changed = Promise.withResolvers<void>();
    const unsubscribe = selected.on("statechange", (next) => {
      if (next === expectedState) {
        changed.resolve();
      }
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          if (pause) {
            await selected.pause();
          } else {
            // Read the context itself: React may not have received its statechange yet.
            if (audio.current && audio.current.state !== "running") {
              await audio.current.resume();
            }
            if (state === "ended") {
              await selected.seek(0);
            }
            await selected.play();
          }
          if (selected.state === expectedState) {
            changed.resolve();
          }
          await changed.promise;
        })(),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new Error("The player stopped responding. Retry to reconnect.")),
            8000
          );
        }),
      ]);
    } catch (cause) {
      if (activePlayer.current === selected) {
        void reportFailure(pause ? "pause" : "play", cause, selected);
      }
    } finally {
      clearTimeout(deadline);
      unsubscribe();
      changed.resolve();
      if (pendingCommand.current === command) {
        pendingCommand.current = null;
      }
    }
  };
  const toggleFullscreen = async () => {
    setIdle(false);
    setFullscreenNotice(null);
    const target = shell.current as
      | (HTMLDivElement & {
          webkitRequestFullscreen?: () => Promise<void> | void;
        })
      | null;
    const fullscreenDocument = document as Document & {
      webkitFullscreenElement?: Element;
      webkitExitFullscreen?: () => Promise<void> | void;
    };
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (fullscreenDocument.webkitFullscreenElement) {
        await fullscreenDocument.webkitExitFullscreen?.();
      } else if (target?.requestFullscreen && document.fullscreenEnabled) {
        await target.requestFullscreen();
      } else if (target?.webkitRequestFullscreen) {
        await target.webkitRequestFullscreen();
      } else if (nativeFullscreen.current) {
        if (fullscreen) {
          nativeFullscreen.current.exit();
        } else if (!(await nativeFullscreen.current.enter())) {
          setFullscreenNotice("Full screen video is getting ready. Tap full screen again.");
        }
      } else {
        setFullscreenNotice("Full screen is unavailable in this browser.");
      }
    } catch (cause) {
      setFullscreenNotice(errorMessage(cause, "Unable to enter full screen. Try again."));
    }
  };

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        !player ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        (event.target instanceof Element &&
          event.target.closest(
            'input, select, textarea, [contenteditable]:not([contenteditable="false"]), [role="combobox"], [role="listbox"], [role="option"], [role="menu"]'
          )) ||
        ((event.key === " " || event.key === "Enter") &&
          event.target instanceof Element &&
          event.target.closest("button"))
      ) {
        return;
      }
      setIdle(false);
      if (event.key === " " || event.key === "k") {
        event.preventDefault();
        void toggle();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const from = player.currentTime;
        const target = Math.min(
          Math.max(from + (event.key === "ArrowLeft" ? -10 : 10), 0),
          duration || Number.POSITIVE_INFINITY
        );
        const seconds = Math.round(target - from);
        if (seconds === 0) {
          return;
        }
        const at = performance.now();
        setSeekFeedback((previous) => ({
          at,
          seconds:
            previous && at - previous.at < 850 && Math.sign(previous.seconds) === Math.sign(seconds)
              ? previous.seconds + seconds
              : seconds,
          sequence: (previous?.sequence ?? 0) + 1,
        }));
        setScrub(null);
        void player.seek(target);
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
  const retry = async () => {
    try {
      if (retrySource) {
        const grant = await retrySource();
        setPlaybackSource(grant.url);
        setTemporaryLink(grant);
      }
      setAttempt((value) => value + 1);
    } catch (cause) {
      setError(errorMessage(cause, "Unable to reconnect to this source"));
    }
  };
  const externalPlayback = async () => {
    try {
      if (session?.capabilities.hostNative && !remoteEpisode) {
        await openExternally.mutateAsync({});
        return;
      }
      let grant = temporaryLink;
      if (!(remoteEpisode || grant)) {
        const { data, error: failure } = await api["media-links"].post({
          fileIndex: index,
          torrentId,
        });
        if (failure) {
          throw failure;
        }
        grant = data;
        setTemporaryLink(data);
      }
      await navigator.clipboard.writeText(
        new URL(grant?.url ?? playbackSource, window.location.href).href
      );
      setLinkNotice(
        `Temporary playback link copied. Anyone with it can play this file until ${grant ? new Date(grant.expiresAt).toLocaleString() : "it expires"}.`
      );
    } catch (cause) {
      setLinkNotice(errorMessage(cause, "Unable to copy the playback link"));
    }
  };
  const controlsVisible =
    !idle || state !== "playing" || audioBlocked || trackMenuOpen || !!fullscreenNotice;

  return (
    <div
      className="media-player fixed inset-0 z-50 flex select-none flex-col bg-black text-white"
      data-idle={!controlsVisible}
      onPointerMove={(event) => {
        if (event.pointerType === "mouse") {
          setIdle(false);
        }
      }}
      ref={shell}
      style={{ cursor: controlsVisible ? "default" : "none" }}
    >
      <canvas
        aria-label={name}
        className="absolute inset-0 size-full"
        onClick={() => {
          if (pointerType.current === "touch" || pointerType.current === "pen") {
            setIdle((value) => !value);
          } else {
            void toggle();
          }
        }}
        onDoubleClick={() => {
          if (pointerType.current === "mouse") {
            void toggleFullscreen();
          }
        }}
        onPointerDown={(event) => {
          pointerType.current = event.pointerType;
        }}
        ref={canvas}
      />
      <div aria-atomic="true" aria-live="polite" className="pointer-events-none absolute inset-0">
        {seekFeedback ? (
          <div
            className="player-seek-feedback"
            data-direction={seekFeedback.seconds < 0 ? "backward" : "forward"}
            key={seekFeedback.sequence}
          >
            {seekFeedback.seconds < 0 ? <ChevronsLeftIcon /> : <ChevronsRightIcon />}
            <span>
              {seekFeedback.seconds > 0 ? "+" : "−"}
              {Math.abs(seekFeedback.seconds)} s
            </span>
          </div>
        ) : null}
      </div>
      <div
        className="player-header pointer-events-none absolute inset-x-0 top-0 flex items-center gap-3 bg-linear-to-b from-black/70 to-transparent p-4 transition-opacity"
        inert={!controlsVisible}
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
        <h1 className="truncate font-medium text-sm">
          {name}
          {serverName ? ` · ${serverName}` : ""}
        </h1>
      </div>
      {state === "loading" ||
      audioBlocked ||
      state === "error" ||
      (isBuffering && showBuffering) ? (
        <div className="absolute inset-0 grid place-items-center p-6">
          {state === "loading" ? (
            <LoaderCircleIcon aria-label="Loading" className="size-10 animate-spin text-white/70" />
          ) : null}
          {isBuffering &&
          showBuffering &&
          state !== "loading" &&
          state !== "error" &&
          !audioBlocked ? (
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
                  <Button onClick={() => void retry()} variant="secondary">
                    Retry
                  </Button>
                )}
                <Button onClick={() => window.location.assign(back)} variant="secondary">
                  Back
                </Button>
                <Button onClick={() => void externalPlayback()}>
                  <ExternalLinkIcon data-icon="inline-start" />
                  {session?.capabilities.hostNative && !remoteEpisode
                    ? "Open with system player on this computer"
                    : "Copy temporary playback link"}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {completedPrompt && remoteEpisode && completionAccount ? (
        <div
          aria-label="Update your AniList progress"
          className="absolute inset-x-4 top-20 mx-auto flex max-w-lg flex-col gap-3 rounded-lg bg-black/90 p-5"
          role="dialog"
        >
          <p>
            Mark episode {remoteEpisode.episode} watched on {completionAccount.name}? This updates
            your personal Tofu, where you opened the player.
          </p>
          {completionError ? <p role="alert">{completionError}</p> : null}
          <Button
            onClick={async () => {
              const { error: failure } = await api.anilist
                .entries({ mediaId: remoteEpisode.mediaId })
                .episodes({ episode: remoteEpisode.episode })
                .put({ accountId: completionAccount.id, completed: true });
              if (failure) {
                setCompletionError(errorMessage(failure, "Unable to update your AniList progress"));
                return;
              }
              setCompletionDismissed(true);
              setCompletedPrompt(false);
            }}
          >
            Mark as watched
          </Button>
          <Button
            onClick={() => {
              setCompletionDismissed(true);
              setCompletedPrompt(false);
            }}
            variant="secondary"
          >
            Keep my progress unchanged
          </Button>
        </div>
      ) : null}
      {linkNotice ? (
        <div
          className="absolute inset-x-4 top-20 mx-auto flex max-w-lg flex-col gap-3 rounded-lg bg-black/90 p-5"
          role="status"
        >
          <p>{linkNotice}</p>
          <Button onClick={() => setLinkNotice(null)} variant="secondary">
            Close
          </Button>
        </div>
      ) : null}
      <div
        className="player-controls absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-linear-to-t from-black/80 to-transparent px-4 pt-10 pb-3 transition-opacity"
        inert={!(controlsVisible && player)}
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
        <div className="player-toolbar flex items-center gap-2 text-sm">
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
            className="player-volume w-24 accent-white"
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
          <span className="player-time shrink-0 whitespace-nowrap font-mono text-white/80 text-xs tabular-nums">
            {clock(position)} / {clock(duration)}
          </span>
          <div className="player-track-controls ml-auto flex min-w-0 items-center gap-2">
            {audioTracks.length > 1 ? (
              <Select
                items={audioTracks.map((track) => ({ label: trackLabel(track), value: track.id }))}
                onOpenChange={setTrackMenuOpen}
                onValueChange={(value) => {
                  if (value !== null) {
                    preferences.current.audio = value;
                    void player?.selectTrack(value);
                  }
                }}
                value={audioTracks.find((track) => track.selected)?.id ?? null}
              >
                <SelectTrigger aria-label="Audio track" className="min-w-0 max-w-56" size="sm">
                  <HeadphonesIcon />
                  <SelectValue className="truncate" placeholder="Audio track" />
                </SelectTrigger>
                <SelectContent
                  align="end"
                  alignItemWithTrigger={false}
                  className="player-track-menu"
                  container={shell}
                  side="top"
                  sideOffset={12}
                >
                  <SelectGroup>
                    <SelectLabel>Audio track</SelectLabel>
                    {audioTracks.map((track) => (
                      <SelectItem key={track.id} value={track.id}>
                        {trackLabel(track)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : null}
            {textTracks.length > 0 ? (
              <Select
                items={[
                  { label: "Subtitles off", value: "" },
                  ...textTracks.map((track) => ({ label: trackLabel(track), value: track.id })),
                ]}
                onOpenChange={setTrackMenuOpen}
                onValueChange={(value) => {
                  if (value !== null) {
                    preferences.current.text = value;
                    void (value ? player?.selectTrack(value) : player?.disableTrack("text"));
                  }
                }}
                value={textTracks.find((track) => track.selected)?.id ?? ""}
              >
                <SelectTrigger aria-label="Subtitles" className="min-w-0 max-w-56" size="sm">
                  <CaptionsIcon />
                  <SelectValue className="truncate" />
                </SelectTrigger>
                <SelectContent
                  align="end"
                  alignItemWithTrigger={false}
                  className="player-track-menu"
                  container={shell}
                  side="top"
                  sideOffset={12}
                >
                  <SelectGroup>
                    <SelectLabel>Subtitles</SelectLabel>
                    <SelectItem value="">Subtitles off</SelectItem>
                    {textTracks.map((track) => (
                      <SelectItem key={track.id} value={track.id}>
                        {trackLabel(track)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : null}
            <Button
              aria-label={
                session?.capabilities.hostNative && !remoteEpisode
                  ? "Open with system player on this computer"
                  : "Copy temporary playback link"
              }
              className="text-white hover:bg-white/15 hover:text-white"
              onClick={() => void externalPlayback()}
              size="icon"
              variant="ghost"
            >
              <ExternalLinkIcon />
            </Button>
            <Button
              aria-label={fullscreen ? "Exit full screen" : "Full screen"}
              aria-pressed={fullscreen}
              className="text-white hover:bg-white/15 hover:text-white"
              onClick={() => void toggleFullscreen()}
              size="icon"
              variant="ghost"
            >
              {fullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
            </Button>
          </div>
        </div>
        {fullscreenNotice ? (
          <p className="text-sm text-white/80" role="status">
            {fullscreenNotice}
          </p>
        ) : null}
      </div>
    </div>
  );
}
