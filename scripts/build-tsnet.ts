import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const output = join(
  root,
  "runtime",
  process.platform === "win32" ? "tofu-tsnet.exe" : "tofu-tsnet"
);
await mkdir(join(root, "runtime"), { recursive: true });
const build = Bun.spawn(
  ["go", "build", "-mod=readonly", "-trimpath", "-ldflags=-s -w -buildid=", "-o", output, "."],
  {
    cwd: join(root, "native/tailscale"),
    env: { ...process.env, CGO_ENABLED: "0" },
    stderr: "inherit",
    stdout: "inherit",
  }
);
if ((await build.exited) !== 0) {
  throw new Error("Embedded Tailscale build failed");
}
// Sign the additional native executable explicitly instead of assuming the SDK signs copied resources.
if (process.platform === "darwin") {
  const identity = process.env.ELECTROBUN_DEVELOPER_ID?.trim() || "-";
  const signing = Bun.spawn(
    [
      "codesign",
      "--force",
      "--sign",
      identity,
      "--options",
      "runtime",
      ...(identity === "-" ? [] : ["--timestamp"]),
      output,
    ],
    { stderr: "inherit", stdout: "inherit" }
  );
  if ((await signing.exited) !== 0) {
    throw new Error("Embedded Tailscale signing failed");
  }
  const verify = Bun.spawn(["codesign", "--verify", "--strict", output], {
    stderr: "inherit",
    stdout: "inherit",
  });
  if ((await verify.exited) !== 0) {
    throw new Error("Embedded Tailscale signature verification failed");
  }
}

const modules = Bun.spawn(["go", "list", "-m", "-f", "{{.Path}}\t{{.Version}}\t{{.Dir}}", "all"], {
  cwd: join(root, "native/tailscale"),
  stderr: "inherit",
  stdout: "pipe",
});
const [modulesExit, moduleList] = await Promise.all([
  modules.exited,
  new Response(modules.stdout).text(),
]);
if (modulesExit !== 0) {
  throw new Error("Embedded Tailscale license inventory failed");
}
const licenseFiles = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;
const notices = await Promise.all(
  moduleList
    .trim()
    .split("\n")
    .map(async (line) => {
      const [name, version, directory] = line.split("\t");
      if (!directory || name === "app.tofu/tailscale") {
        return "";
      }
      const names = (await readdir(directory)).filter((file) => licenseFiles.test(file)).sort();
      const texts = await Promise.all(
        names.map(
          async (filename) => `${filename}\n${await Bun.file(join(directory, filename)).text()}`
        )
      );
      return `${name} ${version}\n${texts.join("\n")}\n`;
    })
);
await Bun.write(
  join(root, "runtime/tofu-tsnet.licenses.txt"),
  notices.filter(Boolean).join("\n---\n\n")
);
await Bun.write(
  join(root, "runtime/tofu-tsnet.manifest.json"),
  JSON.stringify(
    {
      architecture: process.arch,
      go: "1.27.1",
      module: "tailscale.com",
      platform: process.platform,
      sha256: new Bun.CryptoHasher("sha256").update(await Bun.file(output).bytes()).digest("hex"),
      version: "v1.104.1",
    },
    null,
    2
  )
);
