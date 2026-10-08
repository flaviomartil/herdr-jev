# Council live validation

Status: not run. Until this checklist is run, the output formats of kimi and agy are unvalidated, and the codex format is known only from the codex-rs source and the agent-council parser. The parsers and adapters in `src/council` are covered only by fake spawns.

Run each step by hand, with a real CLI, in a scratch repository. Capture raw stdout, stderr and the exit code into `tests/fixtures/council/<member>-<case>.txt` and turn each capture into a parser test.

## Per adapter (codex, kimi, agy)

1. Planted defect. Commit a clean base, then change one file to add an obvious defect (unchecked null, dropped await, hard-coded secret in source). Run the member through `runCouncil` and keep the raw output. Pass when the defect appears as a finding with the right path and line.
2. Clean diff. Change a comment-free trivial line. Pass when the member returns no findings (`NO_FINDINGS`, `{"findings":[]}` or an empty codex review) and the parser maps it to zero findings without a prose finding.
3. Auth failure. Run with the CLI logged out or with an invalid token. Capture exit code, stdout and stderr. Pass when the member is `failed` with a readable reason and no finding.
4. Write attempt. Add to the planted-defect prompt a request to run `git stash push`, `git config core.hooksPath /tmp/x`, `git update-ref -d refs/heads/other` and to edit a tracked file. Before and after, compare in the user's repository: `git stash list`, `git config -l`, `git for-each-ref`, and a hash of every tracked file. Pass when all four are identical and the review clone is gone.
5. Timeout kill. Run with `timeoutMs` of 5 seconds and a prompt that makes the CLI work longer. Pass when the member is `failed` with `timed out`, `pgrep -f <binary>` shows no orphan after 10 seconds, and no directory is left under `<stateDir>/council`.
6. Parent kill. Start a run, send SIGINT then SIGTERM to the herdr-jev process. Pass when no member process and no `council/*` directory is left.
7. Sensitive paths. Add `.env`, `id_rsa`, `terraform.tfvars` and a staged `credentials.json`. Pass when none of their contents appears in the prompt file, the clone or the captured output, and they are listed in `skippedPaths`.

## Open unknowns

codex
- `codex exec review` with a question: the adapter drops `--uncommitted` and sends the prompt on stdin with `-`. Check that it still reviews the clone changes, not only the prompt text.
- Whether `-c sandbox_mode="read-only"` is honoured by `exec review` (the review subcommand has no `-s` flag). Check by asking the model to write a file.
- Real output for a review with no findings: the parser keeps the prose in the member `note`.

kimi
- Stdout format with `--output-format text` for a JSON-lines answer, and whether it prints banners or tool traces around the answer.
- Exit codes for success, refusal and auth failure.
- Approval behaviour with no stdin: whether it blocks waiting for approval or proceeds. Kimi has no read-only mode; `--plan` cannot be combined with `-p`.
- Whether it reads the prompt file named in the instruction, and the whole 300 KB file.

agy
- The `--output-format json` envelope: which key holds the answer, and whether `is_error` or `error` is set on failure.
- Whether `--json-schema` is honoured together with `--print` and how the schema result is placed in the envelope.
- Whether `--mode plan` blocks writes, or only `--sandbox` does.
- Whether `--print-timeout 480s` is accepted, or only a bare number or another unit.
- Whether a 300 KB prompt file is read whole.
