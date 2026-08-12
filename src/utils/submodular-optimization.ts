// Submodular optimization utilities for string deduplication

export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Pairwise cosine similarity matrix, clamped to non-negative so the
 * facility-location objective stays monotone submodular.
 *
 * Building this used to call cosineSimilarity() for all n^2 ordered pairs, which
 * re-derived both vector norms on every call - 3 passes over d floats per pair,
 * and every pair computed twice. Here the norms are computed once (O(n*d)) and
 * only the upper triangle is evaluated, so the dominant term drops from
 * 3*n^2*d to n^2*d/2. Results are bit-identical to the previous implementation.
 *
 * Returned as a flat Float64Array (n*n) to avoid n separate JS arrays.
 */
function buildSimilarityMatrix(embeddings: number[][]): Float64Array {
    const n = embeddings.length;

    // sumSquares[i] and norms[i] are derived once per vector instead of once per pair
    const sumSquares = new Float64Array(n);
    const norms = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const v = embeddings[i];
        let total = 0;
        for (let t = 0; t < v.length; t++) total += v[t] * v[t];
        sumSquares[i] = total;
        norms[i] = Math.sqrt(total);
    }

    const matrix = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
        const vi = embeddings[i];
        const normI = norms[i];

        // Same expression cosineSimilarity(v, v) evaluates to, kept verbatim rather
        // than shortcut to 1: sqrt(x)*sqrt(x) is not exactly x in IEEE-754, and the
        // selection order depends on those last bits when gains tie.
        const self = sumSquares[i] === 0 ? 0 : sumSquares[i] / (normI * normI);
        matrix[i * n + i] = self > 0 ? self : 0;

        for (let j = i + 1; j < n; j++) {
            const vj = embeddings[j];
            let sim = 0;
            // cosineSimilarity() returns 0 for mismatched lengths or a zero vector
            if (vi.length === vj.length && sumSquares[i] !== 0 && sumSquares[j] !== 0) {
                let dot = 0;
                for (let t = 0; t < vi.length; t++) dot += vi[t] * vj[t];
                sim = dot / (normI * norms[j]);
            }
            // Clamp to non-negative to ensure monotone submodularity of the
            // facility-location objective (NaN falls through to 0, as before)
            const clamped = sim > 0 ? sim : 0;
            matrix[i * n + j] = clamped;
            matrix[j * n + i] = clamped;
        }
    }

    return matrix;
}

export function computeMarginalGainDiversity(
    newIdx: number,
    currentCoverage: number[],
    similarityMatrix: number[][]
): number {
    const n = similarityMatrix.length;
    let marginalGain = 0;
    const row = similarityMatrix[newIdx];
    for (let i = 0; i < n; i++) {
        const newCoverage = row[i] > currentCoverage[i] ? row[i] : currentCoverage[i];
        marginalGain += newCoverage - currentCoverage[i];
    }
    return marginalGain;
}

/** Marginal gain of adding `idx` to the selected set, over the flat matrix */
function marginalGain(
    matrix: Float64Array,
    n: number,
    idx: number,
    coverage: Float64Array
): number {
    let gain = 0;
    const offset = idx * n;
    for (let i = 0; i < n; i++) {
        const sim = matrix[offset + i];
        if (sim > coverage[i]) gain += sim - coverage[i];
    }
    return gain;
}

/** [gain, lastUpdatedIteration, index, insertionSeq] */
type HeapEntry = [number, number, number, number];

/**
 * Max-heap over marginal gains for the lazy-greedy loop.
 *
 * The previous implementation used a plain array as the queue: `shift()` is O(n)
 * and it re-ran a full `sort()` after *every* stale-gain re-insertion, so each
 * re-evaluation cost O(n log n) on top of the O(n) gain computation.
 *
 * Ties are broken by ascending insertion sequence, which is exactly what the old
 * stable `sort()` did (re-inserted entries were appended, so they sorted after
 * equal-gain entries already in the queue). Selections are therefore unchanged.
 */
class GainHeap {
    private items: HeapEntry[] = [];
    private seq = 0;

    get size(): number {
        return this.items.length;
    }

    private static higher(a: HeapEntry, b: HeapEntry): boolean {
        return a[0] !== b[0] ? a[0] > b[0] : a[3] < b[3];
    }

    push(gain: number, lastUpdated: number, index: number): void {
        const items = this.items;
        items.push([gain, lastUpdated, index, this.seq++]);
        let i = items.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (!GainHeap.higher(items[i], items[parent])) break;
            [items[parent], items[i]] = [items[i], items[parent]];
            i = parent;
        }
    }

    pop(): HeapEntry | undefined {
        const items = this.items;
        if (items.length === 0) return undefined;
        const top = items[0];
        const last = items.pop() as HeapEntry;
        if (items.length > 0) {
            items[0] = last;
            let i = 0;
            for (;;) {
                const left = 2 * i + 1;
                const right = left + 1;
                let best = i;
                if (left < items.length && GainHeap.higher(items[left], items[best])) best = left;
                if (right < items.length && GainHeap.higher(items[right], items[best])) best = right;
                if (best === i) break;
                [items[best], items[i]] = [items[i], items[best]];
                i = best;
            }
        }
        return top;
    }
}

export function lazyGreedySelection(embeddings: number[][], k: number): number[] {
    const n = embeddings.length;
    if (k >= n) return Array.from({ length: n }, (_, i) => i);

    const matrix = buildSimilarityMatrix(embeddings);

    // Maintain current coverage vector (max similarity to selected set for each element)
    const coverage = new Float64Array(n);
    const selected: number[] = [];
    const picked = new Uint8Array(n);

    const heap = new GainHeap();
    for (let i = 0; i < n; i++) {
        heap.push(marginalGain(matrix, n, i, coverage), 0, i);
    }

    for (let iteration = 0; iteration < k && heap.size > 0; iteration++) {
        for (;;) {
            const top = heap.pop();
            if (!top) break;
            const [, lastUpdated, bestIdx] = top;

            if (picked[bestIdx]) continue;

            if (lastUpdated === iteration) {
                picked[bestIdx] = 1;
                selected.push(bestIdx);
                // Update coverage in O(n)
                const offset = bestIdx * n;
                for (let i = 0; i < n; i++) {
                    if (matrix[offset + i] > coverage[i]) coverage[i] = matrix[offset + i];
                }
                break;
            }

            // Stale gain: re-evaluate and re-insert (the "lazy" part of lazy greedy)
            heap.push(marginalGain(matrix, n, bestIdx, coverage), iteration, bestIdx);
        }
    }

    return selected;
}

export function lazyGreedySelectionWithSaturation(
    embeddings: number[][],
    threshold: number = 1e-2
): { selected: number[], optimalK: number, values: number[] } {
    const n = embeddings.length;

    const matrix = buildSimilarityMatrix(embeddings);

    const coverage = new Float64Array(n);
    const selected: number[] = [];
    const picked = new Uint8Array(n);
    const values: number[] = [];

    const heap = new GainHeap();
    for (let i = 0; i < n; i++) {
        heap.push(marginalGain(matrix, n, i, coverage), 0, i);
    }

    let earlyStopK: number | null = null;
    for (let iteration = 0; iteration < n && heap.size > 0; iteration++) {
        for (;;) {
            const top = heap.pop();
            if (!top) break;
            const [, lastUpdated, bestIdx] = top;

            if (picked[bestIdx]) continue;

            if (lastUpdated === iteration) {
                picked[bestIdx] = 1;
                selected.push(bestIdx);

                // Compute current function value (coverage)
                const offset = bestIdx * n;
                let total = 0;
                for (let i = 0; i < n; i++) {
                    if (matrix[offset + i] > coverage[i]) coverage[i] = matrix[offset + i];
                    total += coverage[i];
                }
                values.push(total / n);

                // Early stop once the marginal gain (delta of the normalized objective)
                // falls below the threshold. The element that produced that sub-threshold
                // delta is itself redundant, so k is the count *before* it was added.
                if (values.length >= 2) {
                    const delta = values[values.length - 1] - values[values.length - 2];
                    if (delta < threshold) {
                        earlyStopK = values.length - 1;
                    }
                }

                break;
            }

            heap.push(marginalGain(matrix, n, bestIdx, coverage), iteration, bestIdx);
        }
        if (earlyStopK !== null) break;
    }

    // Choose k: prefer early stop detection; otherwise, use all collected values
    const optimalK = earlyStopK ?? values.length;
    const finalSelected = selected.slice(0, optimalK);

    return { selected: finalSelected, optimalK, values };
}
