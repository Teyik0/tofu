import "@teyik0/furin/server-only";
import { eq } from "drizzle-orm";
import { problem } from "elysia";
import { linkedServers } from "../../../db/schema";
import type { TofuDatabase } from "../../lib/db";
import { PROTOCOL_MAJOR } from "../access/service";
import { animeEpisodeOffset, localAnimeSearch } from "../anilist/releases";
import type { AniListEntry } from "../anilist/types";
import type { AvailabilityQuery, EpisodeSource } from "./availability";

const DEADLINE = 4000;
const CACHE_TTL = 60_000;
const STALE_TTL = 10 * 60_000;
const MAX_LINKS = 8;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

type LinkedServer = typeof linkedServers.$inferSelect;

export type LinkAvailability =
  | { state: "available" | "none"; checkedAt: number; sources: EpisodeSource[] }
  | { state: "offline"; checkedAt: number | null; sources: EpisodeSource[] }
  | { state: "revoked" | "identity-changed" | "incompatible"; checkedAt: number; sources: [] };

interface LinkedLibrariesOptions {
  db: TofuDatabase;
  now: () => number;
  /** This server's own identity, which it must never link to. */
  serverId: () => string;
}

/**
 * HTTPS origin of another server. Plain HTTP is accepted only on this computer (an SSH tunnel or a
 * second local instance), where no network can observe the credential.
 */
function serverOrigin(address: string) {
  const url = URL.parse(address.includes("://") ? address : `https://${address}`);
  if (!url || url.username || url.password) {
    return null;
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    return url.origin;
  }
  return null;
}

/**
 * Servers this server uses as playback sources. It holds a link credential issued by each of
 * them (a Playback device by default) and never shares its own AniList account with them.
 */
export class LinkedLibraries {
  private readonly options: LinkedLibrariesOptions;
  private readonly cache = new Map<string, { at: number; sources: EpisodeSource[] }>();

  constructor(options: LinkedLibrariesOptions) {
    this.options = options;
  }

  list() {
    return this.options.db
      .select()
      .from(linkedServers)
      .all()
      .map((link) => ({
        createdAt: link.createdAt,
        id: link.id,
        lastCheckedAt: link.lastCheckedAt,
        name: link.name,
        origin: link.origin,
        serverId: link.serverId,
        state: link.state,
      }));
  }

  private async descriptor(origin: string) {
    const response = await fetch(`${origin}/.well-known/tofu`, {
      redirect: "error",
      signal: AbortSignal.timeout(DEADLINE),
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as {
      name?: unknown;
      product?: unknown;
      protocol?: { major?: unknown };
      serverId?: unknown;
    };
    if (
      body.product !== "tofu" ||
      typeof body.serverId !== "string" ||
      typeof body.name !== "string"
    ) {
      return null;
    }
    return {
      compatible: body.protocol?.major === PROTOCOL_MAJOR,
      name: body.name,
      serverId: body.serverId,
    };
  }

  /** Redeems an invitation from another server as a linked-server device. */
  async link(input: { address: string; code?: string; label: string; secret?: string }) {
    if (this.list().length >= MAX_LINKS) {
      return problem(409, { detail: "Remove a linked library before adding another" });
    }
    const origin = serverOrigin(input.address);
    if (!origin) {
      return problem(400, { detail: "Enter the server's HTTPS address" });
    }
    let descriptor: Awaited<ReturnType<LinkedLibraries["descriptor"]>>;
    try {
      descriptor = await this.descriptor(origin);
    } catch {
      return problem(502, {
        detail: "This server could not be reached securely. Check its address and certificate",
      });
    }
    if (!descriptor) {
      return problem(502, { detail: "This address is not a Tofu server" });
    }
    if (!descriptor.compatible) {
      return problem(409, { detail: "This server runs an incompatible Tofu version" });
    }
    if (descriptor.serverId === this.options.serverId()) {
      return problem(400, { detail: "This is the current server" });
    }
    if (this.list().some((existing) => existing.serverId === descriptor.serverId)) {
      return problem(409, { detail: `${descriptor.name} is already linked` });
    }
    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
    let response: Response;
    try {
      response = await fetch(`${origin}/api/auth/pair`, {
        body: JSON.stringify({
          code: input.code,
          kind: "server",
          label: input.label,
          nonce,
          secret: input.secret,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(DEADLINE * 2),
      });
    } catch {
      return problem(502, { detail: `${descriptor.name} did not answer. Try again` });
    }
    const body = (await response.json()) as {
      detail?: string;
      device?: { id: string };
      server?: { id: string };
      token?: string;
    };
    if (!response.ok) {
      return problem(response.status === 410 ? 410 : 403, {
        detail: body.detail ?? "The invitation was refused",
      });
    }
    if (!(body.token && body.device && body.server?.id === descriptor.serverId)) {
      return problem(502, { detail: "The server answered with an unexpected identity" });
    }
    const link = {
      createdAt: this.options.now(),
      credential: body.token,
      deviceId: body.device.id,
      id: crypto.randomUUID(),
      lastCheckedAt: this.options.now(),
      name: descriptor.name,
      origin,
      serverId: descriptor.serverId,
      state: "active" as const,
    };
    this.options.db.insert(linkedServers).values(link).run();
    return {
      createdAt: link.createdAt,
      id: link.id,
      lastCheckedAt: link.lastCheckedAt,
      name: link.name,
      origin: link.origin,
      serverId: link.serverId,
      state: link.state,
    };
  }

  /** Forgets a link here and asks the other server to end its device; reports whether it did. */
  async unlink(id: string) {
    const link = this.find(id);
    if (!link) {
      return problem(404, { detail: "Linked server not found" });
    }
    let revokedRemotely = false;
    try {
      const response = await fetch(`${link.origin}/api/auth/logout`, {
        headers: { authorization: `Bearer ${link.credential}` },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(DEADLINE),
      });
      revokedRemotely = response.ok || response.status === 401;
    } catch {
      revokedRemotely = false;
    }
    this.options.db.delete(linkedServers).where(eq(linkedServers.id, id)).run();
    return { removed: true as const, revokedRemotely };
  }

  private find(id: string) {
    return this.options.db.select().from(linkedServers).where(eq(linkedServers.id, id)).get();
  }

  private mark(link: LinkedServer, state: LinkedServer["state"]) {
    this.options.db
      .update(linkedServers)
      .set({ lastCheckedAt: this.options.now(), state })
      .where(eq(linkedServers.id, link.id))
      .run();
  }

  /** Confirms the address still serves the linked identity before any credential is sent. */
  private async verify(link: LinkedServer) {
    const descriptor = await this.descriptor(link.origin);
    if (!descriptor) {
      return "offline" as const;
    }
    if (descriptor.serverId !== link.serverId) {
      this.mark(link, "identity-changed");
      return "identity-changed" as const;
    }
    if (!descriptor.compatible) {
      return "incompatible" as const;
    }
    return "ok" as const;
  }

  private async query(link: LinkedServer, query: AvailabilityQuery): Promise<LinkAvailability> {
    const now = this.options.now();
    const key = `${link.id}:${JSON.stringify(query)}`;
    const cached = this.cache.get(key);
    if (cached && now - cached.at < CACHE_TTL) {
      return {
        checkedAt: cached.at,
        sources: cached.sources,
        state: cached.sources.length ? "available" : "none",
      };
    }
    const offline = (): LinkAvailability =>
      cached && now - cached.at < STALE_TTL
        ? { checkedAt: cached.at, sources: cached.sources, state: "offline" }
        : { checkedAt: null, sources: [], state: "offline" };
    if (link.state !== "active") {
      return { checkedAt: link.lastCheckedAt ?? now, sources: [], state: link.state };
    }
    try {
      const verified = await this.verify(link);
      if (verified !== "ok") {
        return verified === "offline"
          ? offline()
          : { checkedAt: now, sources: [], state: verified };
      }
      const response = await fetch(`${link.origin}/api/library/availability`, {
        body: JSON.stringify({ queries: [query] }),
        headers: {
          authorization: `Bearer ${link.credential}`,
          "content-type": "application/json",
        },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(DEADLINE),
      });
      if (response.status === 401 || response.status === 403) {
        this.mark(link, "revoked");
        return { checkedAt: now, sources: [], state: "revoked" };
      }
      if (!response.ok) {
        return offline();
      }
      const body = (await response.json()) as { results: { sources: EpisodeSource[] }[] };
      const sources = body.results[0]?.sources ?? [];
      if (this.cache.size >= 1024) {
        const first = this.cache.keys().next().value;
        if (first) {
          this.cache.delete(first);
        }
      }
      this.cache.set(key, { at: now, sources });
      this.mark(link, "active");
      return { checkedAt: now, sources, state: sources.length ? "available" : "none" };
    } catch {
      return offline();
    }
  }

  /** One request per linked server for a whole anime, never one per episode card. */
  async availability(query: AvailabilityQuery) {
    const links = this.options.db.select().from(linkedServers).all().slice(0, MAX_LINKS);
    const results = await Promise.all(links.map((link) => this.query(link, query)));
    return links.map((link, index) => ({
      link: { id: link.id, name: link.name, origin: link.origin },
      ...(results[index] as LinkAvailability),
    }));
  }

  /**
   * Availability for an anime of this server's own AniList list: the search plan (titles,
   * season, part and continuous numbering) comes from this server, not from the client.
   */
  async availabilityForAnime(query: AvailabilityQuery, mediaId: number, entries: AniListEntry[]) {
    const entry = entries.find((item) => item.mediaId === mediaId);
    if (!entry) {
      return problem(409, {
        detail: "Reload this anime from your AniList list before checking remote sources",
      });
    }
    const plan = localAnimeSearch(entry);
    return await this.availability({
      ...query,
      episodeOffset: animeEpisodeOffset(entry, entries),
      part: plan.part ?? query.part ?? 1,
      season: plan.season ?? query.season ?? 1,
      titles: [...new Set([...entry.aliases, entry.title, ...plan.seriesTitles])].slice(0, 12),
    });
  }

  async revokePlayback(id: string, playbackId: string) {
    const link = this.find(id);
    if (link?.state !== "active") {
      return problem(404, { detail: "Linked server not found" });
    }
    try {
      if ((await this.verify(link)) !== "ok") {
        return problem(503, { detail: "The linked server is unavailable" });
      }
      const response = await fetch(`${link.origin}/api/media-links/revoke`, {
        body: JSON.stringify({ id: playbackId }),
        headers: { authorization: `Bearer ${link.credential}`, "content-type": "application/json" },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(DEADLINE),
      });
      if (!response.ok) {
        return problem(409, { detail: "The linked server could not revoke this playback link" });
      }
      return { revoked: true as const };
    } catch {
      return problem(503, {
        detail: "The linked server is unreachable. The playback link will expire automatically",
      });
    }
  }

  /** Asks the linked server for a file-scoped playback link the viewing player reads directly. */
  async play(id: string, torrentId: string, fileIndex: number) {
    const link = this.find(id);
    if (link?.state !== "active") {
      return problem(404, { detail: "Linked server not found" });
    }
    let response: Response;
    try {
      if ((await this.verify(link)) !== "ok") {
        return problem(503, { detail: `${link.name} is not available` });
      }
      response = await fetch(`${link.origin}/api/media-links`, {
        body: JSON.stringify({ fileIndex, torrentId }),
        headers: {
          authorization: `Bearer ${link.credential}`,
          "content-type": "application/json",
        },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(DEADLINE),
      });
    } catch {
      return problem(503, { detail: `${link.name} is not reachable` });
    }
    if (response.status === 401 || response.status === 403) {
      this.mark(link, "revoked");
      return problem(403, { detail: `${link.name} removed access for this server` });
    }
    if (!response.ok) {
      return problem(404, { detail: "This file is no longer available" });
    }
    const body = (await response.json()) as {
      expiresAt: number;
      id: string;
      url: string;
      file: { index: number; length: number; name: string; complete: boolean };
    };
    // The linked server builds the URL from its own address; it must stay on that origin.
    if (URL.parse(body.url)?.origin !== link.origin) {
      return problem(502, { detail: "The linked server answered with another address" });
    }
    return {
      expiresAt: body.expiresAt,
      file: body.file,
      id: body.id,
      server: { id: link.serverId, name: link.name },
      url: body.url,
    };
  }
}
