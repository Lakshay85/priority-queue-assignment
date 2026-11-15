'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PersistentPriorityQueue = require('../module');

/** Creates a fresh temp file path for one test, isolated from others. */
function tempFilePath() {
  return path.join(
    os.tmpdir(),
    `pq-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
}

function cleanup(filePath) {
  for (const p of [filePath, `${filePath}.${process.pid}.tmp`]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

test('a new queue is empty', () => {
  const filePath = tempFilePath();
  const pq = new PersistentPriorityQueue({ filePath });
  assert.equal(pq.is_empty(), true);
  assert.equal(pq.size(), 0);
  cleanup(filePath);
});

test('insert adds items and flips is_empty', () => {
  const filePath = tempFilePath();
  const pq = new PersistentPriorityQueue({ filePath });

  const id = pq.insert('task-a', 5);
  assert.equal(typeof id, 'string');
  assert.equal(pq.is_empty(), false);
  assert.equal(pq.size(), 1);

  cleanup(filePath);
});

test('insert rejects non-numeric priority', () => {
  const filePath = tempFilePath();
  const pq = new PersistentPriorityQueue({ filePath });
  assert.throws(() => pq.insert('bad', 'high'), TypeError);
  cleanup(filePath);
});

test('extract_min returns entries in ascending priority order', () => {
  const filePath = tempFilePath();
  const pq = new PersistentPriorityQueue({ filePath });

  pq.insert('c', 30);
  pq.insert('a', 10);
  pq.insert('b', 20);

  assert.equal(pq.extract_min().value, 'a');
  assert.equal(pq.extract_min().value, 'b');
  assert.equal(pq.extract_min().value, 'c');
  assert.equal(pq.extract_min(), null);

  cleanup(filePath);
});

test('extract_max returns entries in descending priority order', () => {
  const filePath = tempFilePath();
  const pq = new PersistentPriorityQueue({ filePath });

  pq.insert('c', 30);
  pq.insert('a', 10);
  pq.insert('b', 20);

  assert.equal(pq.extract_max().value, 'c');
  assert.equal(pq.extract_max().value, 'b');
  assert.equal(pq.extract_max().value, 'a');
  assert.equal(pq.extract_max(), null);

  cleanup(filePath);
});

test('ties on priority are broken by insertion order (FIFO)', () => {
  const filePath = tempFilePath();
  const pq = new PersistentPriorityQueue({ filePath });

  pq.insert('first', 5);
  pq.insert('second', 5);
  pq.insert('third', 5);

  assert.equal(pq.extract_min().value, 'first');
  assert.equal(pq.extract_min().value, 'second');
  assert.equal(pq.extract_min().value, 'third');

  cleanup(filePath);
});

test('peek returns the extreme entry without removing it', () => {
  const filePath = tempFilePath();
  const pq = new PersistentPriorityQueue({ filePath });

  pq.insert('low', 1);
  pq.insert('high', 100);

  assert.equal(pq.peek('min').value, 'low');
  assert.equal(pq.peek('max').value, 'high');
  assert.equal(pq.size(), 2); // nothing removed

  cleanup(filePath);
});

test('peek on an empty queue returns null', () => {
  const filePath = tempFilePath();
  const pq = new PersistentPriorityQueue({ filePath });
  assert.equal(pq.peek('min'), null);
  cleanup(filePath);
});

test('peek rejects an invalid order argument', () => {
  const filePath = tempFilePath();
  const pq = new PersistentPriorityQueue({ filePath });
  assert.throws(() => pq.peek('middle'), TypeError);
  cleanup(filePath);
});

test('update changes an entry priority and affects future extraction order', () => {
  const filePath = tempFilePath();
  const pq = new PersistentPriorityQueue({ filePath });

  const idA = pq.insert('a', 10);
  pq.insert('b', 20);

  const updated = pq.update(idA, 100);
  assert.equal(updated.priority, 100);

  // 'b' (priority 20) should now come out before 'a' (priority 100)
  assert.equal(pq.extract_min().value, 'b');
  assert.equal(pq.extract_min().value, 'a');

  cleanup(filePath);
});

test('update on an unknown id returns null', () => {
  const filePath = tempFilePath();
  const pq = new PersistentPriorityQueue({ filePath });
  assert.equal(pq.update('does-not-exist', 1), null);
  cleanup(filePath);
});

test('delete removes an entry by id', () => {
  const filePath = tempFilePath();
  const pq = new PersistentPriorityQueue({ filePath });

  const idA = pq.insert('a', 10);
  pq.insert('b', 20);

  assert.equal(pq.delete(idA), true);
  assert.equal(pq.size(), 1);
  assert.equal(pq.extract_min().value, 'b');
  assert.equal(pq.delete(idA), false); // already gone
});

test('state persists to disk and reloads in a new instance', () => {
  const filePath = tempFilePath();

  const pq1 = new PersistentPriorityQueue({ filePath });
  pq1.insert('task-1', 5);
  pq1.insert('task-2', 1);

  assert.equal(fs.existsSync(filePath), true);

  // Simulate a process restart by creating a brand new instance pointed
  // at the same file.
  const pq2 = new PersistentPriorityQueue({ filePath });
  assert.equal(pq2.size(), 2);
  assert.equal(pq2.peek('min').value, 'task-2');

  cleanup(filePath);
});

test('an empty/missing file initializes to an empty queue', () => {
  const filePath = tempFilePath();
  assert.equal(fs.existsSync(filePath), false);

  const pq = new PersistentPriorityQueue({ filePath });
  assert.equal(pq.is_empty(), true);

  cleanup(filePath);
});

test('loading a state file with a non-finite persisted priority throws', () => {
  const filePath = tempFilePath();
  // JSON.stringify(Infinity) is null, so this is exactly what a state file
  // looks like when a non-finite priority was persisted before validation.
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      items: [
        { id: 'ok', value: 'good', priority: 5, seq: 0 },
        { id: 'bad', value: 'corrupt', priority: null, seq: 1 },
      ],
      seq: 2,
    })
  );
  assert.throws(
    () => new PersistentPriorityQueue({ filePath }),
    /non-finite priority/
  );
  cleanup(filePath);
});

test('loading a state file with duplicate entry ids throws', () => {
  const filePath = tempFilePath();
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      items: [
        { id: 'same', value: 'one', priority: 1, seq: 0 },
        { id: 'same', value: 'two', priority: 2, seq: 1 },
      ],
      seq: 2,
    })
  );
  assert.throws(
    () => new PersistentPriorityQueue({ filePath }),
    /duplicate entry id/
  );
  cleanup(filePath);
});

test('loading a state file with an invalid persisted seq throws', () => {
  const filePath = tempFilePath();
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      items: [{ id: 'x', value: 'v', priority: 1, seq: 'zero' }],
      seq: 1,
    })
  );
  assert.throws(
    () => new PersistentPriorityQueue({ filePath }),
    /invalid seq/
  );
  cleanup(filePath);
});
