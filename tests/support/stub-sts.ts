/**
 * A local stand-in for AWS STS, so tests exercise the real AWS SDK without reaching AWS.
 * Point a client at `endpoint`, or a spawned CLI at it with `AWS_ENDPOINT_URL_STS`.
 */

const NAMESPACE = "https://sts.amazonaws.com/doc/2011-06-15/";

/** How the stub answers every request. */
export type StubStsAnswer =
  | { readonly kind: "caller"; readonly account: string; readonly arn: string }
  | { readonly kind: "error"; readonly status: number; readonly code: string }
  /** Never answers, as an unreachable endpoint would not. */
  | { readonly kind: "hang" };

export interface StubSts {
  readonly endpoint: string;
  /** Form-encoded bodies of the requests received, in order. */
  readonly requests: readonly string[];
  stop(): void;
}

function respond(answer: StubStsAnswer): Response | Promise<Response> {
  const headers = { "content-type": "text/xml" };
  switch (answer.kind) {
    case "caller":
      return new Response(
        `<GetCallerIdentityResponse xmlns="${NAMESPACE}"><GetCallerIdentityResult>` +
          `<Arn>${answer.arn}</Arn><UserId>AIDAEXAMPLEUSERID</UserId>` +
          `<Account>${answer.account}</Account></GetCallerIdentityResult>` +
          "<ResponseMetadata><RequestId>stub</RequestId></ResponseMetadata>" +
          "</GetCallerIdentityResponse>",
        { headers },
      );
    case "error":
      return new Response(
        `<ErrorResponse xmlns="${NAMESPACE}"><Error><Type>Sender</Type>` +
          `<Code>${answer.code}</Code><Message>stub ${answer.code}</Message></Error>` +
          "<RequestId>stub</RequestId></ErrorResponse>",
        { status: answer.status, headers },
      );
    case "hang":
      return new Promise<Response>(() => {});
  }
}

/** Starts a stub on a free local port answering every request with `answer`. */
export function stubSts(answer: StubStsAnswer): StubSts {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests.push(await request.text());
      return respond(answer);
    },
  });
  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

/** AWS's documentation example key pair: well-formed, and valid for no account. */
export const EXAMPLE_CREDENTIALS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
} as const;
