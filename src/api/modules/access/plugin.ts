import "@teyik0/furin/server-only";
import { Elysia, ElysiaStatus, problem } from "elysia";
import { db } from "../../lib/database-plugin";
import { runtime } from "../../lib/runtime";
import { connections } from "../connections/plugin";
import { Devices } from "./devices";
import { rank } from "./grants";
import { Invitations } from "./invitations";
import { AccessService, type Caller, callers } from "./service";

export const access = new AccessService({
  db,
  headless: () => runtime.current.kind === "server",
  now: Date.now,
  policy: () => connections.policy(),
});
export const invitations = new Invitations({ access, db, now: Date.now });
export const devices = new Devices({ access, db, now: Date.now });

type Member = Exclude<Caller, { kind: "anonymous" }>;

function member(request: Request) {
  const caller = callers.get(request);
  if (!caller) {
    return problem(403, { detail: "This endpoint is not available during server rendering" });
  }
  if (caller.kind === "anonymous") {
    return problem(401, { detail: "Sign in to this server" });
  }
  return caller;
}

function atLeast(caller: Member, role: "management" | "administration") {
  return caller.kind === "owner" || rank(caller.device.role) >= rank(role);
}

/**
 * Route-level authorization. Each macro authenticates the caller established by network
 * admission and fails with a literal 401 or 403 that Eden types preserve. Only `playback`
 * admits in-process dispatch, so server rendering can read Playback-safe data and nothing else.
 */
export const accessPlugin = new Elysia({ name: "tofu-access" })
  .decorate("access", access)
  .decorate("devices", devices)
  .decorate("invitations", invitations)
  .macro({
    administration: {
      derive({ request }) {
        const caller = member(request);
        if (caller instanceof ElysiaStatus) {
          return caller;
        }
        if (!atLeast(caller, "administration")) {
          return problem(403, { detail: "This requires Administration access to this server" });
        }
        return { caller };
      },
    },
    management: {
      derive({ request }) {
        const caller = member(request);
        if (caller instanceof ElysiaStatus) {
          return caller;
        }
        if (!atLeast(caller, "management")) {
          return problem(403, { detail: "This requires Management access to this server" });
        }
        return { caller };
      },
    },
    owner: {
      derive({ request }) {
        const caller = member(request);
        if (caller instanceof ElysiaStatus) {
          return caller;
        }
        if (caller.kind !== "owner") {
          return problem(403, { detail: "Change this on the server itself" });
        }
        return { caller };
      },
    },
    personal: {
      derive({ request }) {
        const caller = member(request);
        if (caller instanceof ElysiaStatus) {
          return caller;
        }
        return { caller };
      },
    },
    playback: {
      derive({ request }) {
        const caller = callers.get(request);
        if (caller?.kind === "anonymous") {
          return problem(401, { detail: "Sign in to this server" });
        }
        return { caller: caller ?? ({ kind: "in-process" } as const) };
      },
    },
    public: {
      derive({ request }) {
        return { caller: callers.get(request) ?? ({ kind: "in-process" } as const) };
      },
    },
  });
