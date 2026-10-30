/**
 * docs/specs/host-protocol.md §The collector step: the collector's systemd units and its
 * configuration, as the `collector` install step writes them. Pure.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  COLLECTOR_COMMAND_TIMEOUT_MS,
  COLLECTOR_INACCESSIBLE,
  COLLECTOR_LIMITS,
  COLLECTOR_SERVICE,
  COLLECTOR_SERVICE_UNIT,
  COLLECTOR_STATE,
  COLLECTOR_STOP_TIMEOUT,
  COLLECTOR_STATE_DIRECTORY,
  COLLECTOR_TIMER,
  COLLECTOR_TIMER_UNIT,
  COLLECTOR_UNITS,
  collectorConfigurationOf,
  collectorConfigurationText,
  INHERITED_AWS_SETTINGS,
} from "../../src/domain/collector-installation";
import {
  COLLECTED_DIRECTORIES,
  COLLECTOR_CONFIGURATION,
  collectorConfigurationJson,
  parseCollectorConfiguration,
} from "../../src/domain/collector";
import { CLAUDE_ROOT } from "../../src/domain/archive-format";
import { ANTHROPIC_KEY_FILE } from "../../src/domain/installation";
import { DISPATCH_GATES } from "../../src/domain/dispatch-readiness";
import { hostProjection } from "../../src/domain/host-projection";
import { WORKER_PATHS, WORKER_SERVICES } from "../../src/domain/host-protocol";
import type { FactoryId, HostKey, Release } from "../../src/domain/instance";

const FIXTURES = join(import.meta.dir, "fixtures", "archive");

/** The unit's lines in `section`, as `[key, value]`, in order; comments and blanks left out. */
function directives(unit: string, section: string): [string, string][] {
  const lines = unit.split("\n");
  const start = lines.indexOf(`[${section}]`);
  if (start === -1) return [];
  const end = lines.findIndex((line, index) => index > start && line.startsWith("["));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    });
}

function values(unit: string, section: string, key: string): string[] {
  return directives(unit, section)
    .filter(([name]) => name === key)
    .map(([, value]) => value);
}

const UNSET: readonly string[] = INHERITED_AWS_SETTINGS;
const INACCESSIBLE: readonly string[] = COLLECTOR_INACCESSIBLE;
const SERVICE = (key: string) => values(COLLECTOR_SERVICE_UNIT, "Service", key);
const TIMER = (key: string) => values(COLLECTOR_TIMER_UNIT, "Timer", key);

describe("the collector's service unit", () => {
  test("is a oneshot running host collect --once from the active release, as factory", () => {
    expect(COLLECTOR_SERVICE).toBe("fffactory-collector.service");
    expect(SERVICE("Type")).toEqual(["oneshot"]);
    expect(SERVICE("ExecStart")).toEqual([
      "/opt/fffactory/current/bin/fffactory host collect --once",
    ]);
    expect(SERVICE("User")).toEqual(["factory"]);
    expect(SERVICE("Group")).toEqual(["factory"]);
  });

  test("keeps its state in the directory the collection run uses", () => {
    expect(SERVICE("StateDirectory")).toEqual([COLLECTOR_STATE_DIRECTORY]);
    expect(SERVICE("StateDirectoryMode")).toEqual(["0700"]);
    expect(COLLECTOR_STATE).toBe(`/var/lib/${COLLECTOR_STATE_DIRECTORY}`);
    expect(COLLECTOR_STATE).toBe("/var/lib/fffactory-collector");
  });

  test("is sandboxed", () => {
    expect(SERVICE("ProtectSystem")).toEqual(["strict"]);
    expect(SERVICE("ProtectHome")).toEqual(["read-only"]);
    expect(SERVICE("NoNewPrivileges")).toEqual(["true"]);
    expect(SERVICE("PrivateTmp")).toEqual(["true"]);
  });

  test("cannot reach the credential stores, each optional", () => {
    expect(SERVICE("InaccessiblePaths")).toEqual(COLLECTOR_INACCESSIBLE.map((path) => `-${path}`));
    for (const store of [
      `${CLAUDE_ROOT}/.credentials.json`,
      `${CLAUDE_ROOT}/.session_ingress_token`,
      "/home/factory/.claude.json",
      "/home/factory/.claude.json.backup",
      "/home/factory/.config/fffactory",
      "/home/factory/.config/gh",
      "/home/factory/.codex",
      "/home/factory/.aws",
      "/home/factory/.ssh",
      "/home/factory/.git-credentials",
      "/home/factory/.paseo/config.json",
    ])
      expect(INACCESSIBLE).toContain(store);
    const hidden = (path: string) =>
      COLLECTOR_INACCESSIBLE.some((store) => path === store || path.startsWith(`${store}/`));
    expect(hidden(ANTHROPIC_KEY_FILE)).toBe(true);
    // Nothing host collect --once reads or writes is hidden.
    for (const needed of [
      COLLECTOR_CONFIGURATION,
      `${WORKER_PATHS.releases}/1.2.3/steps/versions.env`,
      `${WORKER_PATHS.activeRelease}/bin/fffactory`,
      COLLECTOR_STATE,
      CLAUDE_ROOT,
      ...COLLECTED_DIRECTORIES.map((directory) => `${CLAUDE_ROOT}/${directory}/a`),
      "/proc/self/fd",
      "/proc/sys/kernel/random/boot_id",
    ]) {
      expect({ needed, hidden: hidden(needed) }).toEqual({ needed, hidden: false });
    }
  });

  test("stops within the step's command deadline", () => {
    expect(SERVICE("TimeoutStopSec")).toEqual([COLLECTOR_STOP_TIMEOUT]);
    // systemd waits once for the run, and once more for survivors of its SIGKILL.
    expect(2 * Number.parseInt(COLLECTOR_STOP_TIMEOUT, 10) * 1000).toBeLessThan(
      COLLECTOR_COMMAND_TIMEOUT_MS,
    );
  });

  test("is bounded in memory, CPU, I/O priority and time", () => {
    expect(COLLECTOR_LIMITS).toEqual({
      memoryHigh: "384M",
      memoryMax: "512M",
      cpuQuota: "50%",
      timeoutStart: "55s",
      tasksMax: "64",
      cpuWeight: "20",
    });
    expect(SERVICE("MemoryHigh")).toEqual(["384M"]);
    expect(SERVICE("MemoryMax")).toEqual(["512M"]);
    expect(SERVICE("CPUQuota")).toEqual(["50%"]);
    expect(SERVICE("CPUWeight")).toEqual(["20"]);
    expect(SERVICE("TasksMax")).toEqual(["64"]);
    expect(SERVICE("Nice")).toEqual(["10"]);
    expect(SERVICE("IOSchedulingClass")).toEqual(["idle"]);
    expect(SERVICE("TimeoutStartSec")).toEqual(["55s"]);
  });

  test("has no tie to paseo.service, or to any other unit", () => {
    for (const unit of [COLLECTOR_SERVICE_UNIT, COLLECTOR_TIMER_UNIT]) {
      expect(unit).not.toContain("paseo.service");
      for (const section of ["Unit", "Service", "Timer"])
        for (const key of ["Requires", "Requisite", "BindsTo", "PartOf", "After", "Wants"])
          expect({ section, key, values: values(unit, section, key) }).toEqual({
            section,
            key,
            values: [],
          });
    }
    expect(directives(COLLECTOR_SERVICE_UNIT, "Install")).toEqual([]);
  });

  test("keeps factory's AWS configuration, and any endpoint the manager passes, from the SDK", () => {
    expect(SERVICE("Environment")).toEqual([
      "AWS_CONFIG_FILE=/dev/null",
      "AWS_SHARED_CREDENTIALS_FILE=/dev/null",
      "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true",
    ]);
    expect(SERVICE("UnsetEnvironment")).toEqual([INHERITED_AWS_SETTINGS.join(" ")]);
    for (const name of [
      "AWS_EC2_METADATA_SERVICE_ENDPOINT",
      "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
      "AWS_EC2_METADATA_DISABLED",
      "AWS_ENDPOINT_URL",
      "AWS_ENDPOINT_URL_S3",
      "AWS_ENDPOINT_URL_STS",
      "AWS_PROFILE",
    ])
      expect(UNSET).toContain(name);
    // An unset name would also drop the unit's own assignment of it.
    for (const set of [
      "AWS_CONFIG_FILE",
      "AWS_SHARED_CREDENTIALS_FILE",
      "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS",
    ])
      expect(UNSET).not.toContain(set);
  });

  test("is one final newline long, with no carriage return", () => {
    for (const unit of [COLLECTOR_SERVICE_UNIT, COLLECTOR_TIMER_UNIT]) {
      expect(unit.endsWith("\n")).toBe(true);
      expect(unit.endsWith("\n\n")).toBe(false);
      expect(unit).not.toContain("\r");
    }
  });
});

describe("the collector's timer", () => {
  test("runs the service a minute after boot, then a minute after each run ends", () => {
    expect(COLLECTOR_TIMER).toBe("fffactory-collector.timer");
    expect(TIMER("OnBootSec")).toEqual(["60s"]);
    expect(TIMER("OnUnitInactiveSec")).toEqual(["60s"]);
    expect(TIMER("AccuracySec")).toEqual(["5s"]);
    expect(TIMER("Unit")).toEqual([COLLECTOR_SERVICE]);
    expect(values(COLLECTOR_TIMER_UNIT, "Install", "WantedBy")).toEqual(["timers.target"]);
  });

  test("is installed beside the service in systemd's administrator directory", () => {
    expect(COLLECTOR_UNITS).toEqual([
      { path: "/etc/systemd/system/fffactory-collector.service", text: COLLECTOR_SERVICE_UNIT },
      { path: "/etc/systemd/system/fffactory-collector.timer", text: COLLECTOR_TIMER_UNIT },
    ]);
    expect(COLLECTOR_COMMAND_TIMEOUT_MS).toBe(60_000);
  });
});

describe("the collector's configuration, from the host projection", () => {
  const ARCHIVE = { bucket: "fff-r29c2un6-logs-123456789012-us-east-1-an", region: "us-east-1" };

  test("names the worker and the archive while the projection carries it", async () => {
    const projection = hostProjection(
      "fff-r29c2un6" as FactoryId,
      "builder-1" as HostKey,
      "0.3.0" as Release,
      undefined,
      undefined,
      ARCHIVE,
    );
    const configuration = collectorConfigurationOf(projection);
    if (configuration === undefined) throw new Error("no configuration");
    expect(collectorConfigurationJson(configuration)).toBe(
      JSON.stringify(
        {
          format: 1,
          factory_id: "fff-r29c2un6",
          host_key: "builder-1",
          bucket: ARCHIVE.bucket,
          region: ARCHIVE.region,
        },
        null,
        2,
      ),
    );
    const text = collectorConfigurationText(configuration);
    expect(text).toBe(await Bun.file(join(FIXTURES, "collector.json")).text());
    expect(parseCollectorConfiguration(text)).toEqual({ ok: true, document: configuration });
  });

  test("is none without the archive", () => {
    const projection = hostProjection(
      "fff-r29c2un6" as FactoryId,
      "builder-1" as HostKey,
      "0.3.0" as Release,
    );
    expect(collectorConfigurationOf(projection)).toBeUndefined();
  });
});

describe("the collector's health (plan and apply §The workers stage)", () => {
  test("is no worker service and no dispatch gate", () => {
    expect(WORKER_SERVICES).toEqual(["tailscaled"]);
    expect(DISPATCH_GATES).toEqual([
      "worker_release",
      "github_credential",
      "repository_sync",
      "ffflow_adoption",
      "paseo_health",
    ]);
  });
});
