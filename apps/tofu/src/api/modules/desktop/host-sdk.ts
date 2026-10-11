import type { NativeHostSdk } from "@teyik0/furin-electrobun/host";

export function desktopHostSdk(sdk: NativeHostSdk): NativeHostSdk {
  return {
    ...sdk,
    default: {
      events: {
        on: (name, handler) =>
          sdk.default.events.on(name, (event) => {
            // Tofu explicitly approves update handoff only after persisting the engine.
            // Furin's ordinary quit handler would otherwise veto and stop the backend.
            if (event.response?.allow !== true) {
              handler(event);
            }
          }),
      },
    },
  };
}
