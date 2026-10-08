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
| `paseo-password`, with `--host KEY` | `hosts[i].paseo_password_secret` of host `KEY` | `<factory ID>/<host key>/paseo-password` | `Paseo password of host <host key> of factory <factory ID>` |

Each factory's secrets are its own (D5): their names begin with the factory
ID, and each secret fffactory creates is tagged
`fffactory:factory-id = <factory ID>` and `fffactory:managed-by = fffactory`.
The hosts' IAM policy allows `secretsmanager:GetSecretValue` on exactly the
references factory.json declares
([provisioning §Modules](provisioning.md#modules)); the worker bootstrap reads
the Tailscale key by its ARN ([worker bootstrap](worker-bootstrap.md)).

Refusals, each exiting 1 with `fffactory secret set: MESSAGE` and before any
AWS call:

- an unknown name: `unknown secret name; expected tailscale-auth-key or
  paseo-password`;
- no `factory_id`: `factory.json needs factory_id before a secret can be
  named`;
- `--host` with `tailscale-auth-key`: `tailscale-auth-key belongs to the whole
  factory and takes no --host`;
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
  calls `reveal`.
- **factory.json.** Only the ARN is written.
- **Error messages.** Secrets Manager failures are reported as `Storing the
  secret in Secrets Manager failed: REASON`, where the reason is the error
  name (`AccessDeniedException`), `the credential provider failed (NAME)`,
  `network error (CODE)` or `timed out after 30 s`, never an AWS or SDK
  message, which could echo the request.

The write has a 30-second deadline (`SECRETS_MANAGER_TIMEOUT_MS`).

## Layer mapping

| Layer | Module | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/secrets.ts` | `SecretMaterial`, reading material from a prompt or standard input, the names and their targets, setting a reference in factory.json, the secrets' tags. Pure. |
| Application | `src/application/set-secret.ts` | `setSecret`: the order above. |
| Application | `src/application/secret-store.ts`, `src/application/operator-prompt.ts` | The `SecretStore` and `OperatorPrompt` ports. |
| Infrastructure | `src/infrastructure/aws-secrets-manager-store.ts` | `secretsManagerStore`: CreateSecret, then PutSecretValue for an existing secret. |
| Infrastructure | `src/infrastructure/aws-session.ts` | The deadline and failure descriptions shared with the lock store. |
| Infrastructure | `src/infrastructure/terminal-prompt.ts` | `terminalPrompt`: the hidden prompt in raw mode, and standard input with its limit. |
| CLI adapter | `src/cli/commands/secret.ts` | `fffactory secret set`: arguments, output and exit codes. |
| CLI adapter | `src/cli/main.ts` | Wires `secretsManagerStore()` and `terminalPrompt(process.stdin, process.stderr)`. |

Tests: `tests/domain/secrets.test.ts` (redaction, line endings, empty and
oversized material, names and targets, references set without disturbing
anything else, tags), `tests/application/set-secret.test.ts` (standard input
and the hidden prompt, a host's password, rotation, a replaced reference, the
account check before any material is read, refusals before AWS, material that
is cancelled, empty or too large, factory.json changing meanwhile),
`tests/infrastructure/aws-secrets-manager-store.test.ts` (stubbed calls, and
the real SDK against `tests/support/stub-secrets-manager.ts`: create then put,
tags, error names, a deadline), `tests/infrastructure/terminal-prompt.test.ts`
(raw mode on and off, nothing echoed, editing and cancelling keys, split
multi-byte input, the input limit) and `tests/cli/secret.test.ts`. The
acceptance test, that material never reaches standard output, standard error,
command arguments or factory.json, is in `tests/cli/secret.test.ts`: in
process, every output line and file is searched for the value, and a value
passed as an argument in every position is refused unechoed; and spawned,
`main.ts` runs with the real SDK against local STS and Secrets Manager
stand-ins, the value on standard input, and the value is found only in the
stand-in's stored secret.

Introduced by [#98](https://github.com/yaunder/factory/issues/98).
