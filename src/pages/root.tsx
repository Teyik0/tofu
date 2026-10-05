import "../styles.css";
import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";
import { createTofuClient } from "../client";
import { themeBootstrap } from "../theme";

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .loader(async ({ request }) => {
    const { data, error } = await createTofuClient(new URL(request.url).origin).api.settings.get();
    if (error || !data || !("theme" in data)) {
      throw new Error("The Tofu preferences are unavailable");
    }
    return { theme: data.theme };
  })
  .layout(({ children, theme }) => (
    <html
      className={theme === "dark" ? "dark" : undefined}
      data-theme={theme}
      lang="en"
      suppressHydrationWarning
    >
      <head>
        <script>{themeBootstrap}</script>
        <link href="/favicon.ico" rel="icon" sizes="16x16 32x32 48x48" />
        <link href="/public/icon.png" rel="icon" sizes="256x256" type="image/png" />
        <link href="/public/apple-touch-icon.png" rel="apple-touch-icon" sizes="180x180" />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  ));
