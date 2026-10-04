import "../styles.css";
import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => (
    <html lang="en">
      <head>
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
