import { describe, expect, it } from 'vitest';
import { HEX, diverging, sequential } from './colormap';

describe('HEX', () => {
  it('parses #rrggbb', () => {
    expect(HEX('#3987e5')).toEqual([0x39, 0x87, 0xe5]);
  });
});

describe('sequential', () => {
  const stops: [number, number, number][] = [
    [0, 0, 0],
    [100, 100, 100],
    [200, 200, 200],
  ];
  it('returns the first stop at t=0', () => expect(sequential(stops, 0)).toEqual([0, 0, 0]));
  it('returns the last stop at t=1', () => expect(sequential(stops, 1)).toEqual([200, 200, 200]));
  it('interpolates at the midpoint', () => expect(sequential(stops, 0.5)).toEqual([100, 100, 100]));
  it('interpolates within a segment', () => expect(sequential(stops, 0.25)).toEqual([50, 50, 50]));
  it('clamps below 0', () => expect(sequential(stops, -5)).toEqual([0, 0, 0]));
  it('clamps above 1', () => expect(sequential(stops, 5)).toEqual([200, 200, 200]));
});

describe('diverging', () => {
  const cold: [number, number, number] = [0, 0, 255];
  const mid: [number, number, number] = [255, 255, 255];
  const hot: [number, number, number] = [255, 0, 0];
  it('is the midpoint at 0', () => expect(diverging(cold, mid, hot, 0, 40)).toEqual(mid));
  it('is the cold pole at -extent', () => expect(diverging(cold, mid, hot, -40, 40)).toEqual(cold));
  it('is the hot pole at +extent', () => expect(diverging(cold, mid, hot, 40, 40)).toEqual(hot));
  it('clamps beyond the poles', () => {
    expect(diverging(cold, mid, hot, -999, 40)).toEqual(cold);
    expect(diverging(cold, mid, hot, 999, 40)).toEqual(hot);
  });
  it('is symmetric about the midpoint', () => {
    expect(diverging(cold, mid, hot, -20, 40)).toEqual([128, 128, 255]);
    expect(diverging(cold, mid, hot, 20, 40)).toEqual([255, 128, 128]);
  });
});
