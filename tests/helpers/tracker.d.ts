declare module "bittorrent-tracker" {
  import { EventEmitter } from "node:events";
  import type { Server as HttpServer } from "node:http";
  export class Server extends EventEmitter {
    constructor(options: {
      http: boolean;
      udp: boolean;
      ws: boolean;
      stats: boolean;
      interval?: number;
    });
    http: HttpServer;
    listen(port: number, host: string, callback: () => void): void;
    close(callback: () => void): void;
  }
}
