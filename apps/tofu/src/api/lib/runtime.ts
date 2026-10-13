import type { ApplicationRuntime } from "@teyik0/furin-electrobun/host";

export const resources = new AsyncDisposableStack();
export const runtime = { current: { kind: "server" } as ApplicationRuntime };
