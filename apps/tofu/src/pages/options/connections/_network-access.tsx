import { CheckIcon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "../../../../../../package/ui/src/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../../../../package/ui/src/ui/alert-dialog";
import { Badge } from "../../../../../../package/ui/src/ui/badge";
import { Button } from "../../../../../../package/ui/src/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../../../../package/ui/src/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "../../../../../../package/ui/src/ui/field";
import { Input } from "../../../../../../package/ui/src/ui/input";
import { Switch } from "../../../../../../package/ui/src/ui/switch";
import { Textarea } from "../../../../../../package/ui/src/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "../../../../../../package/ui/src/ui/toggle-group";
import { api } from "../../../lib/client";
import { errorMessage } from "../../../lib/errors";
import type { ServerSession } from "../../../state/workspace";
import type { ConnectionsState } from "./index";

const WHITESPACE = /\s+/;

type Exposure = keyof ConnectionsState["exposures"];
type TailscaleStatus = NonNullable<
  Awaited<ReturnType<typeof api.connections.tailscale.check.post>>["data"]
>;

const exposureLabels: { [Key in Exposure]: string } = {
  lan: "Local network",
  proxy: "Custom HTTPS",
  tailscale: "Tailscale",
};

const stateLabels: { [State in ConnectionsState["exposures"][Exposure]["state"]]: string } = {
  failed: "Needs attention",
  off: "Off",
  ready: "On",
  starting: "Starting",
};

const tailscaleGuidance: { [State in TailscaleStatus["state"]]: string } = {
  available: "Tailscale is ready. Apply to publish Tofu at this private HTTPS address.",
  conflict: "Tofu changes nothing that it did not create.",
  "https-disabled":
    "Turn on HTTPS certificates for your tailnet in the Tailscale admin console, then check again.",
  "not-installed": "Install Tailscale on this computer and sign in, then check again.",
  ready:
    "Devices on your Tailscale network can connect. Each device still needs a Tofu invitation.",
  "signed-out": "Open Tailscale on this computer and sign in, then check again.",
};

/**
 * Local network, Tailscale and custom HTTPS are independent connections to the same server.
 * Each is turned on or off separately with Apply. Embedded Tailscale's explicit Connect action
 * runs its enrollment and HTTPS consent flow, then turns on Tailscale sharing.
 */
export function NetworkAccess({
  state,
  session,
  onChanged,
}: {
  state: ConnectionsState;
  session: ServerSession;
  onChanged: () => Promise<void>;
}) {
  const active = state.config;
  const { owner } = session.capabilities;
  const [exposure, setExposure] = useState<Exposure>(
    (["lan", "tailscale", "proxy"] as const).find((key) => active[key].enabled) ?? "lan"
  );
  const [enabled, setEnabled] = useState(active[exposure].enabled);
  const [proxyOrigin, setProxyOrigin] = useState(active.proxy.origin ?? "");
  const [trustedProxies, setTrustedProxies] = useState(active.proxy.trustedProxies.join("\n"));
  const [lanPort, setLanPort] = useState(String(active.lan.port));
  const [tailscaleMode, setTailscaleMode] = useState<"embedded" | "system">(
    active.tailscale.enabled ? active.tailscale.mode : "embedded"
  );
  const [embedded, setEmbedded] = useState<NonNullable<
    Awaited<ReturnType<typeof api.connections.tailscale.embedded.get>>["data"]
  > | null>(null);
  const [tailscale, setTailscale] = useState<TailscaleStatus | null>(null);
  const [certificate, setCertificate] = useState<NonNullable<
    Awaited<ReturnType<typeof api.connections.certificate.get>>["data"]
  > | null>(null);
  const [showingCertificate, setShowingCertificate] = useState(false);
  const [certificateAction, setCertificateAction] = useState<"create" | "download" | "show" | null>(
    null
  );
  const [checking, setChecking] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const requestedApproval = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const proxies = trustedProxies
    .split(WHITESPACE)
    .map((value) => value.trim())
    .filter(Boolean);
  const label = exposureLabels[exposure];
  const status = state.exposures[exposure];
  const dirty =
    enabled !== active[exposure].enabled ||
    (enabled &&
      ((exposure === "tailscale" &&
        tailscaleMode !== (active.tailscale.enabled ? active.tailscale.mode : "system")) ||
        (exposure === "proxy" &&
          (proxyOrigin.trim() !== (active.proxy.origin ?? "") ||
            proxies.join() !== active.proxy.trustedProxies.join())))) ||
    (exposure === "lan" && lanPort !== String(active.lan.port));

  useEffect(() => {
    if (!owner) {
      return;
    }
    let stopped = false;
    const read = async () => {
      try {
        const { data, error: failure } = await api.connections.certificate.get();
        if (stopped) {
          return;
        }
        if (failure) {
          setError(errorMessage(failure, "Unable to read the certificate"));
          return;
        }
        setCertificate(data);
      } catch (cause) {
        if (!stopped) {
          setError(errorMessage(cause, "Unable to read the certificate"));
        }
      }
    };
    void read();
    return () => {
      stopped = true;
    };
  }, [owner]);

  useEffect(() => {
    if (!connecting) {
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 10 * 60_000;
    const poll = async () => {
      try {
        const { data, error: failure } = await api.connections.tailscale.embedded.get();
        if (stopped) {
          return;
        }
        if (failure) {
          setError(errorMessage(failure, "Unable to check Tailscale"));
          setConnecting(false);
          return;
        }
        setEmbedded((previous) => ({ ...data, approvalUrl: previous?.approvalUrl }));
        if (data.state === "Running" && !data.httpsEnabled && !requestedApproval.current) {
          requestedApproval.current = true;
          const approval = await api.connections.tailscale.https.post();
          if (stopped) {
            return;
          }
          if (approval.error) {
            setError(errorMessage(approval.error, "Unable to request HTTPS authorization"));
            setConnecting(false);
            return;
          }
          setEmbedded(approval.data);
        }
        if (data.httpsEnabled && (data.state === "Running" || data.state === "ready")) {
          setBusy(true);
          try {
            const activated = await api.connections.put({
              enabled: true,
              tailscaleMode: "embedded",
              transport: "tailscale",
            });
            if (stopped) {
              return;
            }
            if (activated.error) {
              setError(errorMessage(activated.error, "Unable to enable private HTTPS"));
            } else {
              setNotice("Private HTTPS is ready. Pair a device to connect to Tofu.");
              setEmbedded({ ...data, state: "ready" });
              setEnabled(true);
              await onChanged();
            }
          } finally {
            setBusy(false);
            setConnecting(false);
          }
          return;
        }
        if (Date.now() >= deadline) {
          setError("Tailscale setup timed out. Click Connect to continue when you are ready.");
          setConnecting(false);
          return;
        }
        timer = setTimeout(poll, 1500);
      } catch (cause) {
        if (!stopped) {
          setError(errorMessage(cause, "Unable to finish Tailscale setup"));
          setConnecting(false);
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [connecting, onChanged]);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      const { data, error: failure } = await api.connections.tailscale.check.post();
      if (failure) {
        setError(errorMessage(failure, "Unable to check Tailscale"));
        return;
      }
      setTailscale(data);
    } finally {
      setChecking(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { data, error: failure } = await api.connections.put({
        enabled,
        lanPort: exposure === "lan" ? Number(lanPort) : undefined,
        proxyOrigin: exposure === "proxy" ? proxyOrigin.trim() || null : undefined,
        tailscaleMode: exposure === "tailscale" ? tailscaleMode : undefined,
        transport: exposure,
        trustedProxies: owner && exposure === "proxy" ? proxies : undefined,
      });
      if (failure) {
        setError(errorMessage(failure, `Unable to change ${label.toLowerCase()} sharing`));
        return;
      }
      const shared =
        data.config.lan.enabled || data.config.proxy.enabled || data.config.tailscale.enabled;
      setNotice(
        enabled
          ? `${label} sharing is on. Other connections are unchanged.`
          : shared
            ? `${label} sharing is off. Other connections are unchanged.`
            : "Remote access is off. Only this computer can connect."
      );
      await onChanged();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <section aria-labelledby="network-access-title" className="connections-section">
      <div className="connections-section-title">
        <h3 id="network-access-title">Network access</h3>
        <Badge variant={state.enabled ? "secondary" : "outline"}>
          {state.enabled ? "Enabled" : "Off"}
        </Badge>
      </div>
      <p className="connections-description">
        Turn on each connection separately; they can be used at the same time. Each address pairs
        devices separately, and every device needs its own invitation.
      </p>
      <ToggleGroup
        aria-label="Connection"
        className="connections-transports"
        disabled={busy || connecting || checking}
        onValueChange={([value]) => {
          if (value === "lan" || value === "tailscale" || value === "proxy") {
            setExposure(value);
            setEnabled(active[value].enabled);
            setError(null);
            setNotice(null);
          }
        }}
        value={[exposure]}
        variant="outline"
      >
        {(["lan", "tailscale", "proxy"] as const).map((key) => (
          <ToggleGroupItem key={key} value={key}>
            {exposureLabels[key]} · {stateLabels[state.exposures[key].state]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <FieldGroup className="settings-group">
        <Field className="settings-row" orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="exposure-enabled">Share over {label.toLowerCase()}</FieldLabel>
            <FieldDescription id="exposure-enabled-description">
              {status.state === "failed"
                ? status.detail
                : status.state === "starting"
                  ? "Starting…"
                  : active[exposure].enabled
                    ? "Authorized devices can connect through this connection."
                    : "Off. Other connections are not affected."}
            </FieldDescription>
          </FieldContent>
          <Switch
            aria-describedby="exposure-enabled-description"
            checked={enabled}
            disabled={busy || connecting || checking}
            id="exposure-enabled"
            onCheckedChange={setEnabled}
          />
        </Field>
        <div className="connections-setup">
          {exposure === "tailscale" ? (
            <div className="connections-panel">
              <ToggleGroup
                aria-label="Tailscale installation"
                className="connections-modes"
                disabled={busy || connecting || checking}
                onValueChange={(values) => {
                  if (values[0] === "embedded" || values[0] === "system") {
                    setTailscaleMode(values[0]);
                  }
                }}
                value={[tailscaleMode]}
              >
                <ToggleGroupItem value="embedded">Built into Tofu</ToggleGroupItem>
                <ToggleGroupItem value="system">Existing installation</ToggleGroupItem>
              </ToggleGroup>
              {tailscaleMode === "embedded" ? (
                <div className="connections-tailscale">
                  <p className="connections-description">
                    Connect Tofu itself to your private network. No separate Tailscale app is needed
                    on this server. Other devices still need a route into your tailnet and a Tofu
                    invitation. Connect starts sign-in and HTTPS authorization, then turns on
                    private remote access automatically.
                  </p>
                  <div className="connections-actions">
                    <Badge variant="outline">
                      {embedded?.state === "Running"
                        ? embedded.httpsEnabled
                          ? "Connected · HTTPS available"
                          : "Connected · HTTPS not enabled"
                        : embedded?.state === "ready"
                          ? "Private HTTPS is ready"
                          : (embedded?.state ?? "Not checked")}
                    </Badge>
                    <Button
                      disabled={busy || checking || connecting || !owner}
                      onClick={async () => {
                        setChecking(true);
                        setError(null);
                        try {
                          const { data, error: failure } =
                            await api.connections.tailscale.enroll.post();
                          if (failure) {
                            setError(errorMessage(failure, "Unable to start Tailscale"));
                            return;
                          }
                          setEmbedded(data);
                          requestedApproval.current = false;
                          setNotice(null);
                          setConnecting(true);
                        } finally {
                          setChecking(false);
                        }
                      }}
                      variant="outline"
                    >
                      {connecting ? "Connecting…" : "Connect Tofu to Tailscale"}
                    </Button>
                    {connecting ? (
                      <Button
                        disabled={busy}
                        onClick={() => {
                          setConnecting(false);
                          setNotice("Setup paused. Click Connect to resume.");
                        }}
                        variant="ghost"
                      >
                        Cancel setup
                      </Button>
                    ) : null}
                  </div>
                  {connecting ? (
                    <p className="connections-muted" role="status">
                      {busy
                        ? "Enabling private HTTPS…"
                        : embedded?.authUrl
                          ? "Finish signing in to Tailscale. Tofu will continue automatically."
                          : embedded?.httpsEnabled === false && embedded.state === "Running"
                            ? "Authorize HTTPS below. Tofu will continue automatically."
                            : "Waiting for Tailscale…"}
                    </p>
                  ) : null}
                  {embedded?.authUrl &&
                  URL.parse(embedded.authUrl)?.origin === "https://login.tailscale.com" ? (
                    <a href={embedded.authUrl} rel="noopener noreferrer" target="_blank">
                      Sign in to Tailscale
                    </a>
                  ) : null}
                  {embedded?.origin ? (
                    <code className="connections-address">{embedded.origin}</code>
                  ) : null}
                  {embedded?.state === "https-disabled" ||
                  (embedded?.state === "Running" && embedded.httpsEnabled === false) ? (
                    <Alert className="connections-callout">
                      <TriangleAlertIcon />
                      <AlertTitle>Enable HTTPS certificates in Tailscale</AlertTitle>
                      <AlertDescription>
                        {connecting
                          ? "Approve HTTPS in Tailscale. Tofu checks automatically and enables private access after you approve."
                          : "Click Connect to resume setup and activate private access after authorization."}{" "}
                        If Tailscale shows DNS settings, enable MagicDNS and HTTPS Certificates
                        there.
                        <a
                          href={
                            embedded.approvalUrl &&
                            [
                              "https://login.tailscale.com",
                              "https://console.tailscale.com",
                            ].includes(URL.parse(embedded.approvalUrl)?.origin ?? "")
                              ? embedded.approvalUrl
                              : "https://console.tailscale.com/admin/dns"
                          }
                          rel="noopener noreferrer"
                          target="_blank"
                        >
                          Authorize HTTPS in Tailscale
                        </a>
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  {owner ? null : (
                    <p>Connect the Tailscale account on {session.server.name} itself.</p>
                  )}
                  <p className="connections-muted">
                    Tailnet access and Tofu access are separate. Sharing with someone on another
                    tailnet requires authorized node sharing or an access rule in Tailscale.
                  </p>
                </div>
              ) : (
                <>
                  {tailscale === null && active.tailscale.enabled ? (
                    <Alert className="connections-callout">
                      <ShieldCheckIcon />
                      <AlertTitle>Private HTTPS through Tailscale</AlertTitle>
                      <AlertDescription>
                        {active.tailscale.origin
                          ? `Tofu serves ${active.tailscale.origin} on your tailnet.`
                          : "Check Tailscale to confirm its address."}
                      </AlertDescription>
                    </Alert>
                  ) : tailscale === null ? (
                    <p className="connections-muted">
                      Recommended. Not checked yet: Tofu has not looked at Tailscale on this
                      computer.
                    </p>
                  ) : (
                    <Alert
                      className="connections-callout"
                      variant={tailscale.state === "conflict" ? "destructive" : "default"}
                    >
                      {tailscale.state === "ready" ? <ShieldCheckIcon /> : <TriangleAlertIcon />}
                      <AlertTitle>
                        {
                          {
                            available: "Tailscale is ready to serve Tofu",
                            conflict: "Another service uses this Tailscale address",
                            "https-disabled": "Tailscale HTTPS is off",
                            "not-installed": "Tailscale is not installed",
                            ready: "Private HTTPS is ready",
                            "signed-out": "Tailscale is signed out",
                          }[tailscale.state]
                        }
                      </AlertTitle>
                      <AlertDescription>
                        {"detail" in tailscale ? `${tailscale.detail}. ` : ""}
                        {tailscaleGuidance[tailscale.state]}
                        {"origin" in tailscale ? (
                          <code className="connections-address">{tailscale.origin}</code>
                        ) : null}
                      </AlertDescription>
                    </Alert>
                  )}

                  <div className="connections-actions">
                    <Button
                      disabled={checking || busy}
                      onClick={() => void check()}
                      size="sm"
                      variant="outline"
                    >
                      {checking ? "Checking…" : "Check Tailscale"}
                    </Button>
                    <span className="connections-muted">
                      Tailscale is a private network, not a sign-in: every device still needs an
                      invitation. Tofu never turns on Funnel.
                    </span>
                  </div>
                </>
              )}
            </div>
          ) : null}
          {exposure === "proxy" ? (
            <div className="connections-panel">
              <Field>
                <FieldLabel htmlFor="proxy-origin">HTTPS address</FieldLabel>
                <Input
                  disabled={busy}
                  id="proxy-origin"
                  inputMode="url"
                  onChange={(event) => setProxyOrigin(event.target.value)}
                  placeholder="https://tofu.example.com"
                  value={proxyOrigin}
                />
                <FieldDescription>
                  Your reverse proxy terminates HTTPS and forwards to this server on this computer.
                  It must pass cookies and Range requests and stream responses without buffering.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="trusted-proxies">Trusted proxy addresses</FieldLabel>
                <Textarea
                  disabled={busy || !owner}
                  id="trusted-proxies"
                  onChange={(event) => setTrustedProxies(event.target.value)}
                  placeholder="192.168.1.2"
                  readOnly={!owner}
                  value={trustedProxies}
                />
                <FieldDescription>
                  {owner
                    ? "Forwarded client addresses are honored only from these proxies. A proxy on this computer is always trusted."
                    : `Change this on ${session.server.name} itself.`}
                </FieldDescription>
              </Field>
            </div>
          ) : null}
          {exposure === "lan" ? (
            <div className="connections-panel">
              <Alert className="connections-callout">
                <ShieldCheckIcon />
                <AlertTitle>HTTPS on your local network, without Tailscale</AlertTitle>
                <AlertDescription>
                  Browsers on the same network open Tofu at a local HTTPS address. Tofu creates a
                  private certificate authority (CA) for this server, and each device must trust it
                  before its browser connects: browsers cannot trust a private certificate
                  automatically. Installing a CA is a deliberate step on each device, and the steps
                  differ by browser and system.
                </AlertDescription>
              </Alert>
              <ol className="connections-description list-decimal pl-5">
                <li>Create the local certificate on {session.server.name}.</li>
                <li>
                  Download the installation CA, install it as trusted on each device that will
                  connect, and compare its SHA-256 fingerprint with the one shown here.
                </li>
                <li>Turn on local network sharing, then pair each browser with an invitation.</li>
              </ol>
              <Field>
                <FieldLabel htmlFor="lan-port">Local network port</FieldLabel>
                <Input
                  disabled={busy}
                  id="lan-port"
                  inputMode="numeric"
                  max={65_535}
                  min={1}
                  onChange={(event) => setLanPort(event.target.value)}
                  type="number"
                  value={lanPort}
                />
                <FieldDescription>
                  Other devices use this HTTPS port. Tofu itself listens only on this computer, at
                  port {state.listening.port}.
                </FieldDescription>
              </Field>
              {owner ? (
                <div className="connections-actions">
                  <Button
                    disabled={busy || certificateAction !== null || active.lan.enabled}
                    onClick={async () => {
                      setCertificateAction("create");
                      setError(null);
                      setNotice(null);
                      try {
                        const { data, error: failure } = await api.connections.certificate.post();
                        if (failure) {
                          setError(errorMessage(failure, "Unable to create the certificate"));
                          return;
                        }
                        setCertificate({ certificate: data });
                        setNotice(
                          "Local certificate created. Download the installation CA to trust it on your other devices."
                        );
                        setShowingCertificate(true);
                      } catch (cause) {
                        setError(errorMessage(cause, "Unable to create the certificate"));
                      } finally {
                        setCertificateAction(null);
                      }
                    }}
                    variant="outline"
                  >
                    {certificateAction === "create"
                      ? "Creating…"
                      : certificate?.certificate
                        ? "Renew local certificate"
                        : "Create local certificate"}
                  </Button>
                  <Button
                    disabled={busy || certificateAction !== null || !certificate?.certificate}
                    onClick={async () => {
                      setCertificateAction("download");
                      setError(null);
                      setNotice(null);
                      try {
                        if (session.capabilities.hostNative) {
                          const { data, error: failure } =
                            await api.connections.certificate.download.post();
                          if (failure) {
                            setError(errorMessage(failure, "Unable to save the installation CA"));
                            return;
                          }
                          if (data.path) {
                            setNotice(`Installation CA saved to ${data.path}`);
                          }
                          return;
                        }
                        const { data, error: failure } =
                          await api.connections.certificate.download.get();
                        if (failure) {
                          setError(errorMessage(failure, "Unable to download the installation CA"));
                          return;
                        }
                        const url = URL.createObjectURL(
                          new Blob([data], { type: "application/x-pem-file" })
                        );
                        const link = document.createElement("a");
                        link.href = url;
                        link.download = "Tofu-CA.pem";
                        document.body.append(link);
                        link.click();
                        link.remove();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                        setNotice("Installation CA download started.");
                      } catch (cause) {
                        setError(errorMessage(cause, "Unable to download the installation CA"));
                      } finally {
                        setCertificateAction(null);
                      }
                    }}
                    variant="outline"
                  >
                    {certificateAction === "download" ? "Saving…" : "Download installation CA"}
                  </Button>
                  <Button
                    disabled={busy || certificateAction !== null}
                    onClick={async () => {
                      setCertificateAction("show");
                      setError(null);
                      try {
                        const { data, error: failure } = await api.connections.certificate.get();
                        if (failure) {
                          setError(errorMessage(failure, "Unable to read the certificate"));
                          return;
                        }
                        setCertificate(data);
                        setShowingCertificate(true);
                      } catch (cause) {
                        setError(errorMessage(cause, "Unable to read the certificate"));
                      } finally {
                        setCertificateAction(null);
                      }
                    }}
                    variant="outline"
                  >
                    {certificateAction === "show" ? "Loading…" : "Show certificate"}
                  </Button>
                </div>
              ) : (
                <p>Prepare certificates on {session.server.name} itself.</p>
              )}
              {owner && active.lan.enabled ? (
                <p className="connections-muted">
                  Turn off local network sharing before renewing the certificate.
                </p>
              ) : null}
              {certificate ? (
                <p className="connections-muted">
                  {certificate.certificate ? (
                    <>
                      CA SHA-256: <code>{certificate.certificate.fingerprint}</code>
                      <br />
                      Covers {certificate.certificate.names}. Expires{" "}
                      {new Date(certificate.certificate.expiresAt).toLocaleDateString()}.
                    </>
                  ) : (
                    "No local certificate yet."
                  )}
                </p>
              ) : null}
              <p className="connections-muted">
                Devices on guest or isolated Wi-Fi may not reach this computer. Only addresses the
                certificate covers are offered; renew it after this computer's address or name
                changes.
              </p>
            </div>
          ) : null}
        </div>
      </FieldGroup>
      {dirty && !(owner && enabled && exposure === "tailscale" && tailscaleMode === "embedded") ? (
        <div className="connections-actions">
          <Button disabled={busy} onClick={() => setConfirming(true)}>
            Apply
          </Button>
          <span className="connections-muted">Unsaved {label.toLowerCase()} settings</span>
        </div>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <p className="connections-notice" role="status">
          <CheckIcon aria-hidden="true" />
          {notice}
        </p>
      ) : null}
      <Dialog onOpenChange={setShowingCertificate} open={showingCertificate}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Local network certificate</DialogTitle>
            <DialogDescription>
              Compare this CA fingerprint with the certificate you install on each device.
            </DialogDescription>
          </DialogHeader>
          {certificate?.certificate ? (
            <dl className="wrap-anywhere flex flex-col gap-3">
              <div>
                <dt>CA SHA-256</dt>
                <dd>
                  <code>{certificate.certificate.fingerprint}</code>
                </dd>
              </div>
              <div>
                <dt>Server certificate expires</dt>
                <dd>{new Date(certificate.certificate.expiresAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Covered names and addresses</dt>
                <dd>{certificate.certificate.names}</dd>
              </div>
            </dl>
          ) : (
            <p>No local certificate yet. Create one on this server first.</p>
          )}
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
      <AlertDialog onOpenChange={setConfirming} open={confirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {enabled
                ? `Change ${label.toLowerCase()} sharing?`
                : `Turn off ${label.toLowerCase()} sharing?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {enabled
                ? "Authorized devices connect through this address. Other connections and downloads keep running."
                : "Devices using this address disconnect. Other connections, downloads, files and saved devices are kept."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void apply()}>
              {busy ? "Applying…" : "Apply"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
