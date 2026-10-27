export interface TailscaleCommand {
  hostname?: string;
  hosts?: string[];
  lanPort?: number;
  method:
    | "start"
    | "status"
    | "serve"
    | "stop"
    | "logout"
    | "authorize-https"
    | "lan-open"
    | "lan-close";
  port?: number;
}

export interface TailscaleStatus {
  approvalUrl?: string;
  authUrl?: string;
  error?: string;
  hosts?: string[];
  httpsEnabled?: boolean;
  origin?: string;
  state: string;
}
