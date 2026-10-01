export function buildNotifyArgs(person) {
  const project = person.cwd ? person.cwd.split('/').pop() : 'Project';
  const taskTitle = (person.title || '').substring(0, 80);
  return [
    'notify', '--pane', person.id, '--project', project, '--task', taskTitle,
    '--attention', person.status === 'blocked' ? 'now' : (person.jevAttention || 'none'),
    '--reason', person.jevBlockedReason || 'none',
    '--confidence', (person.jevConfidence || 0).toString(),
    '--native-status', person.status || 'unknown',
    '--jev-state', person.jevState || 'unknown',
    '--reason-confidence', (person.jevBlockedReasonConfidence || 0).toString(),
    '--agent', person.kind || 'unknown', '--json'
  ];
}
