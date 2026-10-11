import { expect, test } from "bun:test";
import { join } from "node:path";

async function macSigning(
  release: boolean,
  identity: string | undefined,
  keyPath: string | undefined
) {
  const configPath = join(import.meta.dir, "../furin.config.ts");
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { default: config } = await import(${JSON.stringify(configPath)}); console.log(JSON.stringify(config.desktop.sdk.build.mac));`,
    ],
    {
      env: {
        ...process.env,
        ELECTROBUN_APPLEAPIKEYPATH: keyPath,
        ELECTROBUN_DEVELOPER_ID: identity,
        TOFU_RELEASE: release ? "1" : "0",
      },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(error);
  }
  const signing: { codesign: boolean; notarize: boolean } = JSON.parse(output);
  return signing;
}

test("macOS releases enable code signing without an Apple developer identity", async () => {
  const signing = await macSigning(true, undefined, undefined);
  expect(signing.codesign).toBe(true);
  expect(signing.notarize).toBe(false);
});

test("ad hoc macOS signing never attempts paid Apple notarization", async () => {
  const signing = await macSigning(true, "-", "/tmp/unused-notary-key.p8");
  expect(signing.codesign).toBe(true);
  expect(signing.notarize).toBe(false);
});

test("configured Apple identities keep optional notarization available", async () => {
  const signing = await macSigning(true, "Developer ID Application: Example", "/tmp/notary-key.p8");
  expect(signing.codesign).toBe(true);
  expect(signing.notarize).toBe(true);
});

test("development builds do not require signing credentials", async () => {
  const signing = await macSigning(false, undefined, undefined);
  expect(signing.codesign).toBe(false);
  expect(signing.notarize).toBe(false);
});
