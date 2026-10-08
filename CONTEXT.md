# Factory language

The factory connects prepared workers, captured work, and supervised execution.
These terms distinguish the work to be done from the attempts to execute it.

## Term index

- [Worker](#worker)
- [Work item](#work-item)
- [Run](#run)
- [Session](#session)
- [Dispatch](#dispatch)
- [Supervision](#supervision)
- [Execution backend](#execution-backend)

## Definitions

### Worker

A machine prepared to execute work for a factory.

**Avoid:** Builder when describing the machine's role.

### Work item

A captured request for development work produced by
[FFFlow's planning and capture workflow](https://github.com/bryonjacob/ffflow/blob/main/plugin/skills/plan-capture/SKILL.md),
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

### Supervision

Human observation and intervention in a run, including reconnecting to work that
started unattended.

### Execution backend

The selected mechanism for hosting and supervising runs on a worker.

**Avoid:** Control plane when referring specifically to execution hosting.
