import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/(login)/_route")
  .config({ mode: "ssr" })
  .layout(({ children }) => (
    <main className="login-page">
      <div className="login-brand">
        <img alt="" height={32} src="/favicon.ico" width={32} />
        <span>Tofu</span>
      </div>
      {children}
    </main>
  ));
