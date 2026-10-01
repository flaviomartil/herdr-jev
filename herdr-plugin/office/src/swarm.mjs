export function classifyPanes(panes = [], trackingData = []) {
  const trackedWorkerIds = new Set();
  const callerToWorkers = new Map();

  if (Array.isArray(trackingData)) {
    for (const item of trackingData) {
      if (item && Array.isArray(item.rows)) {
        for (const row of item.rows) {
          const caller = row.callerPaneId;
          const worker = row.paneId;
          if (caller && worker && caller !== worker) {
            trackedWorkerIds.add(worker);
            if (!callerToWorkers.has(caller)) callerToWorkers.set(caller, []);
            callerToWorkers.get(caller).push(row);
          }
        }
      } else if (item && typeof item === 'object') {
        const caller = item.callerPaneId;
        const worker = item.workerPaneId || item.paneId;
        if (caller && worker && caller !== worker) {
          trackedWorkerIds.add(worker);
          if (!callerToWorkers.has(caller)) callerToWorkers.set(caller, []);
          callerToWorkers.get(caller).push(item);
        }
      }
    }
  } else if (trackingData instanceof Map) {
    for (const [caller, workers] of trackingData.entries()) {
      if (Array.isArray(workers)) {
        for (const w of workers) {
          const workerId = typeof w === 'string' ? w : (w.paneId || w.workerPaneId || w.pane_id);
          if (workerId && workerId !== caller) {
            trackedWorkerIds.add(workerId);
            if (!callerToWorkers.has(caller)) callerToWorkers.set(caller, []);
            callerToWorkers.get(caller).push(w);
          }
        }
      }
    }
  } else if (trackingData && typeof trackingData === 'object') {
    for (const [caller, workers] of Object.entries(trackingData)) {
      if (Array.isArray(workers)) {
        for (const w of workers) {
          const workerId = typeof w === 'string' ? w : (w.paneId || w.workerPaneId || w.pane_id);
          if (workerId && workerId !== caller) {
            trackedWorkerIds.add(workerId);
            if (!callerToWorkers.has(caller)) callerToWorkers.set(caller, []);
            callerToWorkers.get(caller).push(w);
          }
        }
      }
    }
  }

  const primaries = [];
  const subagents = [];

  for (const pane of panes) {
    const id = typeof pane === 'string' ? pane : (pane.pane_id || pane.id);
    if (trackedWorkerIds.has(id)) {
      subagents.push(pane);
    } else {
      primaries.push(pane);
    }
  }

  return {
    primaries,
    subagents,
    trackedWorkerIds,
    callerToWorkers,
  };
}

export function aggregateSwarmBadge(subagents) {
  if (!subagents || subagents.length === 0) return null;

  const count = subagents.length;
  const blocked = subagents.filter((s) => s.state === 'blocked').length;
  const working = subagents.filter((s) => s.state === 'working' || s.state === 'running').length;
  const idle = subagents.filter((s) => s.state === 'idle').length;
  const done = subagents.filter((s) => s.state === 'done').length;

  if (blocked > 0) {
    return {
      count,
      blocked,
      working,
      idle,
      done,
      text: `${count} sub \u00b7 ${blocked} blocked`,
      fg: '#ffc14d',
      bold: true,
      state: 'blocked',
    };
  }

  if (working === count) {
    return {
      count,
      blocked: 0,
      working,
      idle,
      done,
      text: `${count} sub \u00b7 working`,
      fg: '#5ce08a',
      bold: false,
      state: 'working',
    };
  }

  if (working > 0) {
    return {
      count,
      blocked: 0,
      working,
      idle,
      done,
      text: `${count} sub \u00b7 ${working} working`,
      fg: '#5ce08a',
      bold: false,
      state: 'working',
    };
  }

  if (done === count) {
    return {
      count,
      blocked: 0,
      working: 0,
      idle: 0,
      done,
      text: `${count} sub \u00b7 done`,
      fg: '#7e8a9b',
      bold: false,
      state: 'done',
    };
  }

  return {
    count,
    blocked: 0,
    working: 0,
    idle,
    done,
    text: `${count} sub \u00b7 idle`,
    fg: '#7e8a9b',
    bold: false,
    state: 'idle',
  };
}

export function demoSwarmData() {
  const demoSubagents = new Map();
  const demoTracking = [
    { callerPaneId: 'w1:p1', workerPaneId: 'w1:p1:sub1' },
    { callerPaneId: 'w1:p1', workerPaneId: 'w1:p1:sub2' },
    { callerPaneId: 'w1:p1', workerPaneId: 'w1:p1:sub3' },
    { callerPaneId: 'w2:p1', workerPaneId: 'w2:p1:sub1' },
    { callerPaneId: 'w2:p1', workerPaneId: 'w2:p1:sub2' },
  ];

  demoSubagents.set('w1:p1', [
    {
      slot: 1,
      state: 'blocked',
      loud: true,
      handle: 'worker-1-sub1',
      client: 'claude',
      model: 'sonnet-5',
      branch: 'feat/sso',
      commitsAhead: 2,
      uncommitted: 1,
      run: 'implementer: working',
      paneId: 'w1:p1:sub1',
      callerPaneId: 'w1:p1',
    },
    {
      slot: 2,
      state: 'working',
      loud: false,
      handle: 'worker-1-sub2',
      client: 'codex',
      model: 'gpt-6.1-sol',
      branch: 'feat/sso',
      commitsAhead: 1,
      uncommitted: 0,
      run: 'reviewer: verifying',
      paneId: 'w1:p1:sub2',
      callerPaneId: 'w1:p1',
    },
    {
      slot: 3,
      state: 'idle',
      loud: false,
      handle: 'worker-1-sub3',
      client: 'kiro',
      model: 'fable-5.1',
      branch: 'main',
      commitsAhead: 0,
      uncommitted: 0,
      run: null,
      paneId: 'w1:p1:sub3',
      callerPaneId: 'w1:p1',
    },
  ]);

  demoSubagents.set('w2:p1', [
    {
      slot: 1,
      state: 'working',
      loud: false,
      handle: 'worker-4-sub1',
      client: 'claude',
      model: 'sonnet-5',
      branch: 'renovate/deps',
      commitsAhead: 3,
      uncommitted: 0,
      run: 'implementer: working',
      paneId: 'w2:p1:sub1',
      callerPaneId: 'w2:p1',
    },
    {
      slot: 2,
      state: 'working',
      loud: false,
      handle: 'worker-4-sub2',
      client: 'codex',
      model: 'gpt-6.1-sol',
      branch: 'renovate/deps',
      commitsAhead: 0,
      uncommitted: 0,
      run: null,
      paneId: 'w2:p1:sub2',
      callerPaneId: 'w2:p1',
    },
  ]);


  return { demoSubagents, demoTracking };
}

