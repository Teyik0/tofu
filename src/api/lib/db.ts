import "@teyik0/furin/server-only";
import { Context } from "effect";
import { Elysia } from "elysia";
import { Database } from "./database-layer";
import { services } from "./services-runtime";

export const db = Context.get(services, Database);

export const databasePlugin = new Elysia({ name: "tofu-database-service" }).decorate("db", db);
