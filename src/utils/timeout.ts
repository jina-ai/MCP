/**
 * Run `task` with a deadline, resolving to `onTimeout()` instead of rejecting.
 *
 * The parallel tools used to race `Promise.all([...])` against a single rejecting
 * timeout promise. When that timeout won, the whole batch rejected and the tool's
 * catch block turned every already-completed search/read into one generic error
 * string - work that had finished successfully was thrown away.
 *
 * Giving each task its own deadline keeps the slow one isolated: it degrades to
 * an error entry while its siblings return their real results. The timer is
 * always cleared, so a fast batch leaves no pending timers behind.
 */
export async function withDeadline<T>(
    task: () => Promise<T>,
    timeoutMs: number,
    onTimeout: () => T
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const deadline = new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
    });

    try {
        return await Promise.race([task(), deadline]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
