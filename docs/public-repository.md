# Publishing a fresh public repository

The public destination is [yaunder/fffactory](https://github.com/yaunder/fffactory).
Its source snapshot comes from the private repository's reviewed main commit
`661d30b43385952a2e58a1b113b2095c0c60ff65`, with destination-specific installer,
test and documentation updates. Historical issue links below still refer to
the private tracker and may be inaccessible to public readers. Schema `$id`
values retain their original identifiers for compatibility; they are not
installer or runtime fetch URLs.

The initial public source commit is
[`d0793ff`](https://github.com/yaunder/fffactory/commit/d0793ff7de670e95159148e1df732ecfd37f3c44),
created on 2026-10-08 with no parent commits. No old release tags or binaries
were imported. The first public binary release is a separate maintainer action.

Create a new repository from a reviewed source snapshot. Do not mirror or fork
the private repository: the public repository starts with one new root commit,
and inherits no old tags, releases, issues, Actions runs, logs, or artifacts.
The project is licensed under the [MIT License](../LICENSE), copyright Yaunder.

Tracking: [release protection #154](https://github.com/yaunder/factory/issues/154),
[required CI #155](https://github.com/yaunder/factory/issues/155),
[access and Actions #156](https://github.com/yaunder/factory/issues/156),
[license #157](https://github.com/yaunder/factory/issues/157), and
[snapshot #158](https://github.com/yaunder/factory/issues/158).
The main-branch protections, both release-tag rulesets, read-only workflow
token defaults, approval for all external fork contributors, secret scanning
and push protection were applied and read back on 2026-10-08. Main requires
all six checks and zero reviewer approvals, including for administrators.
Adding or editing JSON files in Git does not update these live settings;
maintainers must apply and verify later policy changes explicitly.

An actual fork-approval test still needs a contributor outside the organization:
the owner is exempt from that approval policy. API read-back verifies the
configured policy, not an external user's end-to-end experience.

## Prepare the source

1. Merge the publication changes in the private repository, then export that
   exact reviewed commit with `git archive --format=tar COMMIT`. Extract it into
   a new empty directory outside this checkout. This exports committed files
   only; it excludes `.git`, untracked skills/research, local credentials,
   caches, and generated binaries. Do not use a recursive copy of the working
   directory. Inspect the archive's tracked contents for sensitive files too.
2. Scan that directory with an installed, verified Gitleaks release:
   `gitleaks dir --redact --no-banner SNAPSHOT_DIRECTORY`. Investigate every
   finding; never print raw secret values or commit scanner reports. Review
   internal account IDs, customer names, infrastructure identifiers and private
   documentation separately, since a secret scanner does not classify those.
3. Once the public repository's owner/name is known, change `REPOSITORY` in
   `install.sh`, its help/examples, the GitHub API fixtures and expectations in
   `tests/install/install.test.ts` and `tests/support/fake-github-releases.ts`,
   and current installation links in `README.md`, `MACHINE_ONBOARDING.md` and
   `docs/specs/release.md`. Inventory remaining references using
   `rg -n 'yaunder/factory'`. Historical issue/design links should be reviewed
   individually, not mechanically redirected to unrelated public issue numbers.
   Schema `$id` references are identifiers; decide whether to preserve or
   migrate them deliberately. Do not publish with the installer pointing back
   at the private repository.
4. Run `just check-all` after the destination edits, inspect the final file
   list, and repeat the snapshot scan. Initialize a fresh Git repository in
   that directory with `main` as its initial branch. Add only the reviewed
   snapshot. Never copy the old `.git` directory, remotes or tags.

## Bootstrap and protect the destination

The owner creates the destination; use its confirmed name as `PUBLIC_REPO`
below. Keep write access limited to the owner during bootstrap. Push only the
new initial `main` commit, with no release tags. No factory deployment or
release publication is part of this migration.

Before granting contributor access, apply these settings from the reviewed
checkout. Commands require GitHub CLI authentication with repository admin
access. These are explicit remote mutations, not part of CI.

```bash
PUBLIC_REPO=yaunder/fffactory
gh api "repos/$PUBLIC_REPO" --jq '{full_name,visibility,default_branch,permissions}'

gh api --method PUT "repos/$PUBLIC_REPO/branches/main/protection" \
  --input .github/main-branch-protection.json

# Create each ruleset once. For later changes, GET the rulesets and PUT the
# existing ruleset ID instead of POSTing duplicate rulesets.
gh api --method POST "repos/$PUBLIC_REPO/rulesets" \
  --input .github/release-tag-creation.json
gh api --method POST "repos/$PUBLIC_REPO/rulesets" \
  --input .github/release-tag-immutability.json

gh api --method PUT "repos/$PUBLIC_REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
gh api --method PUT "repos/$PUBLIC_REPO/actions/permissions/fork-pr-contributor-approval" \
  -f approval_policy=all_external_contributors
```

In Settings → Advanced Security, enable secret scanning and push protection.
In Settings → Actions → General, verify all external contributors require
workflow approval. The public-fork approval API is unavailable while a
repository is private. Keep PR workflows on GitHub-hosted runners, with no
secrets and no write token. An approval to run CI is not a PR review or merge
approval.

The two tag rulesets intentionally separate permission to create a version
from permission to alter it. `RepositoryRole` ID `5` means repository admin;
only that role can bypass the creation restriction. The immutability ruleset
has no bypass actors. A future release-maintainers team can be added to the
creation ruleset, without adding it to the immutability ruleset. Admins can
still edit repository policy, so admin access remains a trust boundary.
These rules protect Git tags; they do not prevent a writer from editing
GitHub Release assets through the API. Grant Write only to trusted people.

## Who may push and review

Under Settings → Collaborators and teams, give Write only to explicitly
selected contributors; reserve Admin for the owner. Organization base access
should be Read or None. Organization owners retain administrative authority.
Review installed GitHub Apps, OAuth/PAT grants and deploy keys for independent
write access; removing a human collaborator does not revoke every credential.
Require organization 2FA when collaborators are added.

The checked-in main protection requires PRs and all six current CI job checks,
an up-to-date branch, resolved conversations, and administrator enforcement.
It blocks force pushes and deletion. It deliberately requires zero approvals
while there is one maintainer: public contributors still cannot merge, but the
owner can merge their own PRs after CI passes.

`.github/CODEOWNERS` requests the owner's review of workflow, release and
dependency changes. It is not an access restriction. Before adding writers,
decide whether they may merge independently. For independent review, add a
second trusted code owner, set `required_approving_review_count` to `1`, enable
`require_code_owner_reviews` and `require_last_push_approval`, and keep stale
approval dismissal enabled. Apply the updated JSON. An author cannot approve
their own PR. If only selected writers should merge to main, configure the
branch's push restrictions for those users/teams; do not grant admin merely
to bypass review.

## Verify before inviting contributors or publishing a release

Read back the actual settings:

```bash
gh api "repos/$PUBLIC_REPO/branches/main/protection"
gh api "repos/$PUBLIC_REPO/rulesets"
# GET each returned /rulesets/ID to inspect its rules and bypass actors.
gh api "repos/$PUBLIC_REPO/actions/permissions/workflow"
gh api "repos/$PUBLIC_REPO/actions/permissions/fork-pr-contributor-approval"
gh api "repos/$PUBLIC_REPO" --jq '.security_and_analysis'
gh api "repos/$PUBLIC_REPO/collaborators" --jq '.[] | {login,role_name}'
gh api "repos/$PUBLIC_REPO/teams" --jq '.[] | {slug,permission}'
gh api "repos/$PUBLIC_REPO/keys" --jq '.[] | {id,title,read_only}'
```

Open a normal PR and verify all six required checks appear with exactly the
names in `.github/main-branch-protection.json` and GitHub Actions as the source
(app ID `15368` on github.com). A failing or pending check must block merging.
Verify a fork PR waits for maintainer workflow approval and receives neither
secrets nor write permissions. Do not create a version tag just to test
protection: that publishes a release. Check ruleset enforcement in the UI/API.

The setup is complete only when these live checks pass. Keep the migration and
settings tickets open until then. A local test run or JSON template does not
prove the destination is protected.

References: [GitHub repository roles](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization),
[rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
[Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository),
and [Gitleaks](https://github.com/gitleaks/gitleaks).
