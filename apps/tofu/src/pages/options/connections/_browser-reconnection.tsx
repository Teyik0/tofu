import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "../../../../../../package/ui/src/ui/alert";
import { Button } from "../../../../../../package/ui/src/ui/button";
import { api } from "../../../lib/client";
import { errorMessage } from "../../../lib/errors";
import type { DeviceSummary } from "./_authorized-devices";
import { QrCode } from "./_qr-code";

type RequestStatus = NonNullable<
  Awaited<
    ReturnType<ReturnType<ReturnType<typeof api.access.devices>["reconnections"]>["get"]>
  >["data"]
>;

export function BrowserReconnection({
  device,
  origin,
  onChanged,
}: {
  device: DeviceSummary;
  origin: string;
  onChanged: () => Promise<void>;
}) {
  const [request, setRequest] = useState<{ id: string; url: string } | null>(null);
  const [status, setStatus] = useState<RequestStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!request) {
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const { data, error: failure } = await api.access
          .devices({ id: device.id })
          .reconnections({ requestId: request.id })
          .get({ fetch: { signal: AbortSignal.timeout(10_000) } });
        if (!active) {
          return;
        }
        if (failure) {
          setError(errorMessage(failure, "Unable to check the connection request."));
          setStatus(null);
          setRequest(null);
          return;
        }
        setStatus(data);
        if (data.completed) {
          await onChanged();
          return;
        }
      } catch {
        if (active) {
          setError("The server could not be reached. The request still expires after one minute.");
        }
      }
      if (active) {
        timer = setTimeout(poll, 1500);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      const cancel = async () => {
        try {
          await api.access
            .devices({ id: device.id })
            .reconnections({ requestId: request.id })
            .post({ approve: false, code: "" });
        } catch {
          // A disconnected host still discards this request at its deadline.
        }
      };
      void cancel();
    };
  }, [device.id, onChanged, request]);

  return (
    <div className="flex flex-col gap-3">
      {request ? null : <QrCode label="QR code to open the server" value={origin} />}
      <p className="connections-muted">
        Authorize a new browser with {device.label}'s profile and current permissions. Existing
        connections stay signed in.
      </p>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {request && !status?.code && !status?.completed ? (
        <QrCode label="QR code to request browser access" value={request.url} />
      ) : null}
      {request && !status?.code ? (
        <p role="status">
          Scan this QR code within one minute. Scanning alone does not grant access.
        </p>
      ) : null}
      {status?.code && !status.completed ? (
        <Alert>
          <AlertDescription className="flex flex-col gap-3">
            <p>Connection requested by {status.label}. This name is supplied by the browser.</p>
            <p>Approve only if this exact code appears on the browser you are connecting:</p>
            <strong className="font-mono text-2xl tracking-widest">{status.code}</strong>
            <Button
              disabled={busy || status.approved}
              onClick={async () => {
                if (!request) {
                  return;
                }
                setBusy(true);
                setError(null);
                try {
                  const { error: failure } = await api.access
                    .devices({ id: device.id })
                    .reconnections({ requestId: request.id })
                    .post(
                      { approve: true, code: status.code ?? "" },
                      { fetch: { signal: AbortSignal.timeout(10_000) } }
                    );
                  if (failure) {
                    setError(errorMessage(failure, "Unable to approve this browser."));
                    return;
                  }
                  setStatus({ ...status, approved: true });
                } catch {
                  setError(
                    "The server could not be reached. Check the request before trying again."
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              {status.approved
                ? "Approved — waiting for browser…"
                : "Codes match — approve connection"}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setRequest(null);
                setStatus(null);
              }}
              variant="outline"
            >
              Reject request
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {status?.completed ? (
        <p role="status">Browser connected. It is listed separately in Authorized devices.</p>
      ) : null}
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const { data, error: failure } = await api.access
              .devices({ id: device.id })
              .reconnections.post({ origin }, { fetch: { signal: AbortSignal.timeout(10_000) } });
            if (failure) {
              setError(errorMessage(failure, "Unable to prepare reconnection."));
              return;
            }
            const url = new URL("/reconnect", origin);
            url.hash = new URLSearchParams({ reconnect: data.secret }).toString();
            setStatus(null);
            setRequest({ id: data.id, url: url.href });
          } catch {
            setError("The server could not be reached. No access was granted.");
          } finally {
            setBusy(false);
          }
        }}
        variant="outline"
      >
        {request ? "Generate a new QR code" : "Authorize a browser connection"}
      </Button>
    </div>
  );
}
