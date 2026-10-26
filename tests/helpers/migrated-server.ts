// The real service graph owns migrations before publishing any dependent service.
const { default: app } = await import("../../src/server");
const { instance } = await import("../../src/api/lib/instance");
app.listen({ port: instance.port });

const shutdown = async () => {
  await app.stop(true);
  process.exit(process.exitCode ?? 0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
