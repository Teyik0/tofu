import { CopyIcon, LinkIcon } from "lucide-react";
import { useState } from "react";
import { ActionTooltip } from "../../../components/action-tooltip";
import { Button } from "../../../components/ui/button";
import type { ConnectionsState } from "./index";

/**
 * Addresses through which other devices reach this server, for every exposure that is on.
 * Loopback is never offered. Each address is a separate browser origin that pairs separately.
 */
export function serverAddresses(state: ConnectionsState) {
  const { lan, proxy, tailscale } = state.config;
  return [
    ...(lan.enabled ? state.addresses.map((url) => ({ label: "Local network HTTPS", url })) : []),
    ...(tailscale.enabled && tailscale.origin
      ? [{ label: "Tailscale HTTPS", url: tailscale.origin }]
      : []),
    ...(proxy.enabled && proxy.origin ? [{ label: "Custom HTTPS", url: proxy.origin }] : []),
  ];
}

export function ServerAddresses({ state }: { state: ConnectionsState }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [clipboardFailed, setClipboardFailed] = useState(false);
  const addresses = serverAddresses(state);
  if (addresses.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="server-address-title" className="connections-section">
      <div className="connections-section-title">
        <h3 id="server-address-title">Server addresses</h3>
      </div>
      <div className="settings-group">
        {addresses.map((address) => (
          <div className="connections-row" key={address.url}>
            <LinkIcon aria-hidden="true" className="connections-row-icon" />
            <div className="connections-row-copy">
              <strong>{address.label}</strong>
              <code className="connections-address">{address.url}</code>
              <p>
                {copied === address.url
                  ? "Copied."
                  : clipboardFailed
                    ? "Clipboard unavailable. Select and copy the address above."
                    : address.label === "Local network HTTPS"
                      ? "Works on devices on this network that trust this server's certificate authority."
                      : "Reachability depends on the connecting device. Not verified on other devices yet."}
              </p>
            </div>
            <ActionTooltip>
              <Button
                aria-label={`Copy ${address.label} address`}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(address.url);
                    setCopied(address.url);
                  } catch {
                    setCopied(null);
                    setClipboardFailed(true);
                  }
                }}
                size="icon"
                variant="ghost"
              >
                <CopyIcon />
              </Button>
            </ActionTooltip>
          </div>
        ))}
      </div>
    </section>
  );
}
