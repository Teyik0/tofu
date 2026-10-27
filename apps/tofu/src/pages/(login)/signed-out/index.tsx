import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { LockKeyholeIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../../../../../package/ui/src/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../../../../../package/ui/src/ui/empty";
import { api } from "../../../lib/client";

export const route = defineRoute("/(login)/signed-out")
  .config({ mode: "ssr", query: t.Object({ reason: t.Optional(t.String()) }) })
  .head(() => ({
    meta: [
      { title: "Signed out — Tofu" },
      { content: "noindex", name: "robots" },
      { content: "no-referrer", name: "referrer" },
    ],
  }))
  .page(({ query }) => {
    const [checking, setChecking] = useState(true);
    const [unavailable, setUnavailable] = useState(false);
    useEffect(() => {
      let active = true;
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 10_000);
      const restore = async () => {
        try {
          const { error } = await api.session.get({ fetch: { signal: controller.signal } });
          if (!active) {
            return;
          }
          if (error) {
            setUnavailable(error.status !== 401);
            return;
          }
          window.location.replace("/");
        } catch {
          if (active) {
            setUnavailable(true);
          }
        } finally {
          clearTimeout(deadline);
          if (active) {
            setChecking(false);
          }
        }
      };
      void restore();
      return () => {
        active = false;
        clearTimeout(deadline);
        controller.abort();
      };
    }, []);
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LockKeyholeIcon />
          </EmptyMedia>
          <EmptyTitle>
            <h1>You're signed out</h1>
          </EmptyTitle>
          <EmptyDescription>
            {query.reason === "expired"
              ? "This browser's access ended or was removed."
              : "This browser has no active session at this address."}{" "}
            Downloads on the server continue. If your session cannot be restored, ask its owner for
            a new invitation.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {checking ? <p role="status">Checking your saved session…</p> : null}
          {unavailable ? (
            <p role="status">Your session could not be checked. Try opening the library again.</p>
          ) : null}
          <Button nativeButton={false} render={<a href="/" />} variant="outline">
            Try opening the library again
          </Button>
          <Button nativeButton={false} render={<a href="/pair" />}>
            Use an invitation code
          </Button>
        </EmptyContent>
      </Empty>
    );
  });
