import { parseArgs } from "node:util";
import { cacheDirectoryPath } from "../../application/cache-directory";
import {
  credentialSelection,
  PROFILE_ENVIRONMENT_VARIABLE,
} from "../../application/caller-identity";
import { doctor } from "../../application/doctor";
import { INSTANCE_ENVIRONMENT_VARIABLE } from "../../application/resolve-instance";
import {
  attentionCount,
  type CheckResult,
  type CheckStatus,
  type DoctorReport,
  exitCodeFor,
} from "../../domain/check-result";
import type { Release } from "../../domain/instance";
import type { CliContext, Command } from "../context";

/**
 * Version of the `--json` output format; `schemas/doctor-report.schema.json` publishes it.
 * Additions keep it; removing, renaming or redefining a field needs a new version.
 */
export const DOCTOR_JSON_SCHEMA_VERSION = 1;

/** One check in a versioned JSON report. */
export function checkJson(check: CheckResult) {
  return {
    id: check.id,
    title: check.title,
    status: check.status,
    summary: check.summary,
    details: [...check.details],
    next_action: check.nextAction,
  };
}

/** The versioned JSON document, with keys in a fixed order. */
export function doctorJson(report: DoctorReport, release: Release) {
  return {
    schema_version: DOCTOR_JSON_SCHEMA_VERSION,
    release,
    status: report.status,
    capabilities: report.capabilities.map((group) => ({
      id: group.id,
      title: group.title,
      status: group.status,
      checks: group.checks.map(checkJson),
    })),
  };
}

const LABELS: Readonly<Record<CheckStatus, string>> = {
  ready: "ready",
  not_ready: "not ready",
  error: "error",
};
const RESULTS: Readonly<Record<CheckStatus, string>> = {
  ready: "Ready",
  not_ready: "Not ready",
  error: "Error",
};
const STATUS_WIDTH = Math.max(...Object.values(LABELS).map((label) => label.length));
const INDENT = " ".repeat(2 + STATUS_WIDTH + 2);

/** One check in a human-readable report: status, title, summary, details and next action. */
export function checkLines(check: CheckResult): string[] {
  return [
    `  ${LABELS[check.status].padEnd(STATUS_WIDTH)}  ${check.title}: ${check.summary}`,
    ...check.details.map((detail) => `${INDENT}  ${detail}`),
    ...(check.nextAction === null ? [] : [`${INDENT}Next: ${check.nextAction}`]),
  ];
}

function resultLine(report: DoctorReport): string {
  const { attention, total } = attentionCount(report);
  if (attention === 0) return `${RESULTS.ready}: all ${total} checks are ready.`;
  const verb = attention === 1 ? "needs" : "need";
  return `${RESULTS[report.status]}: ${attention} of ${total} checks ${verb} attention.`;
}

/** The human-readable report, one line per element. */
export function doctorText(report: DoctorReport, release: Release): string[] {
  return [
    `fffactory doctor, release ${release}`,
    ...report.capabilities.flatMap((group) => [
      "",
      `${group.title}: ${LABELS[group.status]}`,
      ...group.checks.flatMap(checkLines),
    ]),
    "",
    resultLine(report),
  ];
}

async function runDoctor(args: readonly string[], context: CliContext): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      instance: { type: "string" },
      profile: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.profile === "") {
    context.err("fffactory doctor: --profile needs a profile name");
    return 1;
  }
  const report = await doctor(
    {
      store: context.store,
      tools: context.tools,
      cache: context.cache,
      assets: context.assets,
      identity: context.identity,
      terraform: context.terraform,
      vpcQuota: context.vpcQuota,
    },
    {
      selection: {
        flag: values.instance,
        environment: context.env[INSTANCE_ENVIRONMENT_VARIABLE],
        cwd: context.cwd,
        home: context.home,
      },
      cacheDirectory: cacheDirectoryPath(context.env, context.home),
      release: context.release,
      credentials: credentialSelection(values.profile, context.env[PROFILE_ENVIRONMENT_VARIABLE]),
    },
  );
  // Interrupted, its tools were stopped: a report would show that, not the machine. fffactory
  // exits with the signal's status.
  if (context.interrupted()) return 1;
  if (values.json) context.out(JSON.stringify(doctorJson(report, context.release), null, 2));
  else for (const line of doctorText(report, context.release)) context.out(line);
  return exitCodeFor(report.status);
}

export const doctorCommand: Command = {
  summary:
    "Check local tools, configuration, AWS account, VPC quota and cache readiness (read-only)",
  usage: [
    "Usage: fffactory doctor [--instance PATH] [--profile NAME] [--json]",
    "",
    "Reports, by capability, whether OpenSSH and a logged-in Tailscale client are",
    "available, whether the selected factory.json is valid and complete, whether",
    "the AWS credentials belong to its account, whether its Region has room",
    "for the factory's VPC, whether the FFFactory cache directory is usable,",
    "whether this executable's release assets are intact, and whether the",
    "managed Terraform is installed.",
    "Every check that is not ready names its next action.",
    "doctor changes nothing. It calls STS GetCallerIdentity and, only in the",
    "factory's own account, EC2 DescribeVpcs and Service Quotas GetServiceQuota.",
    "",
    "  --instance PATH  Select the instance, as for `fffactory validate`.",
    "  --profile NAME   Use this AWS profile. Otherwise AWS_PROFILE, or else the",
    "                   standard AWS credential chain.",
    "  --json           Print a versioned JSON report instead of text.",
    "",
    "Exits 0 when everything is ready, 2 when something is not ready, and 1 when",
    "doctor could not inspect something or its arguments are invalid.",
  ],
  run: runDoctor,
  waitsOnInterrupt: true,
};
