/**
 * Reassembles an incarnation's sources from its journal records and blobs by the reader's rules
 * (`docs/specs/collector.md` §Journal records), so collection-run tests can check what a reader
 * would get. Throws on anything a reader must never accept: a missing or misnamed blob, a
 * journal key that disagrees with its record, a capture whose `prefix_sha256` is not its bytes.
 */
import { createHash } from "node:crypto";
import { type Capture, type JournalRecord, parseJournal } from "../../src/domain/archive-format";

export interface ReassembledSource {
  readonly path: string;
  /** The current generation's content, in the last epoch that recorded the source. */
  readonly current: Uint8Array;
  readonly currentGeneration: number;
  /** Every state a winning chain passes through, in every epoch and generation. */
  readonly states: readonly Uint8Array[];
  /** Whether any generation held a winning capture that did not chain. */
  readonly broken: boolean;
}

export const sha256Hex = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

/** Every journal record under `prefix`, checked against its key. */
export function journalRecords(
  objects: ReadonlyMap<string, Uint8Array>,
  prefix: string,
): JournalRecord[] {
  const records: JournalRecord[] = [];
  for (const [key, bytes] of objects) {
    if (!key.startsWith(`${prefix}journal/`)) continue;
    const parsed = parseJournal(new TextDecoder().decode(bytes));
    if (!parsed.ok) throw new Error(`${key} is no journal record`);
    const record = parsed.document;
    const expected = `${prefix}journal/${record.epoch}/${String(record.seq).padStart(10, "0")}.json`;
    if (key !== expected) throw new Error(`${key} holds the record of ${expected}`);
    records.push(record);
  }
  return records.sort((a, b) => (a.epoch < b.epoch ? -1 : a.epoch > b.epoch ? 1 : a.seq - b.seq));
}

function blobOf(objects: ReadonlyMap<string, Uint8Array>, prefix: string, capture: Capture) {
  const blob = objects.get(`${prefix}blobs/sha256/${capture.blob}`);
  if (blob === undefined) throw new Error(`blob ${capture.blob} is not stored`);
  if (sha256Hex(blob) !== capture.blob || blob.length !== capture.length)
    throw new Error(`blob ${capture.blob} is not its name`);
  return blob;
}

interface Seen {
  readonly capture: Capture;
  readonly seq: number;
}

/** A generation's winning captures chained from offset 0: its states, and whether it broke. */
function chain(
  winners: ReadonlyMap<number, Capture>,
  objects: ReadonlyMap<string, Uint8Array>,
  prefix: string,
) {
  const states: Uint8Array[] = [];
  let content: Uint8Array = new Uint8Array(0);
  let base: string | null = null;
  for (let capture = winners.get(0); capture !== undefined; ) {
    if (capture.base_sha256 !== base) return { states, broken: true };
    const next = new Uint8Array(content.length + capture.length);
    next.set(content);
    next.set(blobOf(objects, prefix, capture), content.length);
    if (sha256Hex(next) !== capture.prefix_sha256)
      throw new Error(`${capture.path}'s prefix_sha256 is not its bytes`);
    content = next;
    states.push(content);
    base = capture.prefix_sha256;
    capture = capture.length === 0 ? undefined : winners.get(content.length);
  }
  const ends = new Set([...winners.values()].map((c) => c.offset + c.length));
  const dangling = [...winners.keys()].some((offset) => offset > 0 && !ends.has(offset));
  return { states, broken: dangling };
}

/** The winning capture per generation and offset, and the generation of the highest seq. */
function winnersOf(seen: readonly Seen[]) {
  const generations = new Map<number, Map<number, Seen>>();
  let last: Seen | undefined;
  for (const item of seen) {
    const offsets = generations.get(item.capture.generation) ?? new Map<number, Seen>();
    const held = offsets.get(item.capture.offset);
    if (held === undefined || held.seq < item.seq) offsets.set(item.capture.offset, item);
    generations.set(item.capture.generation, offsets);
    if (last === undefined || last.seq < item.seq) last = item;
  }
  return { generations, current: last?.capture.generation ?? 0 };
}

/** Each source's captures in one epoch, by `<epoch>\0<path>`, in epoch order. */
function capturesByEpoch(objects: ReadonlyMap<string, Uint8Array>, prefix: string) {
  const byEpochSource = new Map<string, Seen[]>();
  for (const record of journalRecords(objects, prefix))
    for (const capture of record.captures) {
      const key = `${record.epoch}\0${capture.path}`;
      byEpochSource.set(key, [...(byEpochSource.get(key) ?? []), { capture, seq: record.seq }]);
    }
  return [...byEpochSource].sort(([a], [b]) => (a < b ? -1 : 1));
}

/** One source's reassembly in one epoch, after what earlier epochs gave. */
function inEpoch(
  path: string,
  seen: readonly Seen[],
  earlier: ReassembledSource | undefined,
  objects: ReadonlyMap<string, Uint8Array>,
  prefix: string,
): ReassembledSource {
  const { generations, current } = winnersOf(seen);
  const states = [...(earlier?.states ?? [])];
  let broken = earlier?.broken ?? false;
  let currentContent: Uint8Array = new Uint8Array(0);
  for (const [generation, offsets] of generations) {
    const winners = new Map([...offsets].map(([offset, item]) => [offset, item.capture]));
    const chained = chain(winners, objects, prefix);
    states.push(...chained.states);
    broken ||= chained.broken;
    if (generation === current) currentContent = chained.states.at(-1) ?? currentContent;
  }
  return { path, current: currentContent, currentGeneration: current, states, broken };
}

/** Each source's reassembly, by path. */
export function reassemble(
  objects: ReadonlyMap<string, Uint8Array>,
  prefix: string,
): Map<string, ReassembledSource> {
  const sources = new Map<string, ReassembledSource>();
  for (const [key, seen] of capturesByEpoch(objects, prefix)) {
    const path = key.slice(key.indexOf("\0") + 1);
    sources.set(path, inEpoch(path, seen, sources.get(path), objects, prefix));
  }
  return sources;
}
