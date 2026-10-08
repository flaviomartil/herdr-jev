import { expect, test } from 'claude-code/testing'

import { analyze, detectPr, prCommandOf } from '../hooks/pr-detect'

const kind = (command: string): string | null => {
  const hit = prCommandOf(command)
  return hit === null ? null : `${hit.platform}:${hit.action}:${hit.via}`
}

const AZURE_SKILL =
  'PAT=$(vault get x)\nAPI_BASE="https://dev.azure.com/o/p/_apis"\nREPO="InvoiceConAPI"\n' +
  'curl -s -u ":${PAT}" \\\n  -X POST \\\n  -H "Content-Type: application/json" \\\n' +
  '  "${API_BASE}/git/repositories/${REPO}/pullrequests?api-version=7.0" \\\n  -d \'{"title": "T"}\' | jq .id'

test('detects the GitHub CLI forms the shell would run', () => {
  const hits: [string, string][] = [
    ['gh pr create --fill', 'github:create:cli'],
    ['gh pr new --fill', 'github:new:cli'],
    ['gh pr edit --body-file b.md', 'github:edit:cli'],
    ['gh pr ready', 'github:ready:cli'],
    ['gh -R acme/app pr create', 'github:create:cli'],
    ['gh --repo acme/app pr create', 'github:create:cli'],
    ['gh pr -R acme/app create', 'github:create:cli'],
    ['gh pr create>out.txt', 'github:create:cli'],
    ['gh pr create 2>&1 | tee log', 'github:create:cli'],
    ['gh pr create --web', 'github:create:cli'],
    ['/opt/bin/gh pr create', 'github:create:cli'],
    ["cd '/work/app' && gh pr create --title x", 'github:create:cli'],
    ['git push -u origin HEAD && \\\n gh pr create --fill', 'github:create:cli'],
    ['gh pr \\\n create --fill', 'github:create:cli'],
    ['git push\ngh pr create', 'github:create:cli'],
    ['GH_TOKEN=$(vault get x) gh pr create', 'github:create:cli'],
    ['GH_TOKEN="$(vault get x)" gh pr create', 'github:create:cli'],
    ['A=1 B="two words" gh pr create', 'github:create:cli'],
    ['git commit -m "fix: a << b shift"\ngh pr create --fill', 'github:create:cli'],
    ['cat <<< x\ngh pr create', 'github:create:cli'],
    ['cat <<EOF > body.md && gh pr create --body-file body.md\nhello\nEOF', 'github:create:cli'],
    ['gh pr create --title "x" --body "$(cat <<\'EOF\'\nSummary: fix\n\nRun gh pr view after.\nEOF\n)"', 'github:create:cli'],
    ['gh pr create --help; gh pr create --fill', 'github:create:cli'],
    ['timeout 60 gh pr create', 'github:create:cli'],
    ['timeout -s KILL 60 gh pr create', 'github:create:cli'],
    ['xargs gh pr create', 'github:create:cli'],
    ['xargs -n 1 gh pr create', 'github:create:cli'],
    ['env -u X gh pr create', 'github:create:cli'],
    ['env A=1 gh pr create', 'github:create:cli'],
    ['sudo -u u gh pr create', 'github:create:cli'],
    ['nice gh pr create', 'github:create:cli'],
    ['nice -n 5 gh pr create', 'github:create:cli'],
    ['rtk gh pr create', 'github:create:cli'],
    ['rtk -u gh pr create', 'github:create:cli'],
    ['rtk proxy gh pr create', 'github:create:cli'],
    ['command gh pr create', 'github:create:cli'],
    ['exec gh pr create', 'github:create:cli'],
    ['if ! gh pr create; then echo no; fi', 'github:create:cli'],
    ['while ! gh pr create; do sleep 1; done', 'github:create:cli'],
    ['if true; then gh pr create --fill; fi', 'github:create:cli'],
    ['git push && (gh pr create --fill)', 'github:create:cli'],
    ['echo "$(gh pr create --fill)"', 'github:create:cli'],
    ['url=`gh pr create --fill`', 'github:create:cli'],
    ['echo $(gh pr create) done', 'github:create:cli'],
    ['gh pr create | cat', 'github:create:cli'],
  ]
  for (const [command, expected] of hits) {
    expect({ command, hit: kind(command) }).toEqual({ command, hit: expected })
  }
})

test('detects Azure DevOps and the REST forms', () => {
  const hits: [string, string][] = [
    ['az repos pr create --title x --source-branch a --target-branch b', 'azure:create:cli'],
    ['az repos pr update --id 7 --status completed', 'azure:update:cli'],
    ['cd /work/app && az repos pr create --draft true', 'azure:create:cli'],
    ['AZURE_DEVOPS_EXT_PAT=$(vault get x) az repos pr create --title x', 'azure:create:cli'],
    ['AZURE_DEVOPS_EXT_PAT="$(vault get x)" az repos pr update --id 3', 'azure:update:cli'],
    [AZURE_SKILL, 'azure:create:rest'],
    ['curl -X POST -d @b.json "https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests?api-version=7.0"', 'azure:create:rest'],
    ['curl --request PATCH -d @b.json https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests/12', 'azure:update:rest'],
    ['curl -XPOST https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests', 'azure:create:rest'],
    ['curl -sSX POST https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests', 'azure:create:rest'],
    ['curl --data-binary @b.json https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests', 'azure:create:rest'],
    ['curl --json @b.json https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests', 'azure:create:rest'],
    ['http POST https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests title=x', 'azure:create:rest'],
    ['http https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests title=x', 'azure:create:rest'],
    ['wget --post-data=x https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests', 'azure:create:rest'],
    ['wget --method=POST https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests', 'azure:create:rest'],
    ['gh api -X POST repos/o/r/pulls -f title=x', 'github:create:rest'],
    ['gh api repos/o/r/pulls -f title=x -f head=a', 'github:create:rest'],
    ['gh api --method PATCH repos/o/r/pulls/5 -f title=x', 'github:edit:rest'],
    ['gh api repos/{owner}/{repo}/pulls --input b.json', 'github:create:rest'],
    ['curl -X POST -H "Authorization: Bearer $T" https://api.github.com/repos/o/r/pulls -d @b.json', 'github:create:rest'],
    ['curl -X PATCH https://api.github.com/repos/o/r/pulls/9 -d @b.json', 'github:edit:rest'],
  ]
  for (const [command, expected] of hits) {
    expect({ command, hit: kind(command) }).toEqual({ command, hit: expected })
  }
})

test('never matches quoted text, heredoc bodies, comments, echo, help, dry runs, reads or other commands', () => {
  for (const command of [
    'git commit -m "x; gh pr create --fill"',
    'git commit -m "docs: run gh pr create later"',
    "git commit -m 'a; gh pr create'",
    'echo gh pr create',
    'echo "gh pr create --fill"',
    'printf "az repos pr create"',
    'printf "%s" x\\;gh pr create',
    'cat <<EOF > notes.md\ngh pr create --fill\naz repos pr create\nEOF',
    'cat <<A <<B\ngh pr create\nA\naz repos pr create\nB',
    "cat <<'EOF'\ndon't\nEOF\ngit status",
    'ls # (gh pr create comes later)',
    'ls # ; gh pr create',
    'echo done # | gh pr create',
    'gh pr create --help',
    'gh pr create -h',
    'gh pr create \\\n --dry-run',
    'gh pr edit --help',
    'gh pr ready 5 --undo',
    'az repos pr create --help',
    'az repos pr update -h',
    'git push -u origin HEAD',
    'git push origin feat/x && echo done',
    'gh pr view 42',
    'gh pr list',
    'gh pr checkout 42',
    'gh pr status',
    'gh pr merge 3',
    'gh issue create',
    'az repos pr list',
    'az repos pr show --id 7',
    'git log --grep "gh pr create"',
    'grep -r "gh pr create" .',
    'ls',
    'curl https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests',
    'curl -X GET https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests',
    'curl -G -d status=active https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests',
    'curl --head https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests',
    'curl -X POST https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests/12/threads -d @c.json',
    'curl -X POST https://example.com/other -d x',
    'curl -X DELETE https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests/12',
    'http GET https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests',
    'wget https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests',
    'gh api repos/o/r/pulls',
    'gh api -X GET repos/o/r/pulls -f state=open',
    'gh api repos/o/r/pulls/5/comments -f body=x',
    'gh api repos/o/r/issues -f title=x',
    'curl https://api.github.com/repos/o/r/pulls',
    'curl -G -d state=open https://api.github.com/repos/o/r/pulls',
  ]) {
    expect({ command, hit: kind(command) }).toEqual({ command, hit: null })
  }
})

test('states its limits: shells, eval, aliases and az devops invoke are not followed', () => {
  for (const command of [
    'bash -c "gh pr create --fill"',
    "sh -c 'gh pr create'",
    'eval "gh pr create"',
    'cat <<EOF | bash\ngh pr create\nEOF',
    'az devops invoke --area git --resource pullRequests --http-method POST',
  ]) {
    expect({ command, hit: kind(command) }).toEqual({ command, hit: null })
  }
})

test('plans the directory only for a plain leading cd joined by &&', () => {
  const plan = (command: string) => detectPr(command)?.directory
  expect(plan('gh pr create')).toEqual({ kind: 'session' })
  expect(plan("cd '/work/app' && gh pr create")).toEqual({ kind: 'cd', target: '/work/app' })
  expect(plan('cd "/work/my app" && gh pr create')).toEqual({ kind: 'cd', target: '/work/my app' })
  expect(plan('cd ~/code && gh pr create')).toEqual({ kind: 'cd', target: '~/code' })
  expect(plan('cd sub && git push && gh pr create')).toEqual({ kind: 'cd', target: 'sub' })
  for (const command of [
    'cd a; gh pr create',
    'cd a\ngh pr create',
    '(cd a && gh pr create)',
    'pushd a && gh pr create',
    'git push && cd a && gh pr create',
    'cd -P a && gh pr create',
    'cd -- a && gh pr create',
    'cd my\\ dir && gh pr create',
    'FOO=1 cd a && gh pr create',
    'cd a && cd b && gh pr create',
    'cd a || gh pr create',
    'cd $HOME && gh pr create',
    'cd && gh pr create',
    'cd "$(pwd)" && gh pr create',
    'gh pr create && cd a',
    'gh pr create; popd',
  ]) {
    expect({ command, plan: plan(command)?.kind }).toEqual({ command, plan: 'unknown' })
  }
})

test('reports the repository and PR target a command names', () => {
  expect(detectPr('gh -R acme/app pr create')?.commands[0]?.repo).toBe('acme/app')
  expect(detectPr('gh pr create --repo=acme/app')?.commands[0]?.repo).toBe('acme/app')
  expect(detectPr('gh pr create')?.commands[0]?.repo).toBeNull()
  expect(detectPr('az repos pr create --repository InvoiceConAPI')?.commands[0]?.repo).toBe('InvoiceConAPI')
  expect(detectPr('gh pr edit 42 --title x')?.commands[0]?.targetsPr).toBe(true)
  expect(detectPr('gh pr edit --title x')?.commands[0]?.targetsPr).toBe(false)
  expect(detectPr('gh pr create --fill')?.commands[0]?.targetsPr).toBe(false)
  expect(detectPr('az repos pr update --id 7')?.commands[0]?.targetsPr).toBe(true)
  expect(detectPr(AZURE_SKILL)?.commands[0]?.repo).toBe('${REPO}')
})

test('the detector is linear on large quoted strings, heredoc markers and deep nesting', () => {
  const big = 'x'.repeat(400_000)
  const started = Date.now()
  expect(kind(`git commit -m "${big}; gh pr create"\ngh pr create --fill`)).toBe('github:create:cli')
  expect(kind(`echo '${big}'`)).toBeNull()
  expect(kind(`echo ${'<< a '.repeat(60_000)}\ngh pr create`)).toBeNull()
  expect(kind(`echo "${'q ; gh " '.repeat(30_000)}"`)).toBeNull()
  expect(kind(`${'$('.repeat(20_000)}gh pr create`)).toBeNull()
  expect(kind(`${'a '.repeat(150_000)}\ngh pr create`)).toBe('github:create:cli')
  expect(Date.now() - started).toBeLessThan(3000)
})

test('arithmetic, wrapper names from Object.prototype and curl attached data do not hide a PR command', () => {
  const hits: [string, string][] = [
    ['(( x = 1 << n ))\ngh pr create --fill', 'github:create:cli'],
    ['echo $((1<<2))\ngh pr create --fill', 'github:create:cli'],
    ['n=$(( 1 << 3 )); gh pr create', 'github:create:cli'],
    ['constructor -x; gh pr create', 'github:create:cli'],
    ['toString -x && gh pr create', 'github:create:cli'],
    ['curl https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests -d@b.json', 'azure:create:rest'],
    ['curl -d@b.json https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests', 'azure:create:rest'],
    ['curl -sSd @b.json https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests', 'azure:create:rest'],
    ['curl -X POST https://ghe.corp.example/api/v3/repos/o/r/pulls -d @b.json', 'github:create:rest'],
    ['curl -XPOST "${API_BASE}/git/repositories/${REPO}/pullrequests?api-version=7.0" -d @b.json', 'azure:create:rest'],
    ['gh pr edit --title x 42', 'github:edit:cli'],
  ]
  for (const [command, expected] of hits) {
    expect({ command, hit: kind(command) }).toEqual({ command, hit: expected })
  }
})

test('function definitions and array assignments are not executions, calling them is not tracked', () => {
  for (const command of [
    'f() { gh pr create; }',
    'f () { gh pr create --fill; }',
    'function f { gh pr create; }',
    'function f() {\n  gh pr create\n}',
    'f() {\n  echo hi\n  if true; then gh pr create; fi\n}',
    'f() ( gh pr create )',
    'cmd=(gh pr create --fill)',
    'cmd+=(az repos pr create)',
  ]) {
    expect({ command, hit: kind(command) }).toEqual({ command, hit: null })
  }
  expect(kind('f() { echo hi; }; gh pr create')).toBe('github:create:cli')
  expect(kind('f() { echo hi; }\ngh pr create')).toBe('github:create:cli')
  expect(kind('cmd=(a b); gh pr create')).toBe('github:create:cli')
  expect(kind('x=(a $(gh pr create))')).toBe('github:create:cli')
})

test('REST matches are tied to the URL operand, the host and the write method', () => {
  for (const command of [
    'curl -X POST https://example.com/git/repositories/r/pullrequests -d x',
    'curl -X POST https://dev.azure.com/o/p/git/repositories/r/pullrequests -d x',
    'curl -X POST https://example.com/x -H "Referer: https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests"',
    'curl -X POST https://example.com/x -d https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests',
    'curl -X POST https://example.com/x --data-raw https://api.github.com/repos/o/r/pulls',
    'http https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests api-version==7.0',
    'http POST https://example.com/x url=https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests',
    'curl -X POST https://evil.test/repos/o/r/pulls -d x',
    'curl -X POST "${B}/git/repositories/r/pullrequests?note=a b" -d x',
    'curl -X POST "https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests?note=a b" -d x',
    'curl -X POST https://example.com/api/repos/o/r/pulls -d x',
    'curl -X POST https://api.github.com.evil.test/repos/o/r/pulls -d x',
    'curl -X POST https://api.github.com/repos/o/r/issues -d x',
    'curl -X POST https://api.github.com/repos/o/r/pulls/5/comments -d x',
    'curl https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests',
    'gh api -X POST repos/o/r/issues -f title=x',
    'gh api repos/o/r/issues -f title=repos/o/r/pulls',
  ]) {
    expect({ command, hit: kind(command) }).toEqual({ command, hit: null })
  }
  expect(kind('http https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests title=x')).toBe('azure:create:rest')
  expect(kind('curl -X POST https://api.github.com/repos/o/r/pulls -d @b')).toBe('github:create:rest')
})

test('placeholders, variables, other heads and GH_REPO are reported on the command', () => {
  const first = (command: string) => detectPr(command)?.commands[0]
  expect(first('gh api repos/{owner}/{repo}/pulls -f title=x')?.repo).toBeNull()
  expect(first('gh api repos/acme/app/pulls -f title=x')?.repo).toBe('acme/app')
  expect(first(AZURE_SKILL)?.repo).toBe('${REPO}')
  expect(first('gh pr create --head other')?.foreign).toContain('--head')
  expect(first('gh pr create -H other')?.foreign).toContain('--head')
  expect(first('gh pr create --head=o:b')?.foreign).toContain('--head')
  expect(first('gh pr create --fill')?.foreign).toBeNull()
  expect(first('GH_REPO=o/r gh pr create')?.foreign).toContain('GH_REPO')
  expect(first('env GH_REPO=o/r gh pr create')?.foreign).toContain('GH_REPO')
  expect(first('gh pr edit --title x 42')?.targetsPr).toBe(true)
  expect(first('gh pr edit 42 --title x')?.targetsPr).toBe(true)
  expect(first('gh pr edit https://github.com/o/r/pull/9 --title x')?.targetsPr).toBe(true)
  expect(first('gh pr edit --title x')?.targetsPr).toBe(false)
})

test('herdr-jev review is recognised through wrappers, with its json flag', () => {
  const review = (command: string) => analyze(command).review
  expect(review('herdr-jev review')).toEqual({ json: false })
  expect(review('herdr-jev review --json')).toEqual({ json: true })
  expect(review('rtk -u herdr-jev review --base main')).toEqual({ json: false })
  expect(review('cd /w && timeout 900 herdr-jev review --json --base main')).toEqual({ json: true })
  expect(review('~/.bun/bin/herdr-jev review')).toEqual({ json: false })
  expect(review('herdr-jev review --help')).toBeNull()
  expect(review('herdr-jev triage x')).toBeNull()
  expect(review('echo herdr-jev review')).toBeNull()
  expect(review('git commit -m "herdr-jev review"')).toBeNull()
  expect(review('cat <<EOF\nherdr-jev review\nEOF')).toBeNull()
  expect(analyze('herdr-jev review && gh pr create').pr).not.toBeNull()
})

test('a lone parenthesis scan and function markers stay linear', () => {
  const started = Date.now()
  void kind(`${'(('.repeat(150_000)}\ngh pr create`)
  void kind(`${'f() '.repeat(100_000)}\ngh pr create`)
  expect(kind(`${'x=( '.repeat(30_000)}`)).toBeNull()
  expect(Date.now() - started).toBeLessThan(3000)
})
