/**
 * A local stand-in for EC2 `DescribeVpcs` and Service Quotas `GetServiceQuota` and
 * `GetAWSDefaultServiceQuota`, so tests exercise the real AWS SDK without reaching AWS.
 * Point clients at `endpoint`, or a spawned CLI at it with `AWS_ENDPOINT_URL_EC2` and
 * `AWS_ENDPOINT_URL_SERVICE_QUOTAS`.
 */

const EC2_NAMESPACE = "http://ec2.amazonaws.com/doc/2016-11-15/";
const QUOTAS_TARGET = "ServiceQuotasV20190624.";

/** One VPC's tags, as key/value pairs. */
export type StubVpc = Readonly<Record<string, string>>;

/** How the stub answers each service. */
export interface StubVpcQuotaAnswers {
  /** Pages of VPCs; each page but the last carries a next token. */
  readonly vpcPages?: readonly (readonly StubVpc[])[];
  /** The applied quota value; undefined answers NoSuchResourceException. */
  readonly applied?: number;
  /** The AWS default quota value. */
  readonly defaultValue?: number;
  /** An EC2 error code to answer DescribeVpcs with, such as UnauthorizedOperation. */
  readonly ec2Error?: string;
  /** Never answers, as an unreachable endpoint would not. */
  readonly hang?: boolean;
}

export interface StubVpcQuota {
  readonly endpoint: string;
  /** `DescribeVpcs` form bodies, and Service Quotas operation and JSON body, in order. */
  readonly requests: readonly string[];
  stop(): void;
}

function tagSet(tags: StubVpc): string {
  const items = Object.entries(tags).map(
    ([key, value]) => `<item><key>${key}</key><value>${value}</value></item>`,
  );
  return `<tagSet>${items.join("")}</tagSet>`;
}

function describeVpcs(answers: StubVpcQuotaAnswers, body: string): Response {
  const headers = { "content-type": "text/xml" };
  if (answers.ec2Error)
    return new Response(
      `<Response><Errors><Error><Code>${answers.ec2Error}</Code><Message>stub ` +
        `${answers.ec2Error}</Message></Error></Errors><RequestID>stub</RequestID></Response>`,
      { status: 403, headers },
    );
  const pages = answers.vpcPages ?? [[]];
  const token = new URLSearchParams(body).get("NextToken");
  const index = token === null ? 0 : Number(token.replace("page-", ""));
  const vpcs = (pages[index] ?? []).map(
    (tags, position) => `<item><vpcId>vpc-${index}${position}</vpcId>${tagSet(tags)}</item>`,
  );
  const next = index + 1 < pages.length ? `<nextToken>page-${index + 1}</nextToken>` : "";
  return new Response(
    `<DescribeVpcsResponse xmlns="${EC2_NAMESPACE}"><requestId>stub</requestId>` +
      `<vpcSet>${vpcs.join("")}</vpcSet>${next}</DescribeVpcsResponse>`,
    { headers },
  );
}

function quota(value: number): Response {
  return Response.json(
    { Quota: { ServiceCode: "vpc", QuotaCode: "L-F678F1CE", Value: value } },
    { headers: { "content-type": "application/x-amz-json-1.1" } },
  );
}

function serviceQuota(answers: StubVpcQuotaAnswers, operation: string): Response {
  if (operation === "GetServiceQuota" && answers.applied !== undefined)
    return quota(answers.applied);
  if (operation === "GetAWSDefaultServiceQuota" && answers.defaultValue !== undefined)
    return quota(answers.defaultValue);
  return Response.json(
    { __type: "NoSuchResourceException", message: "stub NoSuchResourceException" },
    { status: 400, headers: { "content-type": "application/x-amz-json-1.1" } },
  );
}

/** Starts a stub on a free local port answering EC2 and Service Quotas with `answers`. */
export function stubVpcQuota(answers: StubVpcQuotaAnswers = {}): StubVpcQuota {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = await request.text();
      const target = request.headers.get("x-amz-target");
      const operation = target?.startsWith(QUOTAS_TARGET)
        ? target.slice(QUOTAS_TARGET.length)
        : undefined;
      requests.push(operation === undefined ? body : `${operation} ${body}`);
      if (answers.hang) return new Promise<Response>(() => {});
      return operation === undefined
        ? describeVpcs(answers, body)
        : serviceQuota(answers, operation);
    },
  });
  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}
