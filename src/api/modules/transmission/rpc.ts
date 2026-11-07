/** Credentials and address of one Transmission RPC daemon. */
export interface TransmissionEndpoint {
  origin: string;
  password: string | null;
  rpcPath: string;
  username: string | null;
}

/** A failed RPC exchange, already mapped to the HTTP status returned to Tofu clients. */
export class TransmissionRpcError extends Error {
  readonly status: 401 | 502;

  constructor(status: 401 | 502, message: string) {
    super(message);
    this.name = "TransmissionRpcError";
    this.status = status;
  }
}

/**
 * Transmission rotates its session id through a 409 challenge. The id is scoped to the RPC
 * endpoint and reused until the daemon rejects it again.
 */
const sessions = new Map<string, string>();

const MAX_ATTEMPTS = 2;

function authorization(endpoint: TransmissionEndpoint) {
  if (endpoint.username === null) {
    return null;
  }
  const credentials = `${endpoint.username}:${endpoint.password ?? ""}`;
  return `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
}

function resultMessage(result: string | undefined) {
  if (result === "duplicate torrent") {
    return "This torrent is already in Transmission";
  }
  return result ?? "Transmission rejected the request";
}

function rejection(response: Response) {
  if (response.status === 401 || response.status === 403) {
    return new TransmissionRpcError(401, "Transmission rejected these credentials");
  }
  if (!response.ok) {
    return new TransmissionRpcError(502, `Transmission answered HTTP ${response.status}`);
  }
  return null;
}

async function attempt<Arguments>(
  endpoint: TransmissionEndpoint,
  method: string,
  parameters: object | undefined,
  signal: AbortSignal,
  tries: number
): Promise<Arguments> {
  const key = `${endpoint.origin}${endpoint.rpcPath}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const encoded = authorization(endpoint);
  if (encoded !== null) {
    headers.authorization = encoded;
  }
  const session = sessions.get(key);
  if (session !== undefined) {
    headers["x-transmission-session-id"] = session;
  }
  // Transmission answers the challenge with 409 and an HTML body; the id is in the headers.
  const response = await fetch(new URL(endpoint.rpcPath, endpoint.origin).href, {
    body: JSON.stringify({ arguments: parameters ?? {}, method }),
    headers,
    method: "POST",
    signal,
  });
  if (response.status === 409) {
    const id = response.headers.get("x-transmission-session-id");
    if (id === null || tries + 1 >= MAX_ATTEMPTS) {
      throw new TransmissionRpcError(502, "Transmission kept rejecting the RPC session");
    }
    sessions.set(key, id);
    return attempt<Arguments>(endpoint, method, parameters, signal, tries + 1);
  }
  const rejected = rejection(response);
  if (rejected !== null) {
    throw rejected;
  }
  const payload = (await response.json()) as { arguments?: Arguments; result?: string };
  if (payload.result !== "success") {
    throw new TransmissionRpcError(502, resultMessage(payload.result));
  }
  return (payload.arguments ?? {}) as Arguments;
}

export function transmissionRpc<Arguments>(
  endpoint: TransmissionEndpoint,
  method: string,
  parameters: object | undefined,
  signal: AbortSignal
): Promise<Arguments> {
  return attempt<Arguments>(endpoint, method, parameters, signal, 0);
}

/** Forgets the cached session id after a configuration change. */
export function forgetTransmissionSession(endpoint: TransmissionEndpoint) {
  sessions.delete(`${endpoint.origin}${endpoint.rpcPath}`);
}
