import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { anilistServicePlugin } from "../anilist/plugin";
import { torrentServicePlugin } from "../torrents/plugin";
import {
  createDestinationSchema,
  destinationPresentationSchema,
  updateDestinationSchema,
} from "./model";

export const destinationsPlugin = new Elysia({ name: "tofu-destinations-api" })
  .use(torrentServicePlugin)
  .use(anilistServicePlugin)
  .use(furinSync(sync))
  .guard({ sync: false })
  .post(
    "/destinations",
    {
      body: createDestinationSchema,
    },
    async ({ torrents, torrentFolders, body }) => {
      const destination = await torrents.saveDestination(null, body);
      torrentFolders.sync();
      return destination;
    }
  )
  .put(
    "/destinations/:id",
    {
      body: updateDestinationSchema,
    },
    async ({ torrents, torrentFolders, params, body }) => {
      const destination = await torrents.saveDestination(params.id, body);
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
