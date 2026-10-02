import { truncate } from './text.mjs';

const ACTIVITY = {
  waiting_approval: 'approval?',
  waiting_answer: 'answer?',
};

const AGENTS = new Set(['claude', 'codex', 'opencode', 'kiro', 'gemini', 'agy']);
const WRAPPERS = new Set(['node', 'nodejs', 'python', 'python3', 'env', 'sudo', 'npx']);

const TOOLS = new Set(['bun', 'npm', 'pnpm', 'yarn', 'cargo', 'git', 'make', 'pytest', 'tsc', 'go', 'docker', 'composer', 'php', 'mvn', 'gradle']);

function words(command) {
  return String(command)
    .trim()
    .split(/\s+/)
    .filter((raw) => raw && !raw.startsWith('-'))
    .map((raw) => raw.slice(raw.lastIndexOf('/') + 1).replace(/\.(m?js|py)$/, ''))
    .filter((name) => name && !AGENTS.has(name) && !WRAPPERS.has(name));
}

function firstWord(command) {
  const all = words(command);
  return all.find((name) => TOOLS.has(name)) || all[0] || null;
}

export function monitorLabel(person, max = 12) {
  const act = person?.jevActivity;
  if (act && act !== 'unknown') return truncate(ACTIVITY[act] || act.replace(/_/g, ' '), max);
  if (!person?.command) return null;
  const word = firstWord(person.command);
  return word ? truncate(word, max) : null;
}
