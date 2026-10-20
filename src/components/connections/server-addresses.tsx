import { CopyIcon, LinkIcon } from "lucide-react";
import { useState } from "react";
import type { ConnectionsState } from "../../pages/options/connections";
import { ActionTooltip } from "../action-tooltip";
import { Button } from "../ui/button";

/** Addresses through which other devices reach this server; loopback is never offered. */
export function serverAddresses(state: ConnectionsState) {
  const { config } = state;
  if (!config.enabled) {
    return [];
  }
  if (config.transport === "tailscale" && config.tailscaleOrigin) {
    return [{ label: "Tailscale HTTPS", url: config.tailscaleOrigin }];
  }
  if (config.transport === "proxy" && config.proxyOrigin) {
    return [{ label: "Custom HTTPS", url: config.proxyOrigin }];
  }
  return state.addresses.map((url) => ({ label: "Local network HTTPS", url }));
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
        <h3 id="server-address-title">Server address</h3>
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
