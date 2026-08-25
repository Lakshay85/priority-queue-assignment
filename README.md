# Persistent Priority Queue

A priority queue implemented in Node.js, with state persisted to a JSON
file on disk so the queue survives process restarts.

## Requirements

- Node.js >= 18 (uses the built-in `node:test` runner and `crypto.randomUUID()`)
- No external npm dependencies

## Project structure

```
priority-queue-assignment/
├── module.js              # Main implementation (the required "module")
├── package.json
├── README.md
├── data/
│   └── queue-state.json   # Default persistence file (created at runtime)
└── test/
    └── module.test.js     # Automated tests
```

## Running

```bash
npm install     # no-op, no dependencies, but keeps npm happy
npm test        # runs the test suite via `node --test`
```

There is nothing to "start" as a server — `module.js` exports a class you
`require()` and use directly. A quick manual check:

```bash
node -e "
const PriorityQueue = require('./module');
const pq = new PriorityQueue();          // uses ./data/queue-state.json
pq.insert('urgent ticket', 1);
pq.insert('low priority ticket', 50);
console.log(pq.extract_min());           // -> the 'urgent ticket' entry
"
```

## API

`const PriorityQueue = require('./module');`
`const pq = new PriorityQueue({ filePath: './data/my-queue.json' });` (filePath is optional; defaults to `./data/queue-state.json`)

| Method | Description |
|---|---|
| `insert(value, priority)` | Adds `value` with numeric `priority`. Returns the generated entry `id`. |
| `extract_min()` | Removes and returns the entry with the smallest priority, or `null` if empty. |
| `extract_max()` | Removes and returns the entry with the largest priority, or `null` if empty. |
| `peek(order = 'min')` | Returns the min or max entry **without** removing it, or `null` if empty. |
| `update(id, newPriority)` | Changes the priority of an existing entry. Returns the updated entry, or `null` if `id` doesn't exist. |
| `delete(id)` | Removes an entry by `id`. Returns `true`/`false`. |
| `is_empty()` | Returns `true` if the queue has no entries. |
| `size()` | Returns the current entry count (helper, not in the required list but handy). |

Every returned entry has the shape `{ id, value, priority }`.

"Priority" is just a number — lower means it comes out of `extract_min`
first; higher means it comes out of `extract_max` first. Ties are broken
by insertion order (first in, first out), using an internal sequence
counter, so extraction order is deterministic even when priorities are
equal.

## Implementation notes

The queue is backed by a **binary max-heap** stored as a flat array of
entries `{ id, value, priority, seq }`, plus an `id -> index` map so
arbitrary entries can be located without scanning the array. It is a
max-heap ordered on `(priority desc, seq asc)`, i.e. every parent's key
is `>=` both of its children's keys, with ties broken by insertion order
(earlier `seq` sorts "higher").

| Operation | Complexity | Why |
|---|---|---|
| `insert` | O(log n) | push to the end, sift up |
| `extract_max` | O(log n) | root is always the max; pop root, sift down |
| `peek('max')` | O(1) | root of the heap |
| `update(id, p)` | O(log n) | `id -> index` lookup, then sift up or down |
| `delete(id)` | O(log n) | `id -> index` lookup, swap-out, re-heapify |
| `is_empty` / `size` | O(1) | array length |
| `extract_min` / `peek('min')` | O(n) | see note below |

**Why `extract_min` is O(n) even with a max-heap.** A common shortcut is
"the minimum of a max-heap is always a leaf", since the heap property
only guarantees `parent.priority >= child.priority`. That's true for the
`priority` key *alone*. But this queue also breaks ties by insertion
order, and the heap property says nothing about where the smallest `seq`
among *equal-priority* entries sits — if several entries tie on
priority, the correct FIFO answer can legitimately be an internal node,
not a leaf. So a leaf-only scan would silently violate FIFO ordering on
ties; a full O(n) scan is the correct trade-off, not a missed
optimization. (Try it: insert three equal-priority items and `extract_min`
should return them in insertion order — a leaf-only scan gets this wrong.)

**Why not a heap that's O(log n) on both sides?** Getting O(log n) on
both `extract_min` and `extract_max` at once needs something more
specialized than a single heap, e.g.:

- a **min-max heap** (one array where alternating levels are ordered
  min/max), or
- **two heaps in parallel** (a min-heap and a max-heap over the same
  entries) with cross-references and lazy deletion to keep them in sync
  when an entry is removed from one side.

Both are meaningfully more code and more edge cases, especially once
`update`/`delete` by arbitrary id are required (you'd need to track each
entry's position in *both* heaps). This module optimizes the side most
priority queues actually lean on (`extract_max`, or `extract_min` if you
flip the comparator) to O(log n), and accepts O(n) on the less-common
"take the other end too" operation.

**Persistence.** Every mutating call writes the full state
(`{ items, seq }`, where `items` is the heap array) to a temp file and
then `rename()`s it over the real file. `rename()` is atomic on POSIX
filesystems, so a crash mid-write can't leave a corrupted/partial state
file — the queue on disk is always either the old state or the new
state, never something in between. On construction, the queue loads the
array from `filePath` if it exists and re-heapifies it defensively
(rather than trusting it already satisfies the heap property — e.g. in
case the JSON file was ever hand-edited), so a new instance picks up
right where a previous process left off.

**Trade-off of file-per-write persistence.** Writing the entire file on
every single call is simple and correct, but not free — it's O(n) I/O
per operation, and there is a synchronous write on every call. That's a
reasonable trade-off for a queue of moderate size or for correctness-
first environments (this is effectively a very small "database"), but it
would not scale well to extremely high write throughput or very large
queues. A relational-database-backed version (e.g. PostgreSQL, as
mentioned in the assignment) or batching/async writes would be the
natural next step if that became a bottleneck.

## Real-world use cases for priority queues

- **OS task/process scheduling** — the OS scheduler picks the next
  process to run based on priority (and can boost priorities to avoid
  starvation).
- **Graph algorithms** — Dijkstra's shortest path and Prim's minimum
  spanning tree both repeatedly extract the "closest"/"cheapest" node
  from a frontier, which is exactly `extract_min`.
- **Job/task queues in backend systems** — e.g. a background worker that
  should process "high priority" customer requests (paid tier, retries
  close to a deadline) before lower-priority ones.
- **Event-driven simulation** — a discrete-event simulator processes
  events in timestamp order, popping the earliest-scheduled event each
  step (`extract_min` on event time).
- **Bandwidth/network packet scheduling** — routers can prioritize
  certain traffic classes (e.g. VoIP over bulk file transfer) using a
  priority queue of packets.
- **Huffman coding** — building an optimal prefix code repeatedly merges
  the two lowest-frequency nodes, which is a textbook `extract_min` /
  `insert` loop.
- **A\* search** (pathfinding in games/maps) — the "open set" of nodes to
  explore next is a priority queue ordered by estimated total cost.
