// Telnet/SSH: a line-oriented remote session carried over the simulated TCP
// model. Each line is one request/response exchange.

import type { IpStack } from "../ipstack";

export interface RemoteRequest {
  sid: string;
  op: "open" | "line" | "close";
  proto: "telnet" | "ssh";
  user?: string;
  line?: string;
  from?: string;
}

export interface RemoteResponse {
  out: string;
  prompt: string;
  hidden: boolean;
  closed: boolean;
}

export class RemoteLink {
  sid = Math.random().toString(36).slice(2);
  closed = false;
  prompt = "";
  hidden = false;

  constructor(
    private stack: IpStack,
    public ip: string,
    public proto: "telnet" | "ssh",
    private user?: string,
  ) {}

  private port() {
    return this.proto === "ssh" ? 22 : 23;
  }

  private request(req: RemoteRequest, cb: (r: RemoteResponse | null, err?: string) => void) {
    this.stack.tcpRequest(
      this.ip,
      this.port(),
      JSON.stringify(req),
      (res) => {
        if (!res.ok) return cb(null, res.error);
        try {
          const r = JSON.parse(res.data) as RemoteResponse;
          this.prompt = r.prompt;
          this.hidden = r.hidden;
          if (r.closed) this.closed = true;
          cb(r);
        } catch {
          cb(null, "Protocol error");
        }
      },
      8000,
    );
  }

  open(cb: (r: RemoteResponse | null, err?: string) => void) {
    this.request({ sid: this.sid, op: "open", proto: this.proto, user: this.user, from: this.stack.sourceFor(this.ip) }, cb);
  }

  send(line: string, cb: (r: RemoteResponse | null, err?: string) => void) {
    this.request({ sid: this.sid, op: "line", proto: this.proto, line }, cb);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.request({ sid: this.sid, op: "close", proto: this.proto }, () => {});
  }
}
