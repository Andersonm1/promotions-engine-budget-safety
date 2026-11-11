import test from 'node:test';
import assert from 'node:assert/strict';
import { bestCombination, discountFor } from '../src/rules.js';

const tenOff = { _id: 'p1', type: 'percent_off', percent: 10, minSpend: 5000, stackGroup: 'item' };
const welcome = { _id: 'p2', type: 'first_order', amountOff: 1500, stackGroup: 'item' };
const freeShip = { _id: 'p3', type: 'free_delivery', minSpend: 3000, stackGroup: 'delivery' };
const flash = { _id: 'p4', type: 'percent_off', percent: 30, exclusive: true };

const cart = (subtotal, isFirstOrder = false) => ({ subtotal, deliveryFee: 499, isFirstOrder });
const summary = (lines) => lines.map((l) => [l.promo._id, l.amount]);

test('percent off only applies over the minimum spend', () => {
  assert.equal(discountFor(tenOff, cart(4999)), 0);
  assert.equal(discountFor(tenOff, cart(5000)), 500);
  assert.equal(discountFor(tenOff, cart(5005)), 500); // floors, never rounds up
});

test('first-order discount needs a first order', () => {
  assert.equal(discountFor(welcome, cart(6000)), 0);
  assert.equal(discountFor(welcome, cart(6000, true)), 1500);
});

test('promos in different stack groups combine', () => {
  assert.deepEqual(summary(bestCombination([tenOff, freeShip], cart(6000))), [['p1', 600], ['p3', 499]]);
});

test('same stack group: only the better one applies', () => {
  assert.deepEqual(summary(bestCombination([tenOff, welcome, freeShip], cart(6000, true))), [['p2', 1500], ['p3', 499]]);
  assert.deepEqual(summary(bestCombination([tenOff, welcome, freeShip], cart(20000, true))), [['p1', 2000], ['p3', 499]]);
});

test('exclusive promo wins only when it beats the best stack', () => {
  assert.deepEqual(summary(bestCombination([tenOff, freeShip, flash], cart(6000))), [['p4', 1800]]);
  const small = { ...flash, percent: 5 };
  assert.deepEqual(summary(bestCombination([tenOff, freeShip, small], cart(6000))), [['p1', 600], ['p3', 499]]);
});

test('item discounts never exceed the subtotal', () => {
  const big = { _id: 'p5', type: 'first_order', amountOff: 5000 };
  const lines = bestCombination([big, { ...tenOff, minSpend: 0, stackGroup: 'other' }], cart(1000, true));
  assert.equal(lines.reduce((s, l) => s + l.amount, 0), 1000);
});

test('nothing eligible gives no lines', () => {
  assert.deepEqual(bestCombination([tenOff], cart(100)), []);
});
