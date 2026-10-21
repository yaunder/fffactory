# Secrets

factory.json never holds a secret, only its Secrets Manager ARN
([instance configuration §Secret references](instance-configuration.md#secret-references)).
`fffactory secret set` is the guided way to put a secret there: the material
goes from a hidden prompt or standard input straight to Secrets Manager, and
factory.json receives the ARN. Design:
[fffactory-v2.md §Credentials and secrets](../designs/fffactory-v2.md#credentials-and-secrets).

## `fffactory secret set`

```text
fffactory secret set NAME [--host KEY] [--instance PATH] [--profile NAME]
```

### Names

| `NAME` | factory.json field | Secrets Manager name | Description |
| --- | --- | --- | --- |
| `tailscale-auth-key` | `tailscale.auth_key_secret` | `<factory ID>/tailscale-auth-key` | `Tailscale auth key of factory <factory ID>` |
| `tailscale-admin-client` | `tailscale.admin_client_secret` | `<factory ID>/tailscale-admin-client` | `Tailscale admin client of factory <factory ID>` |
| `paseo-password`, with `--host KEY` | `hosts[i].paseo_password_secret` of host `KEY` | `<factory ID>/<host key>/paseo-password` | `Paseo password of host <host key> of factory <factory ID>` |
| `github-token` | `credentials.github_token_secret` | `<factory ID>/github-token` | `GitHub token of factory <factory ID>` |
| `anthropic-api-key` | `credentials.anthropic_api_key_secret` | `<factory ID>/anthropic-api-key` | `Anthropic API key of factory <factory ID>` |
| `openai-api-key` | `credentials.openai_api_key_secret` | `<factory ID>/openai-api-key` | `OpenAI API key of factory <factory ID>` |

Each factory's secrets are its own (D5): their names begin with the factory
ID, and each secret fffactory creates is tagged
`fffactory:factory-id = <factory ID>` and `fffactory:managed-by = fffactory`.
The hosts' IAM policy allows `secretsmanager:GetSecretValue` on exactly the
workers' references factory.json declares, `tailscale.auth_key_secret`,
`hosts[].paseo_password_secret` and the `credentials.*_secret` it sets
([provisioning §Modules](provisioning.md#modules)); the worker bootstrap reads
the Tailscale key by its ARN ([worker bootstrap](worker-bootstrap.md)).

### The API credentials

`github-token`, `anthropic-api-key` and `openai-api-key` are the factory-wide
API credentials of a worker's three accounts, `github`, `anthropic` and
`openai` ([instance configuration §API
credentials](instance-configuration.md#api-credentials)): a GitHub token for
`gh` and git, and API keys for Claude Code and Codex. Each is optional, and
is meant for every host that does not keep a human login for its account
(`hosts[].interactive_logins`); a factory that sets none keeps every account
on a human's login. `secret set` stores them as it stores every other secret,
and, like every other, does not check that a token or key works. Setting one
again rotates it (below). Each host's projection carries the references
delivered to it, and every host's shared role may read all three
([host protocol §The host projection](host-protocol.md#the-host-projection),
[provisioning §Terraform inputs](provisioning.md#terraform-inputs)). On every
`host apply`, each host's `credentials` install step reads the ones delivered
to it with the instance role and writes each into its tool's own store; renew
one with `secret set NAME`, then `fffactory apply`
([credential delivery](credential-delivery.md)).

### The Tailscale admin client

`tailscale-admin-client` is the client secret of an operator-side Tailscale
OAuth client with the `devices:core` scope, with which `fffactory worker
terminate` deletes a terminated worker's Tailscale devices from the operator's
workstation ([worker lifecycle §Tailnet device
removal](worker-lifecycle.md#tailnet-device-removal)). It is admin-tier:
`devices:core` can remove any device in the tailnet
([machine onboarding §5](../../MACHINE_ONBOARDING.md#5-prepare-the-tailnet)).
Workers keep only their join-only auth key and never receive the admin client:
`tailscale.admin_client_secret` is in neither the host projection
([host protocol](host-protocol.md)) nor the Terraform inputs
([provisioning §Inputs](provisioning.md#terraform-inputs)), so the hosts' IAM policy
never allows reading it. It is optional: factory.json is complete without it
([instance configuration §Completeness](instance-configuration.md#completeness)),
and only `worker terminate` reads it, refusing without it. Terminate reads it
by its ARN (`GetSecretValue`, within the same 30 s deadline) under the factory
lock, and hands it, a `SecretMaterial`, to the Tailscale API adapter, which
alone reveals it, for each token request (the first, and one renewal per call
refused for an expired token); it is never printed, recorded or kept beyond
the operation. That needs `secretsmanager:GetSecretValue` on this secret, in the
operator's credentials, never the hosts'.

Refusals, each exiting 1 with `fffactory secret set: MESSAGE` and before any
AWS call:

- an unknown name: `unknown secret name; expected tailscale-auth-key,
  tailscale-admin-client, paseo-password, github-token, anthropic-api-key or
  openai-api-key`;
- no `factory_id`: `factory.json needs factory_id before a secret can be
  named`;
- `--host` with a factory-wide name, any but `paseo-password`: `NAME belongs
  to the whole factory and takes no --host`;
- `paseo-password` without `--host`: `paseo-password belongs to one host: name
  it with --host KEY`;
- a malformed host key: `--host must be a host key declared in factory.json`;
- an undeclared host: `host "KEY" is not declared in factory.json`;
- no `aws.region`: `factory.json needs aws.region: secrets are stored in the
  factory Region`.

An invalid factory.json is refused with its issues, as `validate` reports
them, and a missing instance as every command reports it.

### Order

1. Resolve the instance and print `Instance: PATH (SOURCE)`; read and
   validate it; refuse unless this fffactory is the release factory.json pins
   (`Refusing to store the secret: ...`, the
   [CLI/pin match guard](plan-apply.md#clipin-match-guard), before AWS); resolve
   the name.
2. The account check: STS in `aws.region`, refusing unless the caller is in
   `aws.account_id` (`Refusing to store the secret: SUMMARY`, with doctor's
   details and next action). No material is read before it passes.
3. Read the material (below).
4. Write it to Secrets Manager in `aws.region`, with the same credential
   selection: `CreateSecret` with the name, description, tags and the
   material as `SecretString`. When the secret already exists
   (`ResourceExistsException`), `PutSecretValue` stores the material as its
   new current value instead. Either answer's ARN must be a Secrets Manager
   secret ARN.
5. Read and validate factory.json again and set the field to the ARN,
   rewriting the document atomically with every other field and their order
   kept. A field that already holds this ARN is left alone, and the file is
   not rewritten. A different reference is replaced; it is never printed.
6. Print, on standard output:

   ```text
   Stored the Tailscale auth key of factory fff-abcd1234 in Secrets Manager as fff-abcd1234/tailscale-auth-key (a new secret).
   tailscale.auth_key_secret now refers to it: arn:aws:secretsmanager:...
   ```

   `(a new value)` for an existing secret; `already referred to it` or `now
   refers to it, in place of its previous reference` for the field.

If factory.json became invalid, or no longer declares the host, while the
secret was being stored, it is left as it is, and the command exits 1 with
`Stored the DESCRIPTION in Secrets Manager as NAME, but factory.json changed
meanwhile and no longer takes the reference. Set FIELD to ARN yourself.`

Running it again rotates the value: the secret, its ARN and factory.json stay
as they are. Running it with a factory.json that refers to a secret created
by hand stores the material under the factory's own name and points the field
at that instead.

`secret set` does not take the factory-wide lock: secrets are set up before
the first apply, when there is no state bucket to hold one, and it changes
nothing that an apply has planned.

### Reading the material

- When standard input is a terminal, a hidden prompt on standard error,
  `DESCRIPTION (input is hidden): `. This holds even with standard error
  redirected, since reading a terminal whole would echo what is typed. The terminal is
  in raw mode while it reads, so nothing typed is echoed; Enter ends the
  answer, Backspace erases, other control characters are ignored, and Ctrl-C,
  or Ctrl-D on an empty answer, cancels: `Cancelled: nothing was stored.` The
  answer is taken as typed.
- Otherwise all of standard input, such as
  `fffactory secret set tailscale-auth-key < key.txt`, less one final `\n` or
  `\r\n`.

Material that is empty or only whitespace is refused, `No secret was given:
the answer or standard input was empty. Nothing was stored.`; so is material
over Secrets Manager's 65,536-byte limit, counted in UTF-8 bytes, `The secret
is larger than Secrets Manager's 65536-byte limit. Nothing was stored.`
Standard input stops being read once it passes the limit and its line ending.

### Where the material never goes

The material reaches Secrets Manager's request and nothing else:

- **Command arguments.** It is never an argument. Arguments that do not parse
  as `secret set NAME [--host KEY] [--instance PATH] [--profile NAME]`, such
  as a pasted value after the name, in place of it, or as an option, are
  refused without being echoed:
  ``fffactory secret: expected `secret set NAME [--host KEY] [--instance PATH] [--profile NAME]`. A secret is never taken as an argument: it is read from a hidden prompt or standard input.``
  An unknown name or malformed host key is not echoed either. `secret set`
  runs no other process, so the material is in no process's arguments.
- **Standard output and error.** The hidden prompt never echoes it, and no
  message includes it. In memory it is a `SecretMaterial`
  (`src/domain/secrets.ts`), which shows as `[secret]` when printed,
  interpolated, inspected or serialized; only the Secrets Manager adapter
  calls `reveal` to store it, and only the Tailscale API adapter to use the
  admin client.
- **factory.json.** Only the ARN is written.
- **Error messages.** Secrets Manager failures are reported as `Storing the
  secret in Secrets Manager failed: REASON`, where the reason is the error
  name (`AccessDeniedException`), `the credential provider failed (NAME)`,
  `network error (CODE)` or `timed out after 30 s`, never an AWS or SDK
  message, which could echo the request.

The write has a 30-second deadline (`SECRETS_MANAGER_TIMEOUT_MS`).

## Deleting a factory's secrets

Removing a whole factory ([#56](https://github.com/yaunder/fffactory/issues/56))
deletes the secrets it owns, permanently, and confirms each is gone; it keeps
every secret it only refers to. No command calls this yet: the teardown use case
and `fffactory teardown` follow.

### Ownership

A secret belongs to factory `<id>` only when both hold (D7):

- its name starts with `<id>/` and goes on, as every name `secret set` gives
  ([Names](#names)) does; and
- it carries both tags exactly: `fffactory:factory-id = <id>` and
  `fffactory:managed-by = fffactory`.

| Secret | Is |
| --- | --- |
| `acme/tailscale-auth-key`, both tags | owned: deleted |
| `acme/builder-1/paseo-password`, both tags | owned: deleted |
| `acme/github-token`, `fffactory:factory-id = acme` only, or `managed-by` another value | tagged, not owned: kept |
| `other/github-token` or `fffv/anthropic-api-key`, both of `acme`'s tags | tagged, not owned: kept |
| `acme-lab/github-token`, tagged for `acme-lab` | not `acme`'s at all: `acme/` is not a prefix of `acme-lab/`, nor `acme` its tag |
| A factory.json reference that is no owned secret: a harness `fffv/*` source, or one made by hand | referenced, not owned: kept |

A tag alone, or a name alone, is never enough, so a harness credential source
tagged by mistake, or a secret a person named under the factory's prefix, is
never deleted. A factory.json reference is compared with the owned secrets by
ARN; a partial ARN, without the six characters Secrets Manager adds after a
hyphen, refers to the owned secret it names. Both kept groups are listed, so the
operator sees what stays.

### Listing

`ListSecrets` in the factory Region, with the operator's credentials, filtered
on the tag key `fffactory:factory-id` and the tag value `<id>`, with
`IncludePlannedDeletion`, so secrets already scheduled for deletion are listed
too; a secret with a deleted date is pending deletion. It is paginated (100 per
page, following `NextToken` until there is none, even past an empty page),
within one 30 s deadline for the whole listing, every page included. AWS matches tag filters by prefix, and
the key and value filters each by any tag, so the listing may hold another
factory's secrets (`acme-lab` for `acme`): only a secret whose
`fffactory:factory-id` tag is exactly `<id>` is the factory's, owned or only
tagged; every other is in no group. A listed secret without a name or a usable
ARN fails the listing: it is never skipped. `ListSecrets` is eventually
consistent (it "might not reflect changes from the last five minutes"); absence
is confirmed by `DescribeSecret` alone.

### Deletion and absence

Each owned secret is deleted by its ARN, in the Region that ARN names (D8).
The request carries no Region of its own: asked in another Region, Secrets
Manager answers `ResourceNotFoundException`, which would read as absence.

1. A secret pending deletion is restored first (`RestoreSecret`).
2. Then `DeleteSecret` with `ForceDeleteWithoutRecovery`: no recovery window.
   The listing is eventually consistent, so a secret it did not show pending may
   have been scheduled for deletion since. When `DeleteSecret` answers
   `InvalidRequestException` for such a secret, it is restored once and
   `DeleteSecret` tried once more; a secret listed as pending is never restored
   twice. Any failure of that restore or second deletion, `InvalidRequestException`
   again included, is `remains`.
3. Then `DescribeSecret` every 2 s until it answers
   `ResourceNotFoundException`, within 60 s (`SECRET_DELETION_DEADLINE_MS`). Each
   look after the first follows a sleep, so a stalled clock cannot stretch the
   wait.

The result is `absent`, or `remains` with a reason. Only the look's
`ResourceNotFoundException` makes it `absent` (a `RestoreSecret` or
`DeleteSecret` answering it skips to the look). Everything else is `remains`:
a call that fails, AccessDenied or any other error; a call past its 30 s
deadline, which may have reached AWS; the secret still found at the deadline
(`Secrets Manager still finds it 60 s after its deletion`); or an interrupt
while waiting (`interrupted before its absence was confirmed`). Reasons are the
AWS session's descriptions, the operation and the error name, never an AWS
message: `Secrets Manager DeleteSecret failed: AccessDeniedException`,
`Secrets Manager DescribeSecret failed: timed out after 30 s`. A restore that
fails leaves the secret pending and undeleted; a deletion that fails after a
restore leaves it restored, no longer pending. Either way a rerun lists it again
and starts over.

Why in this order, per the Secrets Manager API reference (checked 2026-10-21):

- `DeleteSecret` answers `InvalidRequestException` when "the secret is
  scheduled for deletion", so a pending secret cannot be force-deleted, only
  left to its recovery window. `RestoreSecret` "cancels the scheduled deletion
  ... by removing the `DeletedDate` time stamp", after which the forced deletion
  is allowed.
- With `ForceDeleteWithoutRecovery`, "Secrets Manager performs the actual
  deletion with an asynchronous background process, so there might be a short
  delay before the secret is permanently deleted", and "if you forcibly delete
  an already deleted or nonexistent secret, the operation does not return
  `ResourceNotFoundException`". A successful deletion therefore proves nothing:
  only `DescribeSecret` not finding the secret does.
- `DescribeSecret` still describes a secret pending deletion, with its
  `DeletedDate`, so a pending secret is never taken for an absent one.
- A secret replicated to other Regions cannot be deleted until its replicas
  are; fffactory never replicates one, and such a secret, restored and refused
  again, `remains` with `InvalidRequestException`.

### Permissions

The operator's credentials need, beyond `secret set`'s:

| Permission | Resource | For |
| --- | --- | --- |
| `secretsmanager:ListSecrets` | `*` (it is not scoped to resources) | Listing the factory's secrets. |
| `secretsmanager:RestoreSecret` | `arn:aws:secretsmanager:REGION:ACCOUNT:secret:<factory ID>/*` | Restoring a pending secret. |
| `secretsmanager:DeleteSecret` | The same | The forced deletion. |
| `secretsmanager:DescribeSecret` | The same | Confirming absence. A denial reads as `remains`, never as absence. |

## Layer mapping

| Layer | Module | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/secrets.ts` | `SecretMaterial`, reading material from a prompt or standard input, the names and their targets (the factory-wide ones under `tailscale` or `credentials`, a host's under its entry), setting a reference in factory.json, the secrets' tags, the Region a secret's ARN names (`secretRegion`); the ownership rule (`ownsSecret`), every reference factory.json holds (`secretReferences`), the classification of listed secrets and references (`classifySecrets`, which alone makes an `OwnedSecret`), and `SecretDeletion`. Pure. |
| Application | `src/application/set-secret.ts` | `setSecret`: the order above. |
| Application | `src/application/delete-owned-secret.ts` | `deleteOwnedSecret`: restore if pending, force-delete (restoring once and retrying once on `InvalidRequestException`), then look until absent, with an injected clock, sleep and interrupt and a deadline. |
| Application | `src/application/secret-store.ts`, `src/application/operator-prompt.ts` | The `SecretStore` (`write`, `read`, `list`, `restore`, `remove` with its `SecretRemoval`, `exists`) and `OperatorPrompt` ports. |
| Infrastructure | `src/infrastructure/aws-secrets-manager-store.ts` | `secretsManagerStore`: CreateSecret, then PutSecretValue for an existing secret; GetSecretValue for `worker terminate`'s admin client; ListSecrets with the tag filter, scheduled secrets and every page, RestoreSecret, DeleteSecret with `ForceDeleteWithoutRecovery` and DescribeSecret, each failure `failed` by name, `ResourceNotFoundException` `absent`, and DeleteSecret's `InvalidRequestException` `invalid`. |
| Infrastructure | `src/infrastructure/aws-session.ts` | The deadline and failure descriptions shared with the lock store. |
| Infrastructure | `src/infrastructure/terminal-prompt.ts` | `terminalPrompt`: the hidden prompt in raw mode, and standard input with its limit. |
| CLI adapter | `src/cli/commands/secret.ts` | `fffactory secret set`: arguments, output and exit codes. |
| CLI adapter | `src/cli/main.ts` | Wires `secretsManagerStore()` and `terminalPrompt(process.stdin, process.stderr)`. |

Tests: `tests/domain/secrets.test.ts` (redaction, line endings, empty and
oversized material, names and targets, references set without disturbing
anything else, tags; the ownership table, with `<id>/…` without the managed-by
tag, a tagged `other/…` and `fffv/…`, and the `acme/` and `acme-lab/` prefix
trap, every factory.json reference, the classification, and a secret's Region),
`tests/application/delete-owned-secret.test.ts` (absent at once, asked in the
Region its ARN names, absent after several looks, pending then restored then
deleted, already gone, scheduled after the listing then restored once and
deleted again or refused again, AccessDenied on the restore, deletion or look,
a deletion timed out, the deadline, a stalled clock, an interrupt),
`tests/application/set-secret.test.ts` (standard input and the hidden prompt, the admin client, a host's password, each API
credential stored and rotated, `--host` refused for each, rotation, a
replaced reference, the
account check before any material is read, refusals before AWS, material that
is cancelled, empty or too large, factory.json changing meanwhile),
`tests/infrastructure/aws-secrets-manager-store.test.ts` (stubbed calls, and
the real SDK against `tests/support/stub-secrets-manager.ts`: create then put,
tags, error names, a deadline; the listing's filter, scheduled secrets and
pages, a pending secret refused a forced deletion (`invalid`) until restored,
`InvalidRequestException` `invalid` only on a deletion, a deletion
still described for a while, a forced deletion of a secret already gone, and
AccessDenied and timeouts as `failed`), `tests/infrastructure/terminal-prompt.test.ts`
(raw mode on and off, nothing echoed, editing and cancelling keys, split
multi-byte input, the input limit) and `tests/cli/secret.test.ts`. The
acceptance test, that material never reaches standard output, standard error,
command arguments or factory.json, is in `tests/cli/secret.test.ts`: in
process, every output line and file is searched for the value, and a value
passed as an argument in every position is refused unechoed; and spawned,
`main.ts` runs with the real SDK against local STS and Secrets Manager
stand-ins, the value on standard input, and the value is found only in the
stand-in's stored secret, for the Tailscale auth key and each API
credential.

That the admin client reaches no worker is asserted in
`tests/domain/host-projection.test.ts` and
`tests/application/project-terraform-inputs.test.ts`.

Introduced by [#98](https://github.com/yaunder/factory/issues/98); the admin
client by [#8](https://github.com/yaunder/fffactory/issues/8), and its read by
[#9](https://github.com/yaunder/fffactory/issues/9); the API credentials by
[#67](https://github.com/yaunder/fffactory/issues/67); deleting a factory's
secrets by [#81](https://github.com/yaunder/fffactory/issues/81).
