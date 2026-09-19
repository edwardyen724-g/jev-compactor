/** `averageVotes`: the pure fold behind the `votes` option. */
import { describe, expect, it } from 'vitest';
import { averageVotes, type CollectedAnswers } from '../src/jev.js';

const foreman = (destructive: number, thrashing = 0): CollectedAnswers['foreman'] => ({
  destructive,
  exfiltration: 0,
  thrashing,
  goal_drift: 0,
});

describe('averageVotes', () => {
  it('returns a single vote untouched and an empty fold for none', () => {
    const one: CollectedAnswers = {
      units: new Map([['u1', { pKeep: 0.4, confidence: 0.9 }]]),
      foreman: foreman(0.2),
      progress: 1,
    };
    expect(averageVotes([one])).toBe(one);
    const none = averageVotes([]);
    expect(none.units.size).toBe(0);
    expect(none.foreman).toEqual(foreman(0));
    expect(none.progress).toBeUndefined();
  });

  it('averages pKeep, confidence, the Foreman nouls and progress across votes', () => {
    const a: CollectedAnswers = {
      units: new Map([
        ['u1', { pKeep: 0.2, confidence: 0.8 }],
        ['u2', { pKeep: 1, confidence: 1 }],
      ]),
      foreman: foreman(0.9, 0.5),
      progress: 0,
    };
    const b: CollectedAnswers = {
      units: new Map([
        ['u1', { pKeep: 0.4, confidence: 0.6 }],
        ['u2', { pKeep: 0.5, confidence: 0.5 }],
      ]),
      foreman: foreman(0.7, 0.9),
      progress: 2,
    };
    const avg = averageVotes([a, b]);
    expect(avg.units.get('u1')).toEqual({ pKeep: 0.30000000000000004, confidence: 0.7 });
    expect(avg.units.get('u2')).toEqual({ pKeep: 0.75, confidence: 0.75 });
    expect(avg.foreman.destructive).toBeCloseTo(0.8);
    expect(avg.foreman.thrashing).toBeCloseTo(0.7);
    expect(avg.progress).toBe(1);
  });

  it('averages a unit over the votes that answered it, and progress over the votes that scored', () => {
    const a: CollectedAnswers = {
      units: new Map([['u1', { pKeep: 0.9, confidence: 0.9 }]]),
      foreman: foreman(0),
      progress: undefined,
    };
    const b: CollectedAnswers = { units: new Map(), foreman: foreman(0), progress: 2 };
    const c: CollectedAnswers = {
      units: new Map([['u1', { pKeep: 0.3, confidence: 0.3 }]]),
      foreman: foreman(0),
      progress: undefined,
    };
    const avg = averageVotes([a, b, c]);
    expect(avg.units.get('u1')?.pKeep).toBeCloseTo(0.6);
    expect(avg.progress).toBe(2);
  });
});
