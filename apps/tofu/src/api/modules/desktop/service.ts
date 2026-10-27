import { Context } from "effect";
import { services } from "../../lib/services-runtime";
import { Openings } from "./opening";

export const torrentOpenings = Context.get(services, Openings);
