import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { version } from "../package.json";

const temporary = process.env.RUNNER_TEMP;
const keychain = temporary ? join(temporary, "tofu-signing.keychain-db") : null;
async function command(args: string[]) {
  const child = Bun.spawn(args, { stderr: "inherit", stdout: "inherit" });
  if ((await child.exited) !== 0) {
    throw new Error(`Échec de ${args[0]}`);
  }
}

if (Bun.argv[2] === "validate") {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("La version doit respecter major.minor.patch");
  }
  if (process.env.EXPECTED_ARCH !== process.arch) {
    throw new Error("Architecture du runner incorrecte");
  }
  const ref = process.env.GITHUB_REF;
  if (ref?.startsWith("refs/tags/") && ref !== `refs/tags/v${version}`) {
    throw new Error("Le tag Git doit correspondre à la version de package.json");
  }
} else if (Bun.argv[2] === "signing") {
  const certificate = process.env.APPLE_CERTIFICATE_P12;
  const password = process.env.APPLE_CERTIFICATE_PASSWORD;
  const identity = process.env.ELECTROBUN_DEVELOPER_ID;
  const apiKey = process.env.APPLE_API_KEY_P8;
  if (
    certificate ||
    password ||
    identity ||
    apiKey ||
    process.env.ELECTROBUN_APPLEAPIKEY ||
    process.env.ELECTROBUN_APPLEAPIISSUER
  ) {
    if (
      !(
        certificate &&
        password &&
        identity &&
        apiKey &&
        process.env.ELECTROBUN_APPLEAPIKEY &&
        process.env.ELECTROBUN_APPLEAPIISSUER &&
        temporary &&
        keychain
      )
    ) {
      throw new Error(
        "Les six secrets de signature/notarisation Apple doivent être configurés ensemble"
      );
    }
    const secret = crypto.randomUUID();
    const p12 = join(temporary, "tofu-certificate.p12");
    const p8 = join(temporary, "tofu-notary.p8");
    await Bun.write(p12, Buffer.from(certificate, "base64"), { mode: 0o600 });
    await Bun.write(p8, apiKey, { mode: 0o600 });
    await chmod(p12, 0o600);
    await chmod(p8, 0o600);
    await command(["security", "create-keychain", "-p", secret, keychain]);
    await command(["security", "set-keychain-settings", "-lut", "21600", keychain]);
    await command(["security", "unlock-keychain", "-p", secret, keychain]);
    await command([
      "security",
      "import",
      p12,
      "-P",
      password,
      "-A",
      "-t",
      "cert",
      "-f",
      "pkcs12",
      "-k",
      keychain,
    ]);
    await command([
      "security",
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:",
      "-k",
      secret,
      keychain,
    ]);
    await command(["security", "list-keychains", "-d", "user", "-s", keychain]);
    const env = process.env.GITHUB_ENV;
    if (!env) {
      throw new Error("GITHUB_ENV manquant");
    }
    const existing = await Bun.file(env).text();
    await Bun.write(env, `${existing}\nELECTROBUN_APPLEAPIKEYPATH=${p8}\n`);
  } else {
    console.log("Aucun certificat Apple configuré : installateurs de développement non signés.");
  }
} else if (Bun.argv[2] === "cleanup") {
  if (temporary && keychain) {
    if (await Bun.file(keychain).exists()) {
      await command(["security", "delete-keychain", keychain]);
    }
    await Promise.all(
      ["tofu-certificate.p12", "tofu-notary.p8"].map((name) =>
        rm(join(temporary, name), { force: true })
      )
    );
  }
} else if (Bun.argv[2] === "publish") {
  const tag = process.env.GITHUB_REF_NAME;
  const repository = process.env.GITHUB_REPOSITORY;
  if (tag !== `v${version}` || repository !== "Teyik0/Tofu") {
    throw new Error("Tag ou dépôt de publication incorrect");
  }
  await mkdir("artifacts", { recursive: true });
  const paths = [...new Bun.Glob("*").scanSync("artifacts")]
    .filter((name) => name !== "SHA256SUMS")
    .sort();
  for (const arch of ["arm64"]) {
    if (!paths.includes(`Tofu-${version}-macos-${arch}.dmg`)) {
      throw new Error(`Installateur ${arch} manquant`);
    }
  }
  const checksums = await Promise.all(
    paths.map(
      async (name) =>
        `${Bun.SHA256.hash(await Bun.file(join("artifacts", name)).arrayBuffer(), "hex")}  ${name}`
    )
  );
  await Bun.write("artifacts/SHA256SUMS", `${checksums.join("\n")}\n`);
  await command([
    "gh",
    "release",
    "create",
    tag,
    ...paths.map((name) => join("artifacts", name)),
    "artifacts/SHA256SUMS",
    "--repo",
    repository,
    "--verify-tag",
    "--title",
    `Tofu ${version}`,
    "--generate-notes",
  ]);
} else {
  throw new Error("Commande release inconnue");
}
