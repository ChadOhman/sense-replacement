import { describe, expect, it } from 'vitest';
import { EventCaptureDetector } from './capture.js';

/** Run a flat stretch of samples through the detector. */
function feedFlat(det: EventCaptureDetector, fromTs: number, toTs: number, w: number): void {
  for (let ts = fromTs; ts <= toTs; ts++) expect(det.sample(ts, w)).toBeNull();
}

describe('EventCaptureDetector', () => {
  it('captures a +500 W step as one on-event with the right waveform', () => {
    const det = new EventCaptureDetector();
    feedFlat(det, 0, 9, 500);
    expect(det.sample(10, 1000)).toBeNull(); // trigger, capture starts
    // 18 more samples inside the window, still steady at the new level
    for (let ts = 11; ts <= 28; ts++) expect(det.sample(ts, 1000)).toBeNull();
    const event = det.sample(29, 1000); // 20th sample completes the window
    expect(event).not.toBeNull();
    expect(event!.startTs).toBe(10);
    expect(event!.direction).toBe('on');
    expect(event!.deltaW).toBe(500);
    expect(event!.waveform).toHaveLength(20);
    expect(event!.waveform[0]).toBe(500);
    expect(event!.waveform.slice(1).every((d) => d === 0)).toBe(true);
  });

  it('ignores sub-threshold noise', () => {
    const det = new EventCaptureDetector();
    for (let ts = 0; ts <= 100; ts++) {
      expect(det.sample(ts, 500 + (ts % 2 === 0 ? 10 : -10))).toBeNull();
    }
  });

  it('absorbs re-triggers inside the window into one event', () => {
    const det = new EventCaptureDetector();
    feedFlat(det, 0, 4, 500);
    expect(det.sample(5, 1000)).toBeNull(); // +500 triggers
    expect(det.sample(6, 1600)).toBeNull(); // +600 inside window — no new capture
    let event = null;
    for (let ts = 7; ts <= 24; ts++) event = det.sample(ts, 1600);
    expect(event).not.toBeNull();
    expect(event!.startTs).toBe(5);
    expect(event!.deltaW).toBe(1100); // both steps in one waveform
  });

  it('reports a negative step as an off-event', () => {
    const det = new EventCaptureDetector();
    feedFlat(det, 0, 4, 2000);
    expect(det.sample(5, 800)).toBeNull();
    let event = null;
    for (let ts = 6; ts <= 24; ts++) event = det.sample(ts, 800);
    expect(event!.direction).toBe('off');
    expect(event!.deltaW).toBe(-1200);
  });

  it('discards a spike that returns to baseline within the window', () => {
    const det = new EventCaptureDetector();
    feedFlat(det, 0, 4, 500);
    expect(det.sample(5, 2500)).toBeNull(); // inrush spike
    expect(det.sample(6, 500)).toBeNull(); // straight back down
    for (let ts = 7; ts <= 23; ts++) expect(det.sample(ts, 500)).toBeNull();
    expect(det.sample(24, 500)).toBeNull(); // window completes: net ~0, no event
    // detector still works afterwards
    expect(det.sample(25, 1000)).toBeNull();
    let event = null;
    for (let ts = 26; ts <= 44; ts++) event = det.sample(ts, 1000);
    expect(event).not.toBeNull();
  });

  it('aborts an in-flight capture on a stream gap and reseeds', () => {
    const det = new EventCaptureDetector();
    feedFlat(det, 0, 4, 500);
    expect(det.sample(5, 1000)).toBeNull(); // capture starts
    expect(det.sample(60, 1000)).toBeNull(); // 55 s gap: capture dropped, reseeded
    // the reseeded state doesn't fabricate a delta from the gap
    for (let ts = 61; ts <= 90; ts++) expect(det.sample(ts, 1000)).toBeNull();
  });

  it('skips junk samples entirely', () => {
    const det = new EventCaptureDetector();
    feedFlat(det, 0, 4, 500);
    expect(det.sample(5, NaN)).toBeNull();
    expect(det.sample(6, -50)).toBeNull();
    expect(det.sample(7, Infinity)).toBeNull();
    // steady stream continues without a phantom trigger
    for (let ts = 8; ts <= 30; ts++) expect(det.sample(ts, 500)).toBeNull();
  });

  it('honors a runtime trigger change', () => {
    const det = new EventCaptureDetector();
    feedFlat(det, 0, 4, 500);
    det.setTriggerW(200);
    expect(det.sample(5, 600)).toBeNull(); // +100 < 200: no capture
    for (let ts = 6; ts <= 40; ts++) expect(det.sample(ts, 600)).toBeNull();
  });
});
