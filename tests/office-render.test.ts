import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { rmSync, mkdirSync, writeFileSync } from 'fs';

const OFFICE_SCRIPT = join(import.meta.dir, '..', 'herdr-plugin', 'office', 'office.mjs');
const FIXTURES_DIR = join(import.meta.dir, 'fixtures', 'office');
const CLOCK = 1700000000000;

import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
const STATE_DIR = mkdtempSync(join(tmpdir(), 'office-test-'));


beforeAll(() => {
  rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(join(STATE_DIR, 'office'), { recursive: true });
  const d = new Date(CLOCK);
  const pad = (n: number) => String(n).padStart(2, '0');
  const todayStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const endedLog = [
    { name: 'Fake 1', kind: 'claude', project: 'web', branch: 'main', task: 'test', state: 'done', firstSeen: CLOCK - 3600000, lastSeen: CLOCK - 3000000, worked: 600000, waiting: 0 },
    { name: 'Fake 2', kind: 'codex', project: 'api', branch: 'fix', task: 'auth', state: 'blocked', firstSeen: CLOCK - 7200000, lastSeen: CLOCK - 3600000, worked: 3000000, waiting: 600000 }
  ];
  writeFileSync(join(STATE_DIR, 'office', `ended-${todayStr}.json`), JSON.stringify(endedLog));
});

afterAll(() => {
  rmSync(STATE_DIR, { recursive: true, force: true });
});

function buildChildEnv(columns: number) {
  const env = { ...process.env, COLUMNS: String(columns), HERDR_JEV_STATE_DIR: STATE_DIR, NO_COLOR: '1', HERDR_SOCKET_PATH: '/fake/sock', HERDR_ENV: 'live', HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 't1', HERDR_WORKSPACE_ID: 'w1', HERDR_PLUGIN_CONTEXT_JSON: '{}' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('HERDR_OFFICE_TEST_')) delete env[key];
  }
  return env;
}

function runOffice(args: string[], columns: number) {
  const res = spawnSync('node', [OFFICE_SCRIPT, '--once', `--clock=${CLOCK}`, ...args], {
    env: buildChildEnv(columns)
  });
  if (res.status !== 0) throw new Error(res.stderr.toString());
  return res.stdout.toString('utf8');
}

const widths = [100, 120, 140];

const stripAnsi = (str: string) => str.replace(/\x1b\[[0-9;]*m/g, '');

test('blocked desk (banner text, double border, header pill)', () => {
  for (const w of widths) {
    const out = runOffice(['--roster', join(FIXTURES_DIR, 'blocked.json')], w);
    expect(out).toContain('PRECISA DE VOCE');
    expect(out).toContain('╔════════════'); // double border
    expect(out).toContain('1 need you'); // header pill
    expect(stripAnsi(out.split('\n')[0]).length).toBe(w);
  }
});

test('disconnected state', () => {
  for (const w of widths) {
    const out = runOffice(['--roster', join(FIXTURES_DIR, 'empty.json'), '--state', 'disconnected'], w);
    expect(out).toContain('HERDR DESCONECTADO');
    expect(stripAnsi(out.split('\n')[0]).length).toBe(w);
  }
});

test('empty scope', () => {
  for (const w of widths) {
    const out = runOffice(['--roster', join(FIXTURES_DIR, 'empty.json'), '--state', 'empty'], w);
    expect(out).toContain('Nenhum agente neste escopo');
    expect(out).toContain('w amplia o escopo');
    expect(out).toContain('+ contrata');
    expect(stripAnsi(out.split('\n')[0]).length).toBe(w);
  }
});

test('ended view', () => {
  for (const w of widths) {
    const out = runOffice(['--roster', join(FIXTURES_DIR, 'empty.json'), '--ended'], w);
    expect(out).toContain('ENCERRADOS');
    expect(out).toContain('Fake 1');
    expect(out).toContain('Fake 2');
    expect(out).toContain('Vistos hoje: 2');
    expect(stripAnsi(out.split('\n')[0]).length).toBe(w);
  }
});

test('reduced motion (two frames at different clocks are identical)', () => {
  // If reduced motion is on, the clock tick does not show seconds, so a small time delta produces identical output
  for (const w of widths) {
    const res1 = spawnSync('node', [OFFICE_SCRIPT, '--once', `--clock=${CLOCK}`, '--roster', join(FIXTURES_DIR, 'blocked.json'), '--reduced-motion'], {
      env: buildChildEnv(w)
    }).stdout.toString('utf8');
    const res2 = spawnSync('node', [OFFICE_SCRIPT, '--once', `--clock=${CLOCK + 1000}`, '--roster', join(FIXTURES_DIR, 'blocked.json'), '--reduced-motion'], {
      env: buildChildEnv(w)
    }).stdout.toString('utf8');
    expect(res1).toEqual(res2);
  }
});
