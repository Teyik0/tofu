import { furinSync } from "@teyik0/furin/sync";
import { Elysia, ElysiaStatus, problem } from "elysia";
import { sync } from "../../../sync";
import { accessPlugin } from "../access/plugin";
import type { Caller } from "../access/service";
import { anilistServicePlugin } from "../anilist/plugin";
import { torrentServicePlugin } from "../torrents/plugin";
import type { DestinationInput } from "./model";
import {
  createDestinationSchema,
  destinationPresentationSchema,
  destinationWithinRootSchema,
  updateDestinationSchema,
} from "./model";
import { storageRootsServicePlugin } from "./plugin";
import type { StorageRoots } from "./roots";

/** Remote administrators place threads only inside storage roots and cannot watch host folders. */
async function remoteDestinationProblem(
  roots: StorageRoots,
  caller: Caller,
  input: DestinationInput
) {
  if (caller.kind === "owner") {
    return null;
  }
  if (input.autoAddTorrentFiles || input.deleteTorrentFileAfterAdd) {
    return problem(403, { detail: "Watched folders are configured on the server itself" });
  }
  if (!(await roots.contains(input.downloadPath))) {
    return problem(403, { detail: "Choose a folder inside one of the server's storage locations" });
  }
  return null;
}

export const destinationsPlugin = new Elysia({ name: "tofu-destinations-api" })
  .use(torrentServicePlugin)
  .use(anilistServicePlugin)
  .use(storageRootsServicePlugin)
  .use(accessPlugin)
  .use(furinSync(sync))
  .guard({ administration: true, idempotent: false })
  .post(
    "/destinations",
    {
      body: createDestinationSchema,
      owner: true,
    },
    async ({ caller, storageRoots, torrents, torrentFolders, body }) => {
      const denied = await remoteDestinationProblem(storageRoots, caller, body);
      if (denied) {
        return denied;
      }
      const destination = await torrents.saveDestination(null, body);
      if (destination instanceof ElysiaStatus) {
        return destination;
      }
      torrentFolders.sync();
      return destination;
    }
  )
  .put(
    "/destinations/:id",
    {
      body: updateDestinationSchema,
      owner: true,
    },
    async ({ caller, storageRoots, torrents, torrentFolders, params, body }) => {
      const denied = await remoteDestinationProblem(storageRoots, caller, body);
      if (denied) {
        return denied;
      }
      const destination = await torrents.saveDestination(params.id, body);
      if (destination instanceof ElysiaStatus) {
        return destination;
      }
      torrentFolders.sync();
      return destination;
    }
  )
  .post(
    "/destinations/within-root",
    {
      body: destinationWithinRootSchema,
    },
    async ({ storageRoots, torrents, torrentFolders, body }) => {
      const downloadPath = await storageRoots.resolveFolder(body.rootId, body.folder);
      if (downloadPath instanceof ElysiaStatus) {
        return downloadPath;
      }
      const destination = await torrents.saveDestination(body.id ?? null, {
        downloadPath,
        moveFiles: body.moveFiles,
        name: body.name,
      });
      if (destination instanceof ElysiaStatus) {
        return destination;
      }
      torrentFolders.sync();
      return destination;
    }
  )
  .patch(
    "/destinations/:id",
    {
      body: destinationPresentationSchema,
    },
    ({ torrents, params, body }) => torrents.updateDestinationPresentation(params.id, body)
  )
  .delete(
    "/destinations/:id",
    async ({ torrents, torrentFolders, db, automation, anilist, params }) => {
      const result = await torrents.removeDestination(params.id);
      if (result instanceof ElysiaStatus) {
        return result;
      }
      torrentFolders.sync();
      db.transaction((tx) => {
        automation.reassignDestination(tx, result.removed);
        anilist.reassignDestination(result.removed, tx);
      });
      automation.refreshState();
      anilist.refreshState();
      return result;
    }
  );
