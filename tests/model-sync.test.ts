import { expect, test } from 'bun:test';
import { formatSyncReport, syncModels, type SyncDeps } from '../src/discovery/model-sync.js';

const yaml = `clients:
  codex: {enabled: true}
delegation:
  profiles:
    - id: active
      client: codex
      advisor: alias
      executor: {model: alias, effort: high}
      reviewer: {model: alias, effort: standard}
      routes:
        moderate:
          executor:
            - {model: alias, effort: high}
models:
  codex:
    models:
      - id: gpt-live
        aliases: [alias]
        efforts: [standard, high]
`;

function fixture(models = ['gpt-live']) {
  const files = new Map<string, string>([
    ['/h/harness.yml', yaml], ['/matrix', JSON.stringify({ clients: {} })],
    ['/home/.codex/models_cache.json', JSON.stringify({ models: models.map(slug => ({ slug, visibility: 'list', supported_reasoning_levels: ['medium', 'high', 'xhigh'].map(effort => ({ effort })) })) })],
  ]);
  const deps: SyncDeps = { home: '/home', harnessRoot: '/h', matrixPath: '/matrix', overridesPath: '/overrides',
    read: path => files.get(path), write: (path, text) => { files.set(path, text); },
    run: () => ({ ok: true, stdout: '', stderr: '' }) };
  return { deps, files };
}

test('reports profile model and effort drift without changing profile choices', () => {
  const { deps, files } = fixture(['gpt-new']);
  const report = syncModels({ clients: ['codex'] }, deps);
  expect(report.status).toBe('drift');
  expect(report.profileIssues).toContainEqual(expect.objectContaining({ profile: 'active', role: 'executor', effort: 'high', reason: 'model_or_effort_not_discovered' }));
  expect(files.get('/h/harness.yml')).toBe(yaml);
  expect(formatSyncReport(report)).not.toContain('catalogs in sync');
});

test('distinguishes sync, unavailable discovery and unsupported effort', () => {
  const { deps, files } = fixture();
  expect(syncModels({ clients: ['codex'] }, deps).status).toBe('in_sync');
  files.delete('/home/.codex/models_cache.json');
  const unknown = syncModels({ clients: ['codex'] }, deps);
  expect(unknown.status).toBe('unknown');
  expect(unknown.profileIssues[0]?.reason).toBe('discovery_unavailable');
  files.set('/h/harness.yml', yaml.replace('efforts: [standard, high]', 'efforts: [standard]'));
  expect(syncModels({ clients: ['codex'] }, deps).profileIssues).toContainEqual(expect.objectContaining({ role: 'executor', reason: 'unsupported_effort', status: 'drift' }));
});

test('validation failure restores the original and is never reported in sync', () => {
  const { deps, files } = fixture(['gpt-live', 'gpt-new']);
  deps.run = () => ({ ok: false, stdout: '', stderr: 'invalid configuration' });
  const report = syncModels({ clients: ['codex'], apply: true }, deps);
  expect(report.status).toBe('validation_failed');
  expect(report.applied).toBe(false);
  expect(files.get('/h/harness.yml')).toBe(yaml);
  expect(formatSyncReport(report)).toContain('validation_failed');
});

test('suffix effort uses the exact discovered CLI id', () => {
  const { deps, files } = fixture();
  files.set('/h/harness.yml', yaml.replaceAll('codex', 'antigravity').replaceAll('gpt-live', 'gemini').replace('  antigravity:\n    models:', '  antigravity:\n    effort_style: suffix\n    models:').replace('efforts: [standard, high]', 'efforts: [standard, high]\n        effort_cli_ids: {standard: gemini-medium, high: gemini-high}'));
  deps.run = () => ({ ok: true, stdout: 'gemini-medium\tavailable\n', stderr: '' });
  const report = syncModels({ clients: ['antigravity'] }, deps);
  expect(report.status).toBe('drift');
  expect(report.profileIssues).toContainEqual(expect.objectContaining({ effort: 'high', reason: 'model_or_effort_not_discovered' }));
});


test('a real Claude profile checks consult, presenter and cross-client suffixed IDs', () => {
  const { deps, files } = fixture();
  files.set('/h/harness.yml', `clients:
  claude: {enabled: true}
models:
  claude:
    effort_style: flag
    models:
      - id: claude-opus-5-5
        aliases: [opus-5]
      - id: claude-sonnet-5-5
        aliases: [claude-sonnet-5]
      - id: claude-fable-5-2
        aliases: [fable-5]
  antigravity:
    effort_style: suffix
    models:
      - id: gemini-3-8-flash
        cli_id: gemini-3.8-flash-medium
        efforts: [standard, high]
        effort_cli_ids: {standard: gemini-3.8-flash-medium, high: gemini-3.8-flash-high}
delegation:
  profiles:
    - id: claude-opus-5
      client: claude
      advisor: opus-5
      executor: {model: claude-sonnet-5, effort: high}
      reviewer: {model: opus-5, effort: xhigh}
      consult: {model: fable-5, effort: high, on: [architectural]}
      grounded_response: {presenter: opus-5, max_feed_bytes: 1024}
      routes:
        architectural:
          executor:
            - {client: antigravity, model: gemini-3.8-flash-high}
`);
  deps.run = (command) => command === 'agy'
    ? { ok: true, stdout: 'gemini-3.8-flash-high\tavailable\n', stderr: '' }
    : { ok: true, stdout: 'ok', stderr: '' };
  const report = syncModels({ clients: ['claude', 'antigravity'], probeClaude: true }, deps);
  expect(report.profileIssues.filter(issue => issue.status === 'drift')).toEqual([]);
  expect(report.profileIssues).toContainEqual(expect.objectContaining({ role: 'consult', reason: 'effort_discovery_unavailable' }));
  deps.run = (command) => command === 'agy'
    ? { ok: true, stdout: 'gemini-3.8-flash-medium\tavailable\n', stderr: '' }
    : { ok: true, stdout: 'ok', stderr: '' };
  expect(syncModels({ clients: ['claude', 'antigravity'], probeClaude: true }, deps).profileIssues)
    .toContainEqual(expect.objectContaining({ role: 'routes.architectural.executor', model: 'gemini-3.8-flash-high', reason: 'model_or_effort_not_discovered' }));
  files.set('/h/harness.yml', files.get('/h/harness.yml')!.replace('model: gemini-3.8-flash-high}', 'model: gemini-3.8-flash-high, effort: standard}'));
  expect(syncModels({ clients: ['claude', 'antigravity'], probeClaude: true }, deps).profileIssues.some(issue => issue.role === 'routes.architectural.executor')).toBe(false);
});


test('config effort discovery uses medium for standard and reports unavailable levels', () => {
  const { deps, files } = fixture();
  files.set('/h/harness.yml', yaml.replace('  codex:\n    models:', '  codex:\n    effort_style: config\n    models:'));
  expect(syncModels({ clients: ['codex'] }, deps).status).toBe('in_sync');
  files.set('/home/.codex/models_cache.json', JSON.stringify({ models: [{ slug: 'gpt-live', visibility: 'list', supported_reasoning_levels: [{ effort: 'medium' }] }] }));
  const report = syncModels({ clients: ['codex'] }, deps);
  expect(report.profileIssues).toContainEqual(expect.objectContaining({ role: 'executor', effort: 'high', reason: 'effort_not_discovered' }));
  expect(report.profileIssues.some(issue => issue.role === 'reviewer')).toBe(false);
  files.set('/home/.codex/models_cache.json', JSON.stringify({ models: [{ slug: 'gpt-live', visibility: 'list' }] }));
  expect(syncModels({ clients: ['codex'] }, deps).status).toBe('unknown');
});

test('an uninsertable suffix remains drift after apply', () => {
  const { deps, files } = fixture();
  files.set('/h/harness.yml', yaml.replaceAll('codex', 'antigravity').replaceAll('gpt-live', 'gemini').replace('  antigravity:\n    models:', '  antigravity:\n    effort_style: suffix\n    models:').replace('efforts: [standard, high]', 'cli_id: gemini-medium\n        efforts: [standard]\n        effort_cli_ids: {standard: gemini-medium}'));
  deps.run = () => ({ ok: true, stdout: 'gemini-medium\tavailable\ngemini-high\tavailable\n', stderr: '' });
  const report = syncModels({ clients: ['antigravity'], apply: true }, deps);
  expect(report.missingInHarness.antigravity).toContain('gemini-high');
  expect(report.status).toBe('drift');
});
