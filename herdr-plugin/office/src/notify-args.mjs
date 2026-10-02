import { randomBytes } from 'node:crypto';

export const officeOwner = `${process.pid}-${randomBytes(4).toString('hex')}`;

const MAX_TITLE_CHARS = 2000;

function clipTitle(title) {
  if (title.length <= MAX_TITLE_CHARS) return title;
  return title.slice(0, MAX_TITLE_CHARS).replace(/\S+$/, '');
}

export function buildNotifyArgs(person, owner = officeOwner) {
  const cwd = typeof person.cwd === 'string' ? person.cwd : '';
  const project = cwd.split('/').pop() || 'Project';
  const taskTitle = typeof person.title === 'string' ? clipTitle(person.title) : '';
  return [
    'notify', '--pane', person.id, '--project', project, '--task', taskTitle,
    '--attention', person.status === 'blocked' ? 'now' : (person.jevAttention || 'none'),
    '--reason', person.jevBlockedReason || 'none',
    '--confidence', (person.jevConfidence || 0).toString(),
    '--native-status', person.status || 'unknown',
    '--jev-state', person.jevState || 'unknown',
    '--reason-confidence', (person.jevBlockedReasonConfidence || 0).toString(),
    '--agent', person.kind || 'unknown', '--owner', owner, '--json'
  ];
}
