import { dirname, join } from "node:path";
import { Schema } from "effect";

type InstanceProfile = "dev" | "release";

export function resolveAniListClient(
  profile: InstanceProfile,
  developmentClientId: string | undefined
): AniListClient {
  return profile === "release"
    ? { clientId: "9037", redirectUri: "tofu://oauth/anilist" }
    : { clientId: developmentClientId ?? "52735", redirectUri: "tofu-dev://oauth/anilist" };
}

export async function readAniListClient(
  profile: InstanceProfile,
  developmentClientId: string | undefined,
  executable: string
): Promise<AniListClient> {
  if (profile === "release" || developmentClientId !== undefined) {
    return resolveAniListClient(profile, developmentClientId);
  }
  const file = Bun.file(join(dirname(executable), "../Resources/app/bun/anilist-client.json"));
  const packaged = (await file.exists())
    ? Schema.decodeUnknownSync(Schema.Struct({ clientId: Schema.optional(Schema.String) }))(
        await file.json()
      )
    : undefined;
  return resolveAniListClient(profile, packaged?.clientId);
}

export interface AniListClient {
  clientId: string;
  redirectUri: string;
}
