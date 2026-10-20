import { CheckIcon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/client";
import { errorMessage } from "../../lib/errors";
import type { ConnectionsState } from "../../pages/options/connections";
import type { ServerSession } from "../../state/workspace";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

const WHITESPACE = /\s+/;

type Transport = ConnectionsState["config"]["transport"];
type TailscaleStatus = NonNullable<
  Awaited<ReturnType<typeof api.connections.tailscale.check.post>>["data"]
>;

const transports: { label: string; value: Transport }[] = [
  { label: "Local network", value: "lan" },
  { label: "Tailscale", value: "tailscale" },
  { label: "Custom HTTPS", value: "proxy" },
];

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

function Countdown({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{Math.max(0, Math.round((deadline - now) / 1000))} seconds</>;
}

/**
 * Remote access drafts use Apply. Embedded Tailscale's explicit Connect action runs its
 * enrollment and HTTPS consent flow, then enables the selected private transport.
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
  const [enabled, setEnabled] = useState(active.enabled);
  const [transport, setTransport] = useState<Transport>(active.transport);
  const [proxyOrigin, setProxyOrigin] = useState(active.proxyOrigin ?? "");
  const [trustedProxies, setTrustedProxies] = useState(active.trustedProxies.join("\n"));
  const [tailscaleMode, setTailscaleMode] = useState<"embedded" | "system">(
    active.tailscaleMode ?? (active.enabled ? "system" : "embedded")
  );
  const [embedded, setEmbedded] = useState<NonNullable<
    Awaited<ReturnType<typeof api.connections.tailscale.embedded.get>>["data"]
  > | null>(null);
  const [tailscale, setTailscale] = useState<TailscaleStatus | null>(null);
  const [certificate, setCertificate] = useState<NonNullable<
    Awaited<ReturnType<typeof api.connections.certificate.get>>["data"]
  > | null>(null);
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
  const dirty =
    enabled !== active.enabled ||
    (enabled &&
      (transport !== active.transport ||
        (transport === "tailscale" && tailscaleMode !== (active.tailscaleMode ?? "system")) ||
        (transport === "proxy" &&
          (proxyOrigin.trim() !== (active.proxyOrigin ?? "") ||
            proxies.join() !== active.trustedProxies.join()))));
  const pending = state.listening.pendingConfirmation;
  const rebinds = enabled && transport === "lan";

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
              setNotice(
                activated.data.restarting
                  ? "Tofu is restarting its connections. Reconnect through the new address to confirm the configuration."
                  : "Private HTTPS is ready. Pair a device to connect to Tofu."
              );
              setEmbedded({ ...data, state: "ready" });
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
        proxyOrigin: transport === "proxy" ? proxyOrigin.trim() || null : undefined,
        tailscaleMode,
        transport,
        trustedProxies: owner && transport === "proxy" ? proxies : undefined,
      });
      if (failure) {
        setError(errorMessage(failure, "Unable to change remote access"));
        return;
      }
      setNotice(
        data.restarting
          ? `${session.server.name} is restarting its connections. Reconnect through the new address to confirm.`
          : enabled
            ? "Remote access is on."
            : "Remote access is off. Only this computer can connect."
      );
      await onChanged();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const confirm = async () => {
    const { error: failure } = await api.connections.confirm.post();
    if (failure) {
      setError(errorMessage(failure, "Unable to confirm the connection change"));
      return;
    }
    setNotice("The new configuration is confirmed.");
    await onChanged();
  };

  return (
    <section aria-labelledby="network-access-title" className="connections-section">
      <div className="connections-section-title">
        <h3 id="network-access-title">Network access</h3>
        <Badge variant={active.enabled ? "secondary" : "outline"}>
          {active.enabled ? "Enabled" : "Off"}
        </Badge>
      </div>
      {pending && !pending.local ? (
        <Alert className="connections-pending">
          <TriangleAlertIcon />
          <AlertTitle>Confirm the new connection settings</AlertTitle>
          <AlertDescription>
            If this change is not confirmed from the new address within{" "}
            <Countdown deadline={pending.deadline} />, Tofu restores the previous configuration.
            <Button onClick={() => void confirm()} size="sm">
              Keep this configuration
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <FieldGroup className="settings-group">
        <Field className="settings-row" orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="remote-access">Allow remote connections</FieldLabel>
            <FieldDescription id="remote-access-description">
              {active.enabled
                ? "Authorized devices can connect to this server."
                : "Only this computer can connect."}
            </FieldDescription>
          </FieldContent>
          <Switch
            aria-describedby="remote-access-description"
            checked={enabled}
            disabled={busy || connecting || checking}
            id="remote-access"
            onCheckedChange={setEnabled}
          />
        </Field>
        {enabled ? (
          <div className="connections-setup">
            <ToggleGroup
              aria-label="Connection setup"
              className="connections-transports"
              disabled={busy || connecting || checking}
              onValueChange={([value]) => {
                if (value === "lan" || value === "tailscale" || value === "proxy") {
                  setTransport(value);
                }
              }}
              value={[transport]}
              variant="outline"
            >
              {transports.map((item) => (
                <ToggleGroupItem key={item.value} value={item.value}>
                  {item.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {transport === "tailscale" ? (
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
                      Connect Tofu itself to your private network. No separate Tailscale app is
                      needed on this server. Other devices still need a route into your tailnet and
                      a Tofu invitation. Connect starts sign-in and HTTPS authorization, then turns
                      on private remote access automatically.
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
                    {tailscale === null && active.transport === "tailscale" && active.enabled ? (
                      <Alert className="connections-callout">
                        <ShieldCheckIcon />
                        <AlertTitle>Private HTTPS through Tailscale</AlertTitle>
                        <AlertDescription>
                          {active.tailscaleOrigin
                            ? `Tofu serves ${active.tailscaleOrigin} on your tailnet.`
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
            {transport === "proxy" ? (
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
                    Your reverse proxy terminates HTTPS and forwards to this server on this
                    computer. It must pass cookies and Range requests and stream responses without
                    buffering.
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
            {transport === "lan" ? (
              <div className="connections-panel">
                <Alert className="connections-callout">
                  <ShieldCheckIcon />
                  <AlertTitle>Tofu serves HTTPS directly</AlertTitle>
                  <AlertDescription>
                    Tofu creates a certificate authority for this server. Install it on each device
                    before opening Tofu in a browser, including this computer: Tofu applies this
                    setting only once its own window connects securely. Browsers cannot trust a
                    private certificate automatically.
                  </AlertDescription>
                </Alert>
                {owner ? (
                  <div className="connections-actions">
                    <Button
                      disabled={busy}
                      onClick={async () => {
                        const { error: failure } = await api.connections.certificate.post();
                        if (failure) {
                          setError(errorMessage(failure, "Unable to create the certificate"));
                          return;
                        }
                        const status = await api.connections.certificate.get();
                        if (status.error) {
                          setError(errorMessage(status.error, "Unable to check host trust"));
                          return;
                        }
                        setCertificate(status.data);
                      }}
                      variant="outline"
                    >
                      Create local certificate
                    </Button>
                    <a download href="/api/connections/certificate/download">
                      Download installation CA
                    </a>
                    <Button
                      onClick={async () => {
                        const { data, error: failure } = await api.connections.certificate.get();
                        if (failure) {
                          setError(errorMessage(failure, "Unable to check host trust"));
                          return;
                        }
                        setCertificate(data);
                      }}
                      variant="outline"
                    >
                      Check host trust
                    </Button>
                  </div>
                ) : (
                  <p>Prepare certificates on {session.server.name} itself.</p>
                )}
                {certificate?.certificate ? (
                  <p className="connections-muted">
                    CA SHA-256: <code>{certificate.certificate.fingerprint}</code>
                    <br />
                    {certificate.trust.trusted ? "Host trust verified." : certificate.trust.detail}{" "}
                    Leaf expires {new Date(certificate.certificate.expiresAt).toLocaleDateString()}.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </FieldGroup>
      {dirty && !(owner && enabled && transport === "tailscale" && tailscaleMode === "embedded") ? (
        <div className="connections-actions">
          <Button disabled={busy} onClick={() => setConfirming(true)}>
            Apply configuration
          </Button>
          <span className="connections-muted">Unsaved configuration</span>
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
      <AlertDialog onOpenChange={setConfirming} open={confirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {enabled ? `Change access to ${session.server.name}?` : "Turn off remote access?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {enabled
                ? rebinds
                  ? `${session.server.name} restarts its connections. If this change is not confirmed from the new address within 90 seconds, Tofu restores the previous configuration.`
                  : "Authorized devices connect through the new address. Downloads keep running."
                : "Other devices disconnect. Downloads, files and saved devices are kept."}
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
