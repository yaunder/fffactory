/**
 * A local stand-in for EC2 `DescribeInstances`, `DescribeVpcs`, `StopInstances`,
 * `StartInstances` and `TerminateInstances`, so tests exercise the real AWS SDK without reaching
 * AWS. Point a client at `endpoint`, or a spawned CLI at it with `AWS_ENDPOINT_URL_EC2`. A stop,
 * start or terminate changes nothing: its answer is empty. DescribeVpcs applies its `tag:`
 * filters, as EC2 does. Its answers may change between requests.
 */

const EC2_NAMESPACE = "http://ec2.amazonaws.com/doc/2016-11-15/";

export interface StubInstance {
  readonly id: string;
  readonly state: string;
  readonly tags: Readonly<Record<string, string>>;
}

export interface StubVpc {
  readonly id: string;
  readonly tags: Readonly<Record<string, string>>;
}

export interface StubEc2InstancesAnswers {
  /** Pages of instances; each page but the last carries a next token. */
  readonly pages?: readonly (readonly StubInstance[])[];
  /** Pages of VPCs, before any filter; each page but the last carries a next token. */
  readonly vpcPages?: readonly (readonly StubVpc[])[];
  /** An EC2 error code to answer with, such as UnauthorizedOperation. */
  readonly error?: string;
}

export interface StubEc2Instances {
  readonly endpoint: string;
  /** Each request's form body, in order. */
  readonly requests: readonly string[];
  stop(): void;
}

function tagItems(tags: Readonly<Record<string, string>>): string {
  return Object.entries(tags)
    .map(([key, value]) => `<item><key>${key}</key><value>${value}</value></item>`)
    .join("");
}

function instanceXml({ id, state, tags }: StubInstance): string {
  return (
    `<item><instanceId>${id}</instanceId><instanceState><code>16</code><name>${state}</name>` +
    `</instanceState><tagSet>${tagItems(tags)}</tagSet></item>`
  );
}

const headers = { "content-type": "text/xml" };

function errorResponse(code: string): Response {
  return new Response(
    `<Response><Errors><Error><Code>${code}</Code><Message>stub ${code}` +
      "</Message></Error></Errors><RequestID>stub</RequestID></Response>",
    { status: 403, headers },
  );
}

/** The request's `tag:KEY` filters, each with the values it allows. */
function tagFilters(form: URLSearchParams): [string, string[]][] {
  const filters: [string, string[]][] = [];
  for (let n = 1; form.has(`Filter.${n}.Name`); n += 1) {
    const name = form.get(`Filter.${n}.Name`) ?? "";
    const values: string[] = [];
    for (let v = 1; form.has(`Filter.${n}.Value.${v}`); v += 1)
      values.push(form.get(`Filter.${n}.Value.${v}`) ?? "");
    if (name.startsWith("tag:")) filters.push([name.slice("tag:".length), values]);
  }
  return filters;
}

function describeVpcs(answers: StubEc2InstancesAnswers, body: string): Response {
  const form = new URLSearchParams(body);
  const pages = answers.vpcPages ?? [[]];
  const token = form.get("NextToken");
  const index = token === null ? 0 : Number(token.replace("page-", ""));
  const filters = tagFilters(form);
  const vpcs = (pages[index] ?? [])
    .filter(({ tags }) =>
      filters.every(([key, values]) => tags[key] !== undefined && values.includes(tags[key])),
    )
    .map(({ id, tags }) => `<item><vpcId>${id}</vpcId><tagSet>${tagItems(tags)}</tagSet></item>`)
    .join("");
  const next = index + 1 < pages.length ? `<nextToken>page-${index + 1}</nextToken>` : "";
  return new Response(
    `<DescribeVpcsResponse xmlns="${EC2_NAMESPACE}"><requestId>stub</requestId>` +
      `<vpcSet>${vpcs}</vpcSet>${next}</DescribeVpcsResponse>`,
    { headers },
  );
}

function describeInstances(answers: StubEc2InstancesAnswers, body: string): Response {
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

/**
 * Starts a stub on a free local port answering DescribeInstances and DescribeVpcs with
 * `answers`, and stops, starts and terminations with an empty success, or every request with
 * `answers.error`. Given a function, it asks it for the answers at every request, so a test can
 * change what EC2 lists while a spawned CLI runs, as a destroy does.
 */
export function stubEc2Instances(
  given: StubEc2InstancesAnswers | (() => StubEc2InstancesAnswers) = {},
): StubEc2Instances {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = await request.text();
      requests.push(body);
      const answers = typeof given === "function" ? given() : given;
      const action = new URLSearchParams(body).get("Action");
      if (answers.error) return errorResponse(answers.error);
      if (action === "DescribeVpcs") return describeVpcs(answers, body);
      if (
        action === "StopInstances" ||
        action === "StartInstances" ||
        action === "TerminateInstances"
      )
        return new Response(
          `<${action}Response xmlns="${EC2_NAMESPACE}"><requestId>stub</requestId>` +
            `<instancesSet/></${action}Response>`,
          { headers },
        );
      return describeInstances(answers, body);
    },
  });
  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}
