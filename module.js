'use strict';

/**
 * PersistentPriorityQueue (binary max-heap backed)
 * --------------------------------------------------
 * A priority queue whose state is persisted to a JSON file on disk so that
 * it survives process restarts.
 *
 * Underlying data structure
 * --------------------------
 * A binary heap stored as a flat array (0-indexed):
 *   - parent(i)      = floor((i - 1) / 2)
 *   - leftChild(i)    = 2i + 1
 *   - rightChild(i)   = 2i + 2
 *
 * This is a MAX-heap ordered on `priority` (ties broken by insertion order,
 * via a monotonically increasing `seq`, so extraction is FIFO-stable):
 * every parent's (priority, seq) key is >= both of its children's keys.
 *
 * An id -> array-index map (`_indexOf`) is maintained alongside the heap so
 * that `update(id, ...)` and `delete(id)` can locate an arbitrary entry in
 * O(1) instead of scanning the whole array.
 *
 * Complexity
 * ----------
 *   insert()        O(log n)   push + sift-up
 *   extract_max()    O(log n)   root is always the max; pop + sift-down
 *   peek('max')     O(1)       root of the heap
 *   update(id, p)   O(log n)   direct index lookup + sift-up or sift-down
 *   delete(id)      O(log n)   direct index lookup + swap-out + re-heapify
 *   is_empty()       O(1)
 *
 *   extract_min()    O(n)  worst case - see note below on why this can't
 *   peek('min')     be trimmed to a leaf-only scan the way extract_max
 *                    can be trimmed to O(1)/O(log n).
 *
 * A single heap cannot give O(log n) on BOTH extract_min and extract_max at
 * once - that needs a min-max heap or two mirrored heaps with lazy
 * deletion. This module trades that off deliberately: extract_max (and
 * peek/insert/update/delete) are all proper O(log n) heap operations, and
 * extract_min falls back to a full O(n) scan. See README "Scaling notes"
 * for the two-heap alternative if O(log n) were required on both sides.
 *
 * Why extract_min can't just scan the leaves: a common textbook shortcut
 * is "the minimum of a max-heap must be a leaf", since a max-heap only
 * guarantees parent.priority >= child.priority. That argument holds for
 * the *priority* key alone. But this queue breaks ties by insertion order
 * (`seq`), and the heap property only orders on (priority, seq) jointly
 * as far as parent >= child - it says nothing about where the smallest
 * `seq` among *equal-priority* entries sits. If several entries share the
 * minimum priority, the earliest-inserted one (the correct FIFO answer)
 * can legitimately be an internal node, not a leaf - so restricting the
 * scan to leaves would silently violate the FIFO tie-break guarantee.
 * Scanning the full array is the correct trade-off here, not a missed
 * optimization.
 *
 * Persistence
 * -----------
 * Every mutating call synchronously rewrites the backing JSON file. Writes
 * go to a temp file first and are then renamed into place, which is atomic
 * on POSIX filesystems, so a crash mid-write can't leave a half-written or
 * corrupt state file. On load, the array is re-heapified defensively (in
 * case the on-disk file was ever hand-edited), rather than trusted blindly
 * to already satisfy the heap property.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class PersistentPriorityQueue {
  /**
   * @param {Object} [options]
   * @param {string} [options.filePath] Path to the JSON file used for
   *        persistence. Defaults to ./data/queue-state.json next to this
   *        module.
   */
  constructor(options = {}) {
    this.filePath = options.filePath
      ? path.resolve(options.filePath)
      : path.join(__dirname, 'data', 'queue-state.json');

    /** @type {{id: string, value: *, priority: number, seq: number}[]} */
    this.heap = [];
    /** @type {Map<string, number>} id -> current index in this.heap */
    this._indexOf = new Map();
    this._seq = 0;

    this._ensureStorageDir();
    this._load();
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  /**
   * Insert a new entry into the queue.
   * @param {*} value Arbitrary payload to store.
   * @param {number} priority Numeric priority (higher = extracted first
   *        by extract_max, lower = extracted first by extract_min).
   * @returns {string} The generated id of the inserted entry.
   */
  insert(value, priority) {
    this._assertValidPriority(priority);

    const item = {
      id: crypto.randomUUID(),
      value,
      priority,
      seq: this._seq++,
    };

    const index = this.heap.length;
    this.heap.push(item);
    this._indexOf.set(item.id, index);
    this._siftUp(index);

    this._save();
    return item.id;
  }

  /**
   * Remove and return the entry with the largest priority. O(log n).
   * @returns {{id: string, value: *, priority: number} | null}
   */
  extract_max() {
    if (this.heap.length === 0) return null;
    const removed = this._deleteAt(0);
    this._save();
    return this._toPublic(removed);
  }

  /**
   * Remove and return the entry with the smallest priority (earliest
   * inserted wins ties). O(n) - see the class-level comment for why this
   * can't be reduced to a leaf-only scan once FIFO tie-breaking matters.
   * @returns {{id: string, value: *, priority: number} | null}
   */
  extract_min() {
    const idx = this._findMinIndex();
    if (idx === -1) return null;
    const removed = this._deleteAt(idx);
    this._save();
    return this._toPublic(removed);
  }

  /**
   * Look at the current min or max entry without removing it.
   * @param {'min'|'max'} [order='min']
   * @returns {{id: string, value: *, priority: number} | null}
   */
  peek(order = 'min') {
    if (order !== 'min' && order !== 'max') {
      throw new TypeError("peek(order): order must be 'min' or 'max'");
    }
    if (this.heap.length === 0) return null;

    if (order === 'max') {
      return this._toPublic(this.heap[0]);
    }

    const idx = this._findMinIndex();
    return this._toPublic(this.heap[idx]);
  }

  /**
   * Update the priority of an existing entry, identified by id. O(log n).
   * @param {string} id
   * @param {number} newPriority
   * @returns {{id: string, value: *, priority: number} | null} the updated
   *          entry, or null if no entry with that id exists.
   */
  update(id, newPriority) {
    this._assertValidPriority(newPriority);

    const index = this._indexOf.get(id);
    if (index === undefined) return null;

    const item = this.heap[index];
    const increased = newPriority > item.priority;
    item.priority = newPriority;

    // Only one of these will actually move anything; the other is a no-op.
    if (increased) {
      this._siftUp(index);
    } else {
      this._siftDown(index);
    }

    this._save();
    return this._toPublic(item);
  }

  /**
   * Delete an entry by id. O(log n).
   * @param {string} id
   * @returns {boolean} true if an entry was removed, false otherwise.
   */
  delete(id) {
    const index = this._indexOf.get(id);
    if (index === undefined) return false;

    this._deleteAt(index);
    this._save();
    return true;
  }

  /**
   * @returns {boolean} true if the queue has no entries.
   */
  is_empty() {
    return this.heap.length === 0;
  }

  /**
   * @returns {number} number of entries currently in the queue.
   */
  size() {
    return this.heap.length;
  }

  // ---------------------------------------------------------------------
  // Heap internals
  // ---------------------------------------------------------------------

  /** True if entry `a` belongs strictly above entry `b` in the max-heap. */
  _higherPriority(a, b) {
    if (a.priority !== b.priority) return a.priority > b.priority;
    return a.seq < b.seq; // earlier insertion wins ties (FIFO)
  }

  _parentIndex(i) {
    return Math.floor((i - 1) / 2);
  }

  _leftIndex(i) {
    return 2 * i + 1;
  }

  _rightIndex(i) {
    return 2 * i + 2;
  }

  _swap(i, j) {
    const tmp = this.heap[i];
    this.heap[i] = this.heap[j];
    this.heap[j] = tmp;
    this._indexOf.set(this.heap[i].id, i);
    this._indexOf.set(this.heap[j].id, j);
  }

  _siftUp(index) {
    let i = index;
    while (i > 0) {
      const parent = this._parentIndex(i);
      if (this._higherPriority(this.heap[i], this.heap[parent])) {
        this._swap(i, parent);
        i = parent;
      } else {
        break;
      }
    }
  }

  _siftDown(index) {
    let i = index;
    const n = this.heap.length;
    for (;;) {
      const left = this._leftIndex(i);
      const right = this._rightIndex(i);
      let largest = i;

      if (left < n && this._higherPriority(this.heap[left], this.heap[largest])) {
        largest = left;
      }
      if (right < n && this._higherPriority(this.heap[right], this.heap[largest])) {
        largest = right;
      }
      if (largest === i) break;

      this._swap(i, largest);
      i = largest;
    }
  }

  /**
   * Index of the global-minimum entry by (priority asc, seq asc). Must
   * scan the full array, not just leaves - see class-level comment.
   */
  _findMinIndex() {
    const n = this.heap.length;
    if (n === 0) return -1;

    let minIdx = 0;
    for (let i = 1; i < n; i++) {
      const a = this.heap[i];
      const b = this.heap[minIdx];
      const aSmaller =
        a.priority !== b.priority ? a.priority < b.priority : a.seq < b.seq;
      if (aSmaller) minIdx = i;
    }

    return minIdx;
  }

  /**
   * Remove and return the entry currently at `index`, restoring the heap
   * property. Standard "delete from binary heap at arbitrary index".
   */
  _deleteAt(index) {
    const n = this.heap.length;
    const lastIndex = n - 1;
    const removed = this.heap[index];

    if (index === lastIndex) {
      this.heap.pop();
      this._indexOf.delete(removed.id);
      return removed;
    }

    this._swap(index, lastIndex);
    this.heap.pop();
    this._indexOf.delete(removed.id);

    // The element swapped into `index` may need to move either direction.
    this._siftDown(index);
    this._siftUp(index);

    return removed;
  }

  _toPublic(item) {
    return { id: item.id, value: item.value, priority: item.priority };
  }

  _assertValidPriority(priority) {
    if (typeof priority !== 'number' || Number.isNaN(priority)) {
      throw new TypeError('priority must be a finite number');
    }
  }

  // ---------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------

  _ensureStorageDir() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _load() {
    this.heap = [];
    this._indexOf = new Map();
    this._seq = 0;

    if (!fs.existsSync(this.filePath)) {
      return;
    }

    let parsed;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      parsed = raw.trim() ? JSON.parse(raw) : { items: [], seq: 0 };
    } catch (err) {
      throw new Error(`Failed to load queue state from ${this.filePath}: ${err.message}`);
    }

    const items = Array.isArray(parsed.items) ? parsed.items : [];
    this._seq = Number.isInteger(parsed.seq) ? parsed.seq : items.length;

    // Load as a flat array, then re-heapify defensively rather than
    // trusting that the on-disk array still satisfies the heap property
    // (e.g. if the JSON file was ever hand-edited).
    this.heap = items;
    this.heap.forEach((item, i) => this._indexOf.set(item.id, i));
    for (let i = Math.floor(this.heap.length / 2) - 1; i >= 0; i--) {
      this._siftDown(i);
    }
  }

  _save() {
    const payload = JSON.stringify({ items: this.heap, seq: this._seq }, null, 2);
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, payload, 'utf-8');
    fs.renameSync(tmpPath, this.filePath); // atomic replace on POSIX filesystems
  }
}

module.exports = PersistentPriorityQueue;
