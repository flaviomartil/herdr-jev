import { expect, test } from "bun:test";
import { planGridSplit } from "../src/herdr/launcher.js";

const caller = "w1:p1";
const worker1 = "w1:p2";
const worker2 = "w1:p3";
const worker3 = "w1:p4";

function layout(...panes: Array<[string, number, number]>) {
  return { result: { layout: { area: { x: 0, y: 0, width: 1600, height: 900 }, splits: [], panes: panes.map(([pane_id, width, height]) => ({ pane_id, rect: { x: 0, y: 0, width, height } })) } } };
}

test("plans the initial caller split to the right", () => {
  expect(planGridSplit(layout([caller, 800, 900]), caller, [])).toEqual({ targetPaneId: caller, direction: "right", ratio: 0.5 });
});

test("splits the first worker down", () => {
  expect(planGridSplit(layout([caller, 800, 900], [worker1, 800, 450]), caller, [worker1])).toEqual({ targetPaneId: worker1, direction: "down", ratio: 0.5 });
});

test("splits the caller down for the second worker", () => {
  expect(planGridSplit(layout([caller, 800, 450], [worker1, 800, 450], [worker2, 400, 450]), caller, [worker1, worker2])).toEqual({ targetPaneId: caller, direction: "down", ratio: 0.5 });
});

test("splits the largest pane along its longer axis", () => {
  expect(planGridSplit(layout([caller, 400, 400], [worker1, 500, 300], [worker2, 500, 300], [worker3, 900, 200]), caller, [worker1, worker2, worker3])).toEqual({ targetPaneId: worker3, direction: "right", ratio: 0.5 });
});

test("ignores closed workers before choosing a grid split", () => {
  expect(planGridSplit(layout([caller, 800, 450], [worker1, 800, 450]), caller, [worker2, worker1])).toEqual({ targetPaneId: worker1, direction: "down", ratio: 0.5 });
});

test("does not target a narrow lateral sidebar", () => {
  const fixture = { result: { layout: { area: { x: 0, y: 0, width: 141, height: 41 }, splits: [], panes: [
    { pane_id: "sidebar", rect: { x: 0, y: 0, width: 28, height: 41 }, owner: "other" },
    { pane_id: caller, rect: { x: 28, y: 0, width: 113, height: 41 }, owner: "herdr-jev" },
  ] } } };
  expect(planGridSplit(fixture, caller, ["sidebar"])).toEqual({ targetPaneId: caller, direction: "right", ratio: 0.5 });
});

test("moves a narrow caller onto the largest non-lateral worker", () => {
  const fixture = { result: { layout: { area: { x: 0, y: 0, width: 141, height: 41 }, splits: [], panes: [
    { pane_id: caller, rect: { x: 0, y: 0, width: 28, height: 41 }, owner: "other" },
    { pane_id: worker1, rect: { x: 28, y: 0, width: 113, height: 41 }, owner: "herdr-jev" },
  ] } } };
  expect(planGridSplit(fixture, caller, [worker1])).toEqual({ targetPaneId: worker1, direction: "down", ratio: 0.5 });
});

test("keeps the fifth worker in the largest central pane", () => {
  const fixture = { result: { layout: { area: { x: 0, y: 0, width: 140, height: 100 }, splits: [], panes: [
    { pane_id: caller, rect: { x: 20, y: 0, width: 50, height: 50 }, owner: "herdr-jev" },
    { pane_id: worker1, rect: { x: 70, y: 0, width: 50, height: 50 }, owner: "herdr-jev" },
    { pane_id: worker2, rect: { x: 20, y: 50, width: 50, height: 50 }, owner: "herdr-jev" },
    { pane_id: worker3, rect: { x: 70, y: 50, width: 60, height: 50 }, owner: "herdr-jev" },
    { pane_id: "sidebar", rect: { x: 0, y: 0, width: 20, height: 100 }, owner: "other" },
  ] } } };
  expect(planGridSplit(fixture, caller, [worker1, worker2, worker3, "sidebar"])).toEqual({ targetPaneId: worker3, direction: "right", ratio: 0.5 });
});
