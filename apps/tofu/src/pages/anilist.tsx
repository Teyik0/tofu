import "../lib/client";
import { ui } from "@tofu/anilist/client";
import { route as threadLayout } from "./(app)/_route";

export const route = ui.pages[0].route({ threadLayout });
