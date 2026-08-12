/**
 * Image downloader utility with queue system for handling multiple concurrent downloads
 * Uses Cloudflare Workers' built-in image transformation capabilities
 */

interface ProcessedImageResult {
    url: string;
    success: boolean;
    data?: string; // base64 encoded JPEG image
    mimeType: string; // always "image/jpeg"
    error?: string;
}

/**
 * Download and process images using Cloudflare Workers image transformation
 * Automatically resizes to max 800px longest edge and converts to JPEG
 * Handles both single and batch downloads with timeout support
 */
export interface ImageTransformOptions {
    /** Max width in pixels (default 800) */
    width?: number;
    /**
     * Max height in pixels (default 800), or `null` to constrain width only.
     *
     * `null` is what tall full-page screenshots need: `fit: 'scale-down'`
     * preserves the aspect ratio, so an 800x800 box turns a 1280x20000 pageshot
     * into a ~51px-wide sliver in which no text is legible.
     */
    height?: number | null;
}

export async function downloadImages(
    urls: string | string[],
    concurrencyLimit: number = 3,
    timeoutMs: number = 15000,
    transform: ImageTransformOptions = {}
): Promise<ProcessedImageResult[]> {
    // Normalize input to always be an array
    const urlArray = Array.isArray(urls) ? urls : [urls];

    if (urlArray.length === 0) {
        return [];
    }

    const deadline = Date.now() + timeoutMs;
    const maxHeight = transform.height === undefined ? 800 : transform.height;

    // Results are written by index, so the array always lines up with the input
    // order and a partial run leaves no holes - callers index into it positionally.
    const results: ProcessedImageResult[] = urlArray.map((url) => ({
        url,
        success: false,
        mimeType: "image/jpeg",
        error: "Download timed out",
    }));

    const downloadOne = async (url: string, remainingMs: number): Promise<ProcessedImageResult> => {
        try {
            // Skip SVG images as they can't be processed by Cloudflare image transformation
            if (url.toLowerCase().endsWith('.svg') || url.toLowerCase().includes('.svg?')) {
                return {
                    url,
                    success: false,
                    mimeType: "image/jpeg",
                    error: "SVG images are not supported for transformation"
                };
            }

            // Use Cloudflare Workers image transformation
            // This automatically handles resizing and format conversion
            const response = await fetch(url, {
                // Bound each request individually so one stalled host cannot burn
                // the whole budget, and so the connection is actually released
                signal: AbortSignal.timeout(remainingMs),
                cf: {
                    image: {
                        fit: 'scale-down',              // Never enlarge, only shrink
                        width: transform.width ?? 800,  // Max width
                        ...(maxHeight === null ? {} : { height: maxHeight }),
                        format: 'jpeg',    // Convert to JPEG
                        quality: 85,       // Good quality with reasonable file size
                        compression: 'fast' // Faster processing
                    }
                }
            } as any);

            if (!response.ok) {
                return {
                    url,
                    success: false,
                    mimeType: "image/jpeg",
                    error: `HTTP ${response.status}: ${response.statusText}`
                };
            }

            const arrayBuffer = await response.arrayBuffer();
            const base64Image = Buffer.from(arrayBuffer).toString('base64');

            return {
                url,
                success: true,
                data: base64Image,
                mimeType: "image/jpeg"
            };
        } catch (error) {
            return {
                url,
                success: false,
                mimeType: "image/jpeg",
                error: error instanceof Error ? error.message : String(error)
            };
        }
    };

    // A rolling pool rather than fixed batches: `queue.splice(0, limit)` +
    // Promise.all meant every batch ran at the speed of its slowest image, and a
    // timeout mid-batch discarded that batch's completed downloads entirely.
    // Here each worker takes the next index as soon as it frees up, and every
    // finished download is committed immediately.
    let next = 0;
    const worker = async () => {
        for (;;) {
            const index = next++;
            if (index >= urlArray.length) return;

            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) return; // leave the pre-filled timeout entry in place

            results[index] = await downloadOne(urlArray[index], remainingMs);
        }
    };

    const poolSize = Math.max(1, Math.min(concurrencyLimit, urlArray.length));
    await Promise.all(Array.from({ length: poolSize }, worker));

    return results;
}
