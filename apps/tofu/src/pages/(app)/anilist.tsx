import { ui } from "@tofu/anilist/client";
import { route as app } from "./_route";

export const route = ui.pages[0].route({ threadLayout: app });
