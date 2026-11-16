/**
 * Shared scaffolding for the tests: a fetch that never touches the network.
 *
 * The tests bundle the real source with esbuild and run on Node's own test
 * runner (`npm test`), so nothing here needs a Worker runtime.
 */

export interface RecordedCall {
    host: string;
    url: string;
    /** The deadline the call asked for, as passed to AbortSignal.timeout. */
    timeoutMs: number;
    body: any;
}

/** A Response that says where it came from, the way a real fetch result does. */
export function respond(url: string, status: number, body: unknown, init: { statusText?: string; headers?: Record<string, string> } = {}): Response {
    const response = new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        statusText: init.statusText ?? '',
        headers: init.headers,
    });
    Object.defineProperty(response, 'url', { value: url });
    return response;
}

/**
 * Replace global fetch with `handler` and record every call, including the
 * timeout each one was given. Returns the list the calls are appended to and
 * a function that puts everything back.
 */
export function stubFetch(handler: (call: RecordedCall) => Response | Promise<Response>) {
    const calls: RecordedCall[] = [];
    const realFetch = globalThis.fetch;
    const realTimeout = AbortSignal.timeout;

    let lastTimeoutMs = 0;
    AbortSignal.timeout = ((ms: number) => {
        lastTimeoutMs = ms;
        // Long enough never to fire during a test; the value asked for is what matters.
        return realTimeout.call(AbortSignal, 600_000);
    }) as typeof AbortSignal.timeout;

    globalThis.fetch = (async (input: any, init: any) => {
        const url = String(input);
        const call: RecordedCall = {
            host: new URL(url).hostname,
            url,
            timeoutMs: lastTimeoutMs,
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        };
        calls.push(call);
        return handler(call);
    }) as typeof fetch;

    return {
        calls,
        restore() {
            globalThis.fetch = realFetch;
            AbortSignal.timeout = realTimeout;
        },
    };
}
