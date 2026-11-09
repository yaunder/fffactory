# Factory language

The factory connects prepared workers, captured work, and supervised execution.
These terms distinguish the work to be done from the attempts to execute it.

## Layers

The factory uses the four layers Dex Horthy and Vaibhav Gupta defined on AI
That Works, as the software factory overview does. fffactory declares all four
from factory.json and a pinned release.

| Layer | What it is | In the factory |
| --- | --- | --- |
| Orchestration | Whatever assigns work to agents, tracks how it is going, and decides what happens next | Three peer parts on each worker: [dispatch](#dispatch) policy, the [trigger](#trigger) and the [execution backend](#execution-backend). Paseo is the trigger and the execution backend today, and its apps on phone and laptop the supervision path. |
| Harness | The coding agent itself | Claude Code and Codex at pinned versions, with the FFFlow plugin |
| Dev environment | What the agent needs to build and test | Packages, user accounts, and the repositories placed on the worker |
| Compute | Where the agent runs | EC2 instances defined in Terraform, reached over Tailscale |

Keeping each layer's software installed and healthy, Paseo's included, is not
a layer: it is what fffactory does to every layer, as it pins the harness.

## Term index

- [Worker](#worker)
- [Work item](#work-item)
- [Run](#run)
- [Session](#session)
- [Dispatch](#dispatch)
- [Trigger](#trigger)
- [Supervision](#supervision)
- [Execution backend](#execution-backend)

## Definitions

### Worker

A machine prepared to execute work for a factory.

**Avoid:** Builder when describing the machine's role.

### Work item

A captured request for development work produced by
[FFFlow's planning and capture workflow](https://github.com/zerotechdebt/ffflow/blob/main/plugin/skills/plan-capture/SKILL.md),
with a durable identity and completion criteria. An epic and an individual task
are different granularities of work item.

### Run

One attempt to execute a work item using a particular workflow and coding agent
in an isolated workspace. It identifies the attempt and its outcome independently
of the interactive session's availability; a deliberate retry is a new run of
the same work item.

**Avoid:** Task or session when referring to an execution attempt.

### Session

The interactive execution context through which an agent works and a human can
observe or intervene. Its lifetime is separate from the work attempt: a session
may remain available after a run ends, and losing a session does not erase the
run or establish that its work succeeded.

For example, disconnecting a laptop and reconnecting to ongoing work continues
the same session and run. If execution fails and the work is deliberately
retried, that is a new run, even if the existing session is reused.

### Dispatch

The selection and launch of eligible work within the factory's execution capacity.

**Avoid:** Scheduling when the intended meaning includes deciding what may run.

### Trigger

What starts dispatch on a worker, and when: a schedule or an explicit
invocation. It decides nothing about what may run; that is dispatch's. Paseo's
schedule is the first trigger
([dispatch trigger](docs/specs/dispatch-trigger.md)).

**Avoid:** Dispatch when the intended meaning is only when it runs.

### Supervision

Human observation and intervention in a run, including reconnecting to work that
started unattended.

### Execution backend

The selected mechanism for hosting and supervising runs on a worker: it starts
and inspects runs in isolated workspaces it owns, and is how a human connects
to them ([execution backend](docs/specs/execution-backend.md)). Paseo is the
first.

It also owns repository registration: making each repository placed on the
worker available for supervision in its own terms, such as a Paseo project
([dispatch §Repository registration](docs/specs/dispatch.md#repository-registration)).

**Avoid:** Control plane when referring specifically to execution hosting.
