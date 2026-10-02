# Daily Summary

`herdr-jev daily` produces a deterministic end-of-day summary per agent with zero model calls. It is designed for the owner's standup and for pasting directly into Azure DevOps work items or Trello cards.

## CLI Usage

```bash
herdr-jev daily [--json] [--md] [--plain] [--project <name>] [--since <ISO date-time>] [--write]
```

### Options

- `--json`: Output report as structured JSON.
- `--md`: Output Markdown in Brazilian Portuguese formatted for cards and standups.
- `--plain`: Output Markdown without the first line `Resumo do dia DD/MM/AAAA` for embedding into other tools.
- `--project <name>`: Filter by repository name or workspace project label (repeatable, case-insensitive). Keeps only matching project groups.
- `--since <ISO date-time>`: Scope commits and runs since the specified ISO timestamp (defaults to local midnight).
- `--write`: Save the Markdown report to `<stateDir>/daily/YYYY-MM-DD.md` (where `stateDir` honors `HERDR_JEV_STATE_DIR`, then `HERDR_PLUGIN_STATE_DIR`, and defaults to `~/.local/state/herdr-jev`), and prints the resulting path as the last output line.

Default output without `--md`, `--json`, or `--write` is an aligned text table grouped by repository and branch, displaying repository facts once under each project heading, a 34-character `TASK` column, and cell truncation with ellipsis (`...`).

The command can run inside or outside Herdr panes, and functions cleanly when invoked by a background daemon without `HERDR_PANE_ID`.

## Data Sources & Grouping

The report aggregates data through injectable dependencies:

1. **Repository Grouping**:
   - Groups by repository rather than workspace label: resolves the repository name from the basename of the main worktree (parent directory of `git rev-parse --path-format=absolute --git-common-dir`), falling back to the overview project when cwd is not a git repository.
   - Emits one section heading per `(repository, branch)`.
2. **Git Evidence (per repository & branch)**:
   - Commits since local midnight on that branch, excluding commits reachable from the default branch (`git log <default>..HEAD --since=midnight`).
   - Repository facts printed once under the heading: `N commits hoje (assunto 1; assunto 2; assunto 3)`, `M arquivos não commitados`, and `N agentes no mesmo checkout` when two or more agents share the same working directory (cwd).
3. **Pane Tasks & Terminal Output**:
   - Extracted from `herdr pane list` (`terminal_title_stripped` or `label`), trimmed to 60 characters. Omitted when empty, equal to the agent name, or when it is simply a launch command starting with `agy `, `codex `, `claude `, or `node `.
   - Reads the last 40 lines of each pane (`herdr pane read <id> --lines 40`), filters out terminal chrome (braille spinners, status bar glyphs, shortcuts, warning banners, collapsed-output hints like `expand)` and `(ctrl+o to expand)`, report headers, update notices, prompt lines), and prefers the last real action bullet (`•` for Codex, `●` for Claude Code and Antigravity).
   - Redacts sensitive credentials: tokens starting with `sk-`, `ghp_`, `xoxb-`, `Bearer`, key-value secrets, pure hex strings of 32+ characters, and strings of 32+ characters mixing letters and digits with no `/` or `.` path separators. File paths with `/` or `.` are preserved.
4. **Run History**: Projections from recorded runs (`src/orchestration/run-history.ts`) matched by pane ID, handle, or cwd, formatted via `runStateSummary`.

## Markdown Format

When `--md` is passed, output is formatted in Brazilian Portuguese:

```markdown
Resumo do dia DD/MM/AAAA

### <projeto> (<branch>)
N commits hoje (assunto 1; assunto 2; assunto 3); M arquivos não commitados; N agentes no mesmo checkout
- <agente> [<tarefa>] <modelo>: <estado>; run: <resumo>; último: <linha>
Sem atividade: a, b, c
```

- Repository facts are printed once under the group heading and omitted when empty.
- Empty fields are omitted from agent bullets.
- Inactive agents (`idle` or `done` lifecycle state, no recorded runs today, and 0 commits on the branch today) are collapsed into `Sem atividade: a, b, c` at the end of each section.
- Output contains no emojis, no en dashes, and no em dashes (only `:`, `;`, and `-`).
