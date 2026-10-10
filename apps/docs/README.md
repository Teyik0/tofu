# Tofu documentation site

A short landing page and a server-rendered documentation site built with Furin, React, Elysia, and Bun. The procedural Three.js swarm loads only on the landing page, uses a capped pixel ratio and 30 FPS, pauses out of view or in hidden tabs, and disposes its GPU resources on unmount. Reduced motion, data saving, low-memory devices, missing WebGL, and context loss retain a static CSS illustration.

Run from the repository root:

```sh
bun run dev:docs
bun run --filter @tofu/docs tscheck
bun run --filter @tofu/docs test
bun run --filter @tofu/docs build
```

The development server listens on `http://127.0.0.1:3040`. Set `PORT` to select another port. Run `bun run start` inside `apps/docs` after building to serve the production bundle.

Pages are native Furin routes under `src/pages`, with a shared root document and a documentation layout. Plugin examples follow `package/plugins` and the scaffolder templates. This keeps the site on the same route and SSR model as the desktop UI instead of adding a second frontend toolchain.
