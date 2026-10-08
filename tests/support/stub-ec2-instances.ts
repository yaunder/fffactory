/**
 * A local stand-in for EC2 `DescribeInstances`, so tests exercise the real AWS SDK without
 * reaching AWS. Point a client at `endpoint`, or a spawned CLI at it with
 * `AWS_ENDPOINT_URL_EC2`.
 */

const EC2_NAMESPACE = "http://ec2.amazonaws.com/doc/2016-11-15/";

export interface StubInstance {
  readonly id: string;
  readonly state: string;
  readonly tags: Readonly<Record<string, string>>;
}

export interface StubEc2InstancesAnswers {
  /** Pages of instances; each page but the last carries a next token. */
  readonly pages?: readonly (readonly StubInstance[])[];
  /** An EC2 error code to answer with, such as UnauthorizedOperation. */
  readonly error?: string;
}

export interface StubEc2Instances {
  readonly endpoint: string;
  /** Each DescribeInstances form body, in order. */
  readonly requests: readonly string[];
  stop(): void;
}

function instanceXml({ id, state, tags }: StubInstance): string {
  const tagItems = Object.entries(tags)
    .map(([key, value]) => `<item><key>${key}</key><value>${value}</value></item>`)
    .join("");
  return (
    `<item><instanceId>${id}</instanceId><instanceState><code>16</code><name>${state}</name>` +
    `</instanceState><tagSet>${tagItems}</tagSet></item>`
  );
}

function describeInstances(answers: StubEc2InstancesAnswers, body: string): Response {
  const headers = { "content-type": "text/xml" };
  if (answers.error)
    return new Response(
      `<Response><Errors><Error><Code>${answers.error}</Code><Message>stub ${answers.error}` +
        "</Message></Error></Errors><RequestID>stub</RequestID></Response>",
      { status: 403, headers },
    );
  const pages = answers.pages ?? [[]];
  const token = new URLSearchParams(body).get("NextToken");
  const index = token === null ? 0 : Number(token.replace("page-", ""));
  const instances = (pages[index] ?? []).map(instanceXml).join("");
  const next = index + 1 < pages.length ? `<nextToken>page-${index + 1}</nextToken>` : "";
  return new Response(
    `<DescribeInstancesResponse xmlns="${EC2_NAMESPACE}"><requestId>stub</requestId>` +
      `<reservationSet><item><reservationId>r-0stub</reservationId><instancesSet>${instances}` +
      `</instancesSet></item></reservationSet>${next}</DescribeInstancesResponse>`,
    { headers },
  );
}

/** Starts a stub on a free local port answering DescribeInstances with `answers`. */
export function stubEc2Instances(answers: StubEc2InstancesAnswers = {}): StubEc2Instances {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = await request.text();
      requests.push(body);
      return describeInstances(answers, body);
    },
  });
  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}
