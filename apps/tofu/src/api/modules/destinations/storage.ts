import { Effect } from "effect";
import "@teyik0/furin/server-only";
import { Elysia } from "elysia";
import { storageRootSchema } from "../../../../../../package/plugins/src/destination-model";
import { accessPlugin } from "../access/plugin";
import { storageRootsServicePlugin } from "./plugin";

/** Remote administrators see root names only; host paths stay with the owner. */
export const storageRootsPlugin = new Elysia({ name: "tofu-storage-roots-api" })
  .use(storageRootsServicePlugin)
  .use(accessPlugin)
  .get("/storage-roots", { administration: true }, ({ caller, storageRoots }) =>
    storageRoots.list().map((root) => ({
      id: root.id,
      name: root.name,
      path: caller.kind === "owner" ? root.path : null,
    }))
  )
  .post("/storage-roots", { body: storageRootSchema, owner: true }, ({ body, storageRoots }) =>
    Effect.runPromise(storageRoots.add(body.name, body.path))
  )
  .delete("/storage-roots/:id", { owner: true }, ({ params, storageRoots }) =>
    storageRoots.remove(params.id)
  );
