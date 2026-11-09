# Paseo touch points on origin/main (fdbf5d6, release 0.0.10, Paseo 0.15.0)

Inventory taken 2026-11-06 from the worktree /tmp/fffactory-origin-main. This
is the seed for the boundary test's allow-list (plan step 1).

## Worker side

| Category | File | What |
| --- | --- | --- |
| run-launch | `assets/steps/dispatch/factory-dispatch:278-289` | `paseo run --no-wait --json --provider --mode --new-workspace worktree --worktree-mode branch-off --new-branch --base --cwd --label factory-*`; reads `agentId` |
| run-launch | `factory-dispatch:271-273` | scrubs `PASEO_AGENT_ID`, `PASEO_WORKSPACE_ID` |
| run-launch | `factory-dispatch:28-29, 204` | `FACTORY_PASEO_BIN` default `paseo-auth.sh`; lock at `$PASEO_HOME/factory-dispatch.lock` |
| run-list | `factory-dispatch:166-172` | duplicate check: `paseo ls --global --background --label factory-dispatch=true --label factory-repository=A --label factory-epic=N --json` |
| run-list | `factory-dispatch:156-163` | capacity already via `fffactory host agents --json` (D7); Python copy of states/busy rule 37-40, 142-153 |
| run-list, status-mapping | `src/host/control-plane.ts:68-158` | `PaseoCommand`, `paseoAgents` (`ls --global --background`, labelled `ls`, `agent inspect` per running agent), `STATE_OF` to the five states |
| run-list | `src/host/control-plane.ts:170-230` | `authWrapper`, `asFactory`, `factoryPaseo`, `activity()` (root) and `agents()` (factory, calls `paseo-auth.sh` directly) |
| daemon-lifecycle, auth | `src/host/control-plane.ts:25-65, 231-255` | bcrypt cost 12, `install()` → `setup-host.sh`, `reload()` → `daemon reload`, `restart()` → `systemctl restart paseo.service` |
| dispatch-trigger | `src/host/dispatch.ts:72-86, 283-299` | `PASEO_HOME` in `factoryCommand`; runs `dispatch-schedule.sh` with `FACTORY_PASEO_BIN` |
| repo-registration | `src/host/dispatch.ts:228-259` | `executionBackend(factoryPaseo(...))` |
| repo-registration | `src/host/execution-backend.ts`, `src/host/paseo-backend.ts` | the seam and its adapter (`project ls|create`) |
| dispatch-trigger | `assets/steps/dispatch/dispatch-schedule.sh` | `schedule ls|inspect|create|update|resume|delete`, drift check on Paseo's schedule JSON |
| daemon-lifecycle, auth, listen | `assets/steps/control-plane/{setup-host.sh,paseo-config.sh,paseo-auth.sh,paseo.service,versions.env}` | install `@getpaseo/cli@0.15.0`, config merge (listen `:6767`, relay off, hostnames, password hash, dictation/voice off), auth wrapper, unit |
| work-inspection | `src/domain/work-inspection.ts:28-29`, `src/host/work.ts:3,61,402,560-564` | `/home/factory/.paseo/worktrees` as a search root |
| collector-exclusion | `src/domain/collector-installation.ts:68` | `/home/factory/.paseo/config.json` in `COLLECTOR_INACCESSIBLE` |
| collector (implicit) | archive fixtures, `tests/domain/archive-format.test.ts:40,133` etc. | Claude project dirs encode the worktree path `-home-factory--paseo-worktrees-…` |
| skill text | `assets/steps/dispatch/skill/SKILL.md:4,14,33` | names Paseo agents, worktrees, permission queue |
| names | `src/domain/repository-registration.ts:13-14` | `EXECUTION_BACKENDS = ["paseo"]` |

## Operator side

| Category | File | What |
| --- | --- | --- |
| control-plane-port | `src/application/control-plane.ts:15-48` | `ControlPlane`: `health`, `agents` (→ `AgentsObservation`), `install`, `reload`, `restart`; `readAgents` |
| control-plane adapter | `src/infrastructure/paseo-control-plane.ts` | port 6767, `/api/health` curl; activator actions `control-plane activity|install|reload|restart` |
| change-classification (names, #93) | `src/domain/change-classification.ts:32-61`, `src/application/plan-control-plane.ts` | `paseo-configuration`, `paseo-package`, `service-definition`, `listen-address`, `password` |
| dispatch gate (name, #93) | `src/domain/dispatch-readiness.ts:21-22,37,53-54,133-139`, `src/application/apply-factory.ts:1180-1230` | `paseo_health` |
| stale reason (name, #93) | `src/domain/plan.ts:979-980`, `src/cli/presentation/plan.ts:547-556` | `paseo_changed` |
| secret (name, #93) | `src/domain/secrets.ts`, `src/domain/instance.ts:87,179,426-427,524-547`, `src/domain/host-projection.ts`, `src/application/project-terraform-inputs.ts:36-37,110-111`, `src/domain/host-removal.ts`, `src/cli/commands/{secret,init}.ts` | `paseo-password`, `paseo_password_secret` (required per host) |
| wording (#93) | `src/domain/readiness.ts:28-29,50-54`, `src/cli/presentation/apply.ts`, `src/cli/presentation/plan.ts:211,239-248,283`, `src/application/apply-control-plane.ts`, `src/domain/operation.ts:36`, `src/domain/worker-lifecycle.ts:435`, `src/cli/context.ts:62` | "Paseo clients", "Paseo is unchanged", "register N as Paseo projects" (TODO per backend), failure messages, "~/.paseo/worktrees" |
| workflow-queue | `src/application/workflow-queue.ts`, `src/infrastructure/ffflow-github-workflow-queue.ts` | reaches Paseo only through the worker's `dispatch` endpoint; doc comment says "Paseo schedule" |
| wiring | `src/cli/main.ts:144-145` | `paseoControlPlane(transport)` |

## Infrastructure

| File | What |
| --- | --- |
| `assets/terraform/factory/main.tf:29`, `variables.tf:90-107` | IAM grant on `paseo_password_secret_arns` (name, #93) |
| `scripts/terraform-check.ts`, `scripts/terraform-removal-check.ts` | assert that grant |
| `assets/terraform/bootstrap/fffactory-activate` | fixed actions `control-plane activity|install|reload|restart`, `dispatch adoption|reconcile|inspect`; first-boot user data, not updatable by upgrade |

## Tests and checks naming Paseo

`tests/paseo/` (`hash-only-daemon.sh`, `hash-main.ts`, `just paseo-check`),
`tests/host/paseo-backend.test.ts`, `tests/infrastructure/paseo-control-plane.test.ts`,
`tests/host/control-plane.test.ts`, `tests/host/dispatch.test.ts`, `tests/assets/steps/steps.test.ts:177-255`
(static checks on the unit and setup), `assets/steps/*/tests/*.py`,
`tests/domain/collector-installation.test.ts:150-152`, archive fixtures.

No test enforces an allow-list of files that may name Paseo.

## Specs

Paseo is named in 14 of 18 specs; the sections that carry behavior are
control-plane.md (Agent states 131, The busy rule 184, Worker protocol 215,
Release-owned installation 243, The daemon password 285, The Paseo pin 346),
dispatch.md (programs 145, Capacity 204, Repository registration 261, The
execution backend 345) and host-protocol.md (activity 1098, agents 1150).
