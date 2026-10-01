# Daily Summary

`herdr-jev daily` produces a deterministic end-of-day summary per agent with zero model calls. It is designed for the owner's standup and for pasting directly into Azure DevOps work items or Trello cards.

## CLI Usage

```bash
herdr-jev daily [--json] [--md] [--since <ISO date-time>] [--write]
```

### Options

- `--json`: Output report as structured JSON.
- `--md`: Output Markdown in Brazilian Portuguese formatted for cards and standups.
- `--since <ISO date-time>`: Scope commits and runs since the specified ISO timestamp (defaults to local midnight).
- `--write`: Save the Markdown report to `<stateDir>/daily/YYYY-MM-DD.md` (where `stateDir` honors `HERDR_JEV_STATE_DIR` and defaults to `~/.local/state/herdr-jev`), and prints the resulting path.

Default output without `--md`, `--json`, or `--write` is a one-screen aligned text table grouped by project.

The command can run inside or outside Herdr panes, and functions cleanly when invoked by a background daemon without `HERDR_PANE_ID`.

## Data Sources

The report aggregates data through injectable dependencies:

1. **Agent Overview**: Reads workspace project name, branch, agent kind, model, lifecycle state, handle, cwd, and latest run from Herdr snapshot (`src/herdr/overview.ts`).
2. **Git Evidence (per distinct working directory)**:
   - Commits since local midnight (`git log --since=midnight --pretty=%s`), retaining total count and the first 3 commit subjects.
   - Count of uncommitted files (`git status --porcelain`).
   - Current branch (`git rev-parse --abbrev-ref HEAD`).
3. **Run History**: Projections from recorded runs (`src/orchestration/run-history.ts`) matched by pane ID, handle, or cwd, formatted via `runStateSummary`.
4. **Terminal Output**: Reads the last 40 lines of each pane (`herdr pane read <id> --lines 40`), filters out terminal chrome (spinners, box drawings, shortcuts, warning banners, prompts, model status footers), truncates to 100 characters, and redacts sensitive credentials.

## Markdown Format

When `--md` is passed, output is formatted in Brazilian Portuguese:

```markdown
Resumo do dia DD/MM/AAAA

### <projeto> (<branch>)
- <agente> <modelo>: <estado>; N commits hoje (assunto 1; assunto 2; assunto 3); M arquivos não commitados; run: <resumo>; último: <linha>
Sem atividade: a, b, c
```

- Empty fields are omitted from bullet items.
- Inactive agents (idle state, 0 commits, 0 uncommitted files, and no run) are collapsed into a single `Sem atividade: a, b, c` line at the end of each project section.
- Output contains no emojis, no en dashes, and no em dashes (only `:`, `;`, and `-`).

## Credential Redaction

Pane output and commit summaries undergo automatic redaction:
- Tokens starting with `sk-`, `ghp_`, and `xoxb-`.
- `Bearer <token>` headers.
- Long base64 or hex runs of 24 or more characters.
- Key-value pairs where the key contains `password`, `token`, `secret`, or `apikey`.
