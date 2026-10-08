/**
 * A local stand-in for the GitHub Releases API of yaunder/fffactory, so `install.sh` is tested
 * without reaching GitHub. Point the script at `api` with `FFFACTORY_GITHUB_API`.
 *
 * It answers like GitHub: release JSON with nested `author` and `uploader` objects, a
 * private repository that answers 404 without the right token and 401 with a wrong one,
 * and asset downloads that redirect to another host (`localhost` instead of `127.0.0.1`)
 * which, like a presigned storage URL, refuses any request that carries a token.
 */
import { createHash } from "node:crypto";

export const REPOSITORY = "yaunder/fffactory";

export interface FakeAsset {
  readonly name: string;
  readonly content: string | Uint8Array;
}

export interface FakeRelease {
  readonly tag: string;
  readonly assets: readonly FakeAsset[];
}

export interface FakeGitHubOptions {
  readonly releases: readonly FakeRelease[];
  /** The tag `/releases/latest` answers with; the first release when omitted. */
  readonly latest?: string;
  /** Makes the repository private: only this token may read it. */
  readonly token?: string;
  /** Indents the JSON, as a proxy or a future API version might. */
  readonly pretty?: boolean;
  /** Address to listen on; 127.0.0.1 when omitted. */
  readonly hostname?: string;
  /** Port to listen on; a free one when omitted. */
  readonly port?: number;
  /** Where asset downloads redirect to; `http://localhost:<port>` when omitted. */
  readonly storageOrigin?: string;
}

export interface RecordedRequest {
  readonly path: string;
  readonly host: string;
  readonly authorization: string | null;
  readonly accept: string | null;
  /** Every request header, by lowercased name. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface FakeGitHub {
  /** The API base URL, for `FFFACTORY_GITHUB_API`. */
  readonly api: string;
  readonly requests: readonly RecordedRequest[];
  stop(): void;
}

/** The SHA256SUMS text `sha256sum` would write for `assets`. */
export function sha256sums(assets: readonly FakeAsset[]): string {
  return assets
    .map((asset) => `${createHash("sha256").update(asset.content).digest("hex")}  ${asset.name}\n`)
    .join("");
}

/** A stand-in executable that reports which platform and tag it was built for. */
export function fakeExecutable(platform: string, tag: string): FakeAsset {
  return {
    name: `fffactory-${platform}`,
    content: `#!/bin/sh\necho "fake fffactory ${platform} ${tag}"\n`,
  };
}

/** A complete release: both executables and their SHA256SUMS, among decoy assets. */
export function completeRelease(tag: string): FakeRelease {
  const executables = [fakeExecutable("darwin-arm64", tag), fakeExecutable("linux-x64", tag)];
  return {
    tag,
    assets: [
      { name: "install.sh", content: "#!/bin/sh\n" },
      executables[0] as FakeAsset,
      { name: "SHA256SUMS", content: sha256sums(executables) },
      executables[1] as FakeAsset,
    ],
  };
}

const RELEASES = `/repos/${REPOSITORY}/releases`;

interface Indexed {
  readonly release: FakeRelease;
  readonly id: number;
  readonly assetIds: readonly number[];
}

export function fakeGitHub(options: FakeGitHubOptions): FakeGitHub {
  const requests: RecordedRequest[] = [];
  let nextId = 1000;
  const indexed: Indexed[] = options.releases.map((release) => ({
    release,
    id: nextId++,
    assetIds: release.assets.map(() => nextId++),
  }));
  const latestTag = options.latest ?? options.releases[0]?.tag;

  const json = (status: number, value: unknown) =>
    new Response(JSON.stringify(value, null, options.pretty ? 2 : undefined), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  const notFound = () => json(404, { message: "Not Found", status: "404" });

  function releaseJson(api: string, entry: Indexed) {
    const { release } = entry;
    return {
      url: `${api}${RELEASES}/${entry.id}`,
      id: entry.id,
      tag_name: release.tag,
      name: `fffactory ${release.tag}`,
      // Decoys for a parser that ignores structure: an author with a name and an id, and
      // a body quoting an asset object.
      author: { login: "github-actions[bot]", id: 41898282, name: "fffactory-linux-x64" },
      body: 'Assets: {"name": "fffactory-linux-x64", "id": 1} [\\"SHA256SUMS\\"]',
      draft: false,
      prerelease: false,
      assets: release.assets.map((asset, index) => ({
        url: `${api}${RELEASES}/assets/${entry.assetIds[index]}`,
        id: entry.assetIds[index],
        name: asset.name,
        label: "",
        uploader: { login: "github-actions[bot]", id: 7, name: "fffactory-linux-x64" },
        content_type: "application/octet-stream",
        state: "uploaded",
        size: asset.content.length,
        browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${release.tag}/${asset.name}`,
      })),
    };
  }

  function findAsset(id: number): FakeAsset | undefined {
    for (const entry of indexed) {
      const index = entry.assetIds.indexOf(id);
      if (index >= 0) return entry.release.assets[index];
    }
    return undefined;
  }

  /** A private repository's refusal of `request`, if it is refused. */
  function refusal(request: Request): Response | undefined {
    if (options.token === undefined) return undefined;
    const authorization = request.headers.get("authorization");
    if (authorization === null) return notFound();
    if (authorization === `Bearer ${options.token}`) return undefined;
    return json(401, { message: "Bad credentials", status: "401" });
  }

  function release(tag: string, base: string): Response {
    const entry = indexed.find((candidate) => candidate.release.tag === tag);
    return entry ? json(200, releaseJson(base, entry)) : notFound();
  }

  function asset(path: string, request: Request, port: number): Response {
    const prefix = `${RELEASES}/assets/`;
    const id = Number(path.slice(prefix.length));
    const found = path.startsWith(prefix) ? findAsset(id) : undefined;
    if (!found) return notFound();
    if (request.headers.get("accept") !== "application/octet-stream") {
      return json(200, { id, name: found.name });
    }
    const origin = options.storageOrigin ?? `http://localhost:${port}`;
    const location = `${origin}/storage/${id}/${encodeURIComponent(found.name)}`;
    return new Response(null, { status: 302, headers: { location } });
  }

  function api(url: URL, request: Request, base: string, port: number): Response {
    const refused = refusal(request);
    if (refused) return refused;
    const path = url.pathname;
    const tag = path === `${RELEASES}/latest` ? latestTag : tagIn(path);
    return tag === undefined ? asset(path, request, port) : release(tag, base);
  }

  function storage(url: URL, request: Request): Response {
    // Presigned storage URLs refuse a second authentication mechanism.
    if (request.headers.get("authorization") !== null) {
      return new Response("Only one auth mechanism allowed", { status: 400 });
    }
    const asset = findAsset(Number(url.pathname.split("/")[2]));
    return asset ? new Response(asset.content) : new Response("missing", { status: 404 });
  }

  const hostname = options.hostname ?? "127.0.0.1";
  const server = Bun.serve({
    hostname,
    port: options.port ?? 0,
    fetch(request, server) {
      const url = new URL(request.url);
      requests.push({
        path: url.pathname,
        host: request.headers.get("host") ?? "",
        authorization: request.headers.get("authorization"),
        accept: request.headers.get("accept"),
        headers: Object.fromEntries(request.headers),
      });
      const port = server.port ?? 0;
      if (url.pathname.startsWith("/storage/")) return storage(url, request);
      return api(url, request, `http://${hostname}:${port}`, port);
    },
  });

  return {
    api: `http://${hostname}:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

function tagIn(path: string): string | undefined {
  const prefix = `${RELEASES}/tags/`;
  return path.startsWith(prefix) ? decodeURIComponent(path.slice(prefix.length)) : undefined;
}
