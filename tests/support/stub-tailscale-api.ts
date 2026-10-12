/**
 * A local stand-in for the three Tailscale API calls `tailscaleApiAdmin` makes: the OAuth
 * token exchange, the tailnet's device list and a device's deletion, so its tests send real
 * HTTP without reaching Tailscale. It grants `TOKEN` for `secret` alone, then `TOKEN-2` and on
 * once `expireTokens` has expired the ones granted, echoes every refused request's body back in
 * its error (as a careless API might), and records each request.
 */

export const TOKEN = "tskey-api-kStubToken1CNTRL-stubaccesstoken";

export interface StubTailscaleDevice {
  readonly nodeId?: unknown;
  readonly id?: unknown;
  readonly hostname?: unknown;
  readonly name?: unknown;
  readonly tags?: unknown;
}

export interface StubTailscaleApiOptions {
  /** The client secret it grants a token for. */
  readonly secret: string;
  readonly devices?: readonly StubTailscaleDevice[];
  /** The device list's body as given, instead of `devices`. */
  readonly listBody?: string;
  /** The token exchange's body as given, instead of a token. */
  readonly tokenBody?: string;
  /** HTTP statuses to answer instead, by `token`, `list` or a device ID's deletion. */
  readonly statuses?: Readonly<Record<string, number>>;
  /** Never answers, as an unreachable API would not. */
  readonly hang?: boolean;
  /** Answers every request with a 307 redirect to this URL's same path. */
  readonly redirectTo?: string;
}

export interface StubTailscaleApi {
  readonly url: string;
  readonly requests: readonly {
    readonly method: string;
    readonly path: string;
    readonly authorization: string | null;
    readonly contentType: string | null;
    readonly body: string;
  }[];
  /** The device IDs still listed. */
  readonly remaining: () => readonly unknown[];
  /** Expires every token granted so far, as an hour does: they are refused with HTTP 401. */
  expireTokens(): void;
  stop(): void;
}

export function stubTailscaleApi(options: StubTailscaleApiOptions): StubTailscaleApi {
  const requests: {
    method: string;
    path: string;
    authorization: string | null;
    contentType: string | null;
    body: string;
  }[] = [];
  let devices = [...(options.devices ?? [])];
  let granted = 0;
  let valid = new Set<string>();
  const status = (name: string) => options.statuses?.[name];
  const refuse = (code: number, body: string) =>
    Response.json({ message: `refused: ${body}` }, { status: code });

  function token(body: string): Response {
    const code = status("token");
    if (code !== undefined) return refuse(code, body);
    const form = new URLSearchParams(body);
    if (form.get("client_secret") !== options.secret) return refuse(401, body);
    if (options.tokenBody !== undefined) return new Response(options.tokenBody);
    granted += 1;
    const access = granted === 1 ? TOKEN : `${TOKEN}-${granted}`;
    valid.add(access);
    return Response.json({
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "devices:core",
    });
  }

  function authorized(request: Request): boolean {
    const [scheme, token] = (request.headers.get("authorization") ?? "").split(" ");
    return scheme === "Bearer" && token !== undefined && valid.has(token);
  }

  function list(request: Request): Response {
    const code = status("list");
    if (code !== undefined) return refuse(code, TOKEN);
    if (!authorized(request)) return refuse(401, "");
    if (options.listBody !== undefined) return new Response(options.listBody);
    return Response.json({ devices });
  }

  function remove(request: Request, id: string): Response {
    const code = status(id);
    if (code !== undefined) return refuse(code, TOKEN);
    if (!authorized(request)) return refuse(401, "");
    const before = devices.length;
    devices = devices.filter((device) => device.nodeId !== id && device.id !== id);
    return devices.length === before ? refuse(404, "") : new Response(null, { status: 200 });
  }

  function route(request: Request, path: string, body: string): Response {
    if (request.method === "POST" && path === "/api/v2/oauth/token") return token(body);
    if (request.method === "GET" && path === "/api/v2/tailnet/-/devices") return list(request);
    const deletion = /^\/api\/v2\/device\/([^/]+)$/.exec(path);
    if (request.method === "DELETE" && deletion?.[1] !== undefined)
      return remove(request, decodeURIComponent(deletion[1]));
    return refuse(404, body);
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = await request.text();
      requests.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        contentType: request.headers.get("content-type"),
        body,
      });
      if (options.hang) return new Promise<Response>(() => {});
      if (options.redirectTo !== undefined)
        return Response.redirect(`${options.redirectTo}${url.pathname}`, 307);
      return route(request, url.pathname, body);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    remaining: () => devices.map((device) => device.nodeId ?? device.id),
    expireTokens: () => {
      valid = new Set();
    },
    stop: () => server.stop(true),
  };
}
