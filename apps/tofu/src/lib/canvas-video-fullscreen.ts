import type { Player } from "libvlc-wasm";

// iPhone exposes native fullscreen on video elements, while VLC renders into a canvas.
// Capture the decoded picture (including subtitles), rather than reopening the source
// in Safari, which cannot decode every container and codec supported by VLC.
export class CanvasVideoFullscreen {
  readonly video: HTMLVideoElement & {
    webkitEnterFullscreen?: () => void;
    webkitExitFullscreen?: () => void;
    webkitDisplayingFullscreen?: boolean;
  };
  private readonly picture = document.createElement("canvas");
  private readonly drawing: CanvasRenderingContext2D;
  private readonly destination: MediaStreamAudioDestinationNode;
  private readonly stream: MediaStream;
  private readonly unsubscribe?: () => void;
  private readonly canvas: HTMLCanvasElement;
  private readonly player: Player;
  private readonly context: AudioContext;
  private readonly output: GainNode;
  private readonly changed: (active: boolean) => void;
  private readonly failed: (cause: unknown) => void;
  private frame = 0;
  private active: boolean;
  private ready: boolean;
  private disposed: boolean;
  private preparing: Promise<void> | null = null;
  private priming: boolean;
  private readonly connected: boolean = false;
  private session = 0;
  private cancelPresentation?: () => void;
  private entryTimer?: ReturnType<typeof setTimeout>;

  constructor(
    canvas: HTMLCanvasElement,
    player: Player,
    context: AudioContext,
    output: GainNode,
    changed: (active: boolean) => void,
    failed: (cause: unknown) => void
  ) {
    this.active = false;
    this.ready = false;
    this.disposed = false;
    this.priming = false;
    this.canvas = canvas;
    this.player = player;
    this.context = context;
    this.output = output;
    this.changed = changed;
    this.failed = failed;
    const drawing = this.picture.getContext("2d", { alpha: false });
    if (!drawing) {
      throw new Error("Unable to prepare full screen video.");
    }
    this.drawing = drawing;
    this.video = document.createElement("video");
    this.video.setAttribute("aria-hidden", "true");
    this.video.className = "pointer-events-none absolute size-px opacity-0";
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.addEventListener("webkitbeginfullscreen", this.fullscreenChanged);
    this.video.addEventListener("webkitendfullscreen", this.ended);
    this.video.addEventListener("play", this.play);
    this.video.addEventListener("pause", this.pause);
    this.picture.width = 640;
    this.picture.height = 360;
    this.destination = context.createMediaStreamDestination();
    try {
      this.stream = this.picture.captureStream(30);
      for (const track of this.destination.stream.getAudioTracks()) {
        this.stream.addTrack(track);
      }
      output.connect(this.destination);
      this.connected = true;
      this.video.srcObject = this.stream;
      canvas.parentElement?.append(this.video);
      this.unsubscribe = player.on("ended", () => {
        if (this.active) {
          this.exit();
        }
      });
      this.draw();
    } catch (cause) {
      this.destroy();
      throw cause;
    }
  }

  async prepare() {
    if (this.ready || this.disposed) {
      return;
    }
    if (this.preparing) {
      await this.preparing;
      return;
    }
    // Reserve preparation before play(), including gesture-driven retries after
    // Safari rejects the muted warmup under its Low Power Mode policy.
    const operation = Promise.withResolvers<void>();
    this.preparing = operation.promise;
    // The owner handles its own error; this promise only coordinates other callers.
    try {
      this.draw();
      await this.video.play();
      if (!this.disposed) {
        this.ready = true;
        this.video.pause();
      }
    } catch (cause) {
      cancelAnimationFrame(this.frame);
      if (!(cause instanceof DOMException && cause.name === "NotAllowedError")) {
        this.destroy();
      }
      throw cause;
    } finally {
      this.preparing = null;
      operation.resolve();
    }
  }

  async enter() {
    if (this.disposed) {
      throw new Error("Full screen video is unavailable. Reload the player to try again.");
    }
    if (this.active) {
      return true;
    }
    if (!this.ready) {
      await this.prepare();
      // A second tap must perform native entry synchronously with fresh activation.
      return false;
    }
    this.session += 1;
    const { session } = this;
    this.active = true;
    this.priming = this.player.state !== "playing";
    try {
      this.output.disconnect(this.context.destination);
      this.video.muted = this.priming;
      this.draw();
      this.entryTimer = setTimeout(() => {
        if (this.active && this.session === session) {
          try {
            this.exit();
          } catch (cause) {
            this.failed(cause);
          }
          this.failed(new Error("The browser did not open full screen. Try again."));
        }
      }, 3000);
      this.video.webkitEnterFullscreen?.();
      if (!this.active || this.session !== session) {
        return true;
      }
      await this.present(session);
      return true;
    } catch (cause) {
      if (this.session !== session) {
        return true;
      }
      try {
        this.exit();
      } catch (exitCause) {
        this.failed(exitCause);
      }
      throw cause;
    }
  }

  private async present(session: number) {
    const interrupted = Promise.withResolvers<never>();
    const presented = Promise.withResolvers<void>();
    let callback = 0;
    let frames = 0;
    const start = this.video.currentTime;
    const frame = () => {
      // Two newly presented frames exclude a queued frame from the muted warmup.
      frames += 1;
      if (frames >= 2) {
        presented.resolve();
      } else {
        callback = this.video.requestVideoFrameCallback(frame);
      }
    };
    const progressed = () => {
      if (this.video.readyState >= 2 && this.video.currentTime > start) {
        presented.resolve();
      }
    };
    const cancel = () => {
      interrupted.reject(new DOMException("Full screen presentation was canceled.", "AbortError"));
    };
    this.cancelPresentation = cancel;
    const timer = setTimeout(() => {
      interrupted.reject(new Error("Full screen video did not present a picture. Try again."));
    }, 2000);
    try {
      // Muted playback presents the current captured picture while VLC stays paused.
      // Keep internal play/pause events away from the native-control synchronization.
      await Promise.race([this.video.play(), interrupted.promise]);
      if (this.video.requestVideoFrameCallback) {
        callback = this.video.requestVideoFrameCallback(frame);
      } else {
        this.video.addEventListener("timeupdate", progressed);
      }
      this.draw();
      await Promise.race([presented.promise, interrupted.promise]);
      if (this.active && this.session === session) {
        if (this.priming) {
          this.video.pause();
        }
        this.video.muted = false;
      }
    } finally {
      clearTimeout(timer);
      this.video.cancelVideoFrameCallback?.(callback);
      this.video.removeEventListener("timeupdate", progressed);
      if (this.cancelPresentation === cancel) {
        this.cancelPresentation = undefined;
        this.priming = false;
      }
    }
  }

  private readonly draw = () => {
    cancelAnimationFrame(this.frame);
    if (this.disposed) {
      return;
    }
    const track = this.player.tracks.find((item) => item.type === "video" && item.selected);
    const aspect =
      track?.width && track.height
        ? (track.width * (track.sarNum || 1)) / (track.height * (track.sarDen || 1))
        : 16 / 9;
    // Remove the inline player's letterboxing before capture. Otherwise a portrait
    // canvas would remain a small landscape picture inside the native landscape view.
    const width = Math.min(this.canvas.width, this.canvas.height * aspect);
    const height = width / aspect;
    const targetWidth = Math.max(1, Math.round(width));
    const targetHeight = Math.max(1, Math.round(height));
    if (this.picture.width !== targetWidth || this.picture.height !== targetHeight) {
      this.picture.width = targetWidth;
      this.picture.height = targetHeight;
    }
    this.drawing.drawImage(
      this.canvas,
      (this.canvas.width - width) / 2,
      (this.canvas.height - height) / 2,
      width,
      height,
      0,
      0,
      this.picture.width,
      this.picture.height
    );
    const capturedTrack = this.stream.getVideoTracks()[0] as
      | CanvasCaptureMediaStreamTrack
      | undefined;
    capturedTrack?.requestFrame?.();
    if (this.active || !this.ready) {
      this.frame = requestAnimationFrame(this.draw);
    }
  };

  private readonly fullscreenChanged = () => {
    clearTimeout(this.entryTimer);
    // WebKit may finish entering after a timeout already abandoned the attempt.
    if (!this.active) {
      try {
        this.video.webkitExitFullscreen?.();
      } catch (cause) {
        this.failed(cause);
      }
      return;
    }
    this.draw();
    this.changed(this.active);
  };

  exit() {
    try {
      if (this.active) {
        this.video.webkitExitFullscreen?.();
      }
    } finally {
      this.ended();
    }
  }

  private readonly ended = () => {
    this.session += 1;
    clearTimeout(this.entryTimer);
    this.cancelPresentation?.();
    if (this.active) {
      this.active = false;
      this.output.connect(this.context.destination);
    }
    cancelAnimationFrame(this.frame);
    this.video.muted = true;
    this.video.pause();
    this.changed(false);
  };

  private readonly play = async () => {
    if (!this.active || this.priming || this.video.paused || this.player.state === "playing") {
      return;
    }
    try {
      await this.player.play();
    } catch (cause) {
      this.failed(cause);
    }
  };

  private readonly pause = async () => {
    if (!this.active || this.priming || !this.video.paused || this.player.state !== "playing") {
      return;
    }
    try {
      await this.player.pause();
    } catch (cause) {
      this.failed(cause);
    }
  };

  destroy() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unsubscribe?.();
    this.video.removeEventListener("webkitbeginfullscreen", this.fullscreenChanged);
    this.video.removeEventListener("webkitendfullscreen", this.ended);
    this.video.removeEventListener("play", this.play);
    this.video.removeEventListener("pause", this.pause);
    try {
      this.exit();
    } finally {
      if (this.connected) {
        this.output.disconnect(this.destination);
      }
      for (const track of this.stream?.getTracks() ?? []) {
        track.stop();
      }
      this.video.srcObject = null;
      this.video.remove();
    }
  }
}
