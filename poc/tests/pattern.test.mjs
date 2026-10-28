import test from 'node:test';
import assert from 'node:assert/strict';
import { generateFoamPattern } from '../src/pattern.js';

const { data, size } = generateFoamPattern(128);
const red = (x, y) => data[(((y + size) % size) * size + ((x + size) % size)) * 4];

test('foam pattern is evenly distributed, so coverage tracks the foam mask', () => {
  // The dissolve test `pattern > 1 - mask` should cover about `mask` of the area.
  for (const mask of [0.1, 0.3, 0.5, 0.8]) {
    let covered = 0;
    for (let i = 0; i < size * size; i++) if (data[i * 4] / 255 > 1 - mask) covered++;
    const fraction = covered / (size * size);
    assert.ok(Math.abs(fraction - mask) < 0.03, `mask ${mask}: covered ${fraction.toFixed(3)}`);
  }
});

test('foam pattern tiles without a seam', () => {
  // The jump across the wrap edge should look like any other column-to-column jump.
  const columnJump = (x) => {
    let sum = 0;
    for (let y = 0; y < size; y++) sum += Math.abs(red(x, y) - red(x - 1, y));
    return sum;
  };
  const interior = Array.from({ length: size - 1 }, (_, i) => columnJump(i + 1));
  const largest = Math.max(...interior);
  assert.ok(columnJump(0) <= largest, `seam ${columnJump(0)} vs largest interior ${largest}`);
});
