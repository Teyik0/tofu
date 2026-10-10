import type {
  Application,
  ApplicationPlatform,
  ApplicationProvider,
  ApplicationState,
  CoreApplication,
} from "../../types";

// Only lifecycle boundaries change generations; handlers receive a complete application.
export class ApplicationHost implements ApplicationProvider {
  #current: ApplicationState = { phase: "stopped" };
  #coreReady = this.#deferred<CoreApplication>();
  #applicationReady = this.#deferred<Application>();
  #starting: Promise<CoreApplication> | null = null;
  #stopping: Promise<void> | null = null;
  #controller = new AbortController();

  #deferred<Value>() {
    const deferred = Promise.withResolvers<Value>();
    // Startup owns the failure; transports may subscribe to readiness afterwards.
    void deferred.promise.catch(() => undefined);
    return deferred;
  }

  get state() {
    return this.#current;
  }
  get core() {
    return this.#coreReady.promise;
  }
  get application() {
    return this.#applicationReady.promise;
  }

  async prepare(open: (signal: AbortSignal) => Promise<CoreApplication>, signal: AbortSignal) {
    await this.#stopping;
    signal.throwIfAborted();
    const controller = this.#controller;
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
      signal: controller.signal,
    });
    this.#starting ??= this.#initialize(open);
    return this.#starting;
  }

  async #initialize(open: (signal: AbortSignal) => Promise<CoreApplication>) {
    this.#current = { phase: "starting" };
    try {
      const core = await open(this.#controller.signal);
      if (this.#controller.signal.aborted) {
        await core.close();
        this.#controller.signal.throwIfAborted();
      }
      this.#coreReady.resolve(core);
      return core;
    } catch (error) {
      this.#coreReady.reject(error);
      this.#applicationReady.reject(error);
      this.#current = { phase: "stopped" };
      throw error;
    }
  }

  activate(core: CoreApplication, platform: ApplicationPlatform) {
    this.#controller.signal.throwIfAborted();
    const application: Application = { ...core, platform };
    this.#current = { application, phase: "ready" };
    this.#applicationReady.resolve(application);
    core.startBackground();
  }

  stop() {
    this.#stopping ??= this.#shutdown();
    return this.#stopping;
  }

  async #shutdown() {
    this.#current = { phase: "stopping" };
    this.#controller.abort();
    this.#coreReady.reject(this.#controller.signal.reason);
    this.#applicationReady.reject(this.#controller.signal.reason);
    try {
      // A failed bootstrap has already released its partial resources.
      const core = await this.#starting?.catch(() => null);
      await core?.close();
    } finally {
      this.#starting = null;
      this.#stopping = null;
      this.#controller = new AbortController();
      this.#coreReady = this.#deferred<CoreApplication>();
      this.#applicationReady = this.#deferred<Application>();
      this.#current = { phase: "stopped" };
    }
  }
}
