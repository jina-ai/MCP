# Jina AI Remote MCP Server

[CLI version](https://github.com/jina-ai/cli)
[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=jina-mcp-server&config=eyJ1cmwiOiJodHRwczovL21jcC5qaW5hLmFpL3YxIiwiaGVhZGVycyI6eyJBdXRob3JpemF0aW9uIjoiQmVhcmVyIGppbmFfWU9VUl9BUElfS0VZX0hFUkUifX0%3D)
[![Add MCP Server jina-mcp-server to LM Studio](https://files.lmstudio.ai/deeplink/mcp-install-light.svg)](https://lmstudio.ai/install-mcp?name=jina-mcp-server&config=eyJ1cmwiOiJodHRwczovL21jcC5qaW5hLmFpL3YxIiwiaGVhZGVycyI6eyJBdXRob3JpemF0aW9uIjoiQmVhcmVyIGppbmFfWU9VUl9BUElfS0VZX0hFUkUifX0%3D)

A remote Model Context Protocol (MCP) server for the Jina Reader, Search, Embeddings and Reranker APIs:

| Tool | Description | Is Jina API Key Required? |
|-----------|-------------|----------------------|
| `primer` | Get current contextual information for localized, time-aware responses | No |
| `read_url` | Read a web page or PDF as markdown. Pass `question` for passages instead of the full body via [Reader API](https://jina.ai/reader) | Optional* |
| `capture_screenshot_url` | Capture a screenshot of a web page via [Reader API](https://jina.ai/reader) | Optional* |
| `guess_datetime_url` | Guess a page's publish or last-update datetime, with a confidence score | No |
| `search_web` | Search the web. Returns titles, URLs and engine snippets via [Reader API](https://jina.ai/reader) | Yes |
| `search_arxiv` | Search academic papers and preprints on arXiv repository via [Reader API](https://jina.ai/reader) | Yes |
| `search_ssrn` | Search academic papers on SSRN (Social Science Research Network) via [Reader API](https://jina.ai/reader) | Yes |
| `search_images` | Search the web for images via [Reader API](https://jina.ai/reader) | Yes |
| `search_jina_blog` | Search Jina AI news and blog posts at [jina.ai/news](https://jina.ai/news) | No |
| `sort_by_relevance` | Rerank documents by relevance to a query via [Reranker API](https://jina.ai/reranker) | Yes |
| `deduplicate_strings` | Get top-k semantically unique strings via [Embeddings API](https://jina.ai/embeddings) and [submodular optimization](https://jina.ai/news/submodular-optimization-for-diverse-query-generation-in-deepresearch) | Yes |
| `extract_pdf` | Extract figures, tables, and equations from PDF documents (arXiv papers or any PDF URL) using layout detection | Yes |

> Optional tools work without an API key at [rate limits](https://jina.ai/api-dashboard/rate-limit). Use a key for higher limits. Free keys: [https://jina.ai](https://jina.ai)

## Usage

> [!WARNING]
> Some clients do not support env variable, so you may need to replace `${JINA_API_KEY}` below to a hardcoded real API key `jina_xxx`.

> [!NOTE]
> The server uses [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) transport (MCP spec 2025-03-26). The `/sse` endpoint is kept as an alias for backward compatibility. See [FAQ](#why-is-the-endpoint-called-sse-but-using-streamable-http) for details.

For client that supports remote MCP server:
```json
{
  "mcpServers": {
    "jina-mcp-server": {
      "url": "https://mcp.jina.ai/v1",
      "headers": {
        "Authorization": "Bearer ${JINA_API_KEY}" // optional
      }
    }
  }
}
```

For client that does not support remote MCP server yet, you need [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) a local proxy to connect to the remote MCP server.

```json
{
  "mcpServers": {
    "jina-mcp-server": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://mcp.jina.ai/v1",
        "--header",
        "Authorization: Bearer ${JINA_API_KEY}"
      ]
    }
  }
}
```

For Claude Code:

> [!WARNING]
> **Upgrading from `/sse`?** If you previously added with `--transport sse`, remove it first with `claude mcp remove -s user jina`, then re-add using the command below.

```bash
claude mcp add -s user --transport http jina https://mcp.jina.ai/v1 \
  --header "Authorization: Bearer ${JINA_API_KEY}"
```

For OpenAI Codex: find `~/.codex/config.toml` and add the following:
```toml
[mcp_servers.jina-mcp-server]
command = "npx"
args = [
    "-y",
    "mcp-remote",
    "https://mcp.jina.ai/v1",
    "--header",
    "Authorization: Bearer ${JINA_API_KEY}"]
```

## Tool Filtering before Registering

Registering a tool costs context tokens for its name, description and schema whether or not it is called. With 12 tools, that budget is spent before the first request.

Filtering server-side through query parameters on the endpoint URL (`/v1?...`) excludes tools before registration, so the client never sees them.

### Query Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `exclude_tools` | Comma-separated tool names to exclude | `exclude_tools=search_web,search_arxiv` |
| `include_tools` | Comma-separated tool names to include | `include_tools=read_url,search_web` |
| `exclude_tags` | Comma-separated tags to exclude | `exclude_tags=search,rerank` |
| `include_tags` | Comma-separated tags to include | `include_tags=search,read` |
| `max_tokens` | Cap `read_url` response size in tokens. `0` disables truncation | `max_tokens=50000` |

### Available Tags

| Tag | Tools |
|-----|-------|
| `search` | search_web, search_arxiv, search_ssrn, search_images, search_jina_blog |
| `read` | read_url, capture_screenshot_url |
| `utility` | primer, guess_datetime_url, extract_pdf |
| `rerank` | sort_by_relevance, deduplicate_strings |

### Precedence

Filters are applied in this order (highest to lowest priority):
1. `exclude_tools` - Always excludes specified tools
2. `exclude_tags` - Excludes tools in specified tags
3. `include_tools` - Includes specified tools
4. `include_tags` - Starts with only tools in specified tags

### Examples

Exclude the rerank and utility tags:
```json
{
  "mcpServers": {
    "jina-mcp-server": {
      "url": "https://mcp.jina.ai/v1?exclude_tags=rerank,utility",
      "headers": {
        "Authorization": "Bearer ${JINA_API_KEY}"
      }
    }
  }
}
```

Only include search and read tools:
```json
{
  "mcpServers": {
    "jina-mcp-server": {
      "url": "https://mcp.jina.ai/v1?include_tags=search,read",
      "headers": {
        "Authorization": "Bearer ${JINA_API_KEY}"
      }
    }
  }
}
```

Exclude specific tools:
```json
{
  "mcpServers": {
    "jina-mcp-server": {
      "url": "https://mcp.jina.ai/v1?exclude_tools=search_ssrn,search_images",
      "headers": {
        "Authorization": "Bearer ${JINA_API_KEY}"
      }
    }
  }
}
```

## Removed in v1.10.0

| Tool | Use instead |
|---|---|
| `search_web_deep` | `search_web`, then `read_url` with `question` on the pages you pick |
| `parallel_search_web`, `parallel_search_arxiv`, `parallel_search_ssrn`, `parallel_read_url` | pass an array to `query` / `url` on the singletons |
| `expand_query` | rewrite the query yourself; the endpoint returned one near-copy of the input |
| `classify_text` | classify with the model; label scores differed by ~0.006, which is noise |
| `deduplicate_images` | the response carried base64 JPEG data, not just the selected items |
| `search_bibtex` | read the citation from the publisher or DBLP page directly; both backends were failing live |
| `show_api_key` | nothing. It returned the bearer token into the conversation |

Clients or `.mdc` rules naming these tools will get an unknown-tool error.

## Troubleshooting

### I got stuck in a tool calling loop - what happened?

This is a common issue with LMStudio when the default context window is 4096 and you're using a thinking model like `gpt-oss-120b` or `qwen3-4b-thinking`. As thinking and tool calling continue, the run hits the context limit, the model loses the start of the task, and it loops.

Load the model with enough context length to hold the whole tool-calling chain.

![set long enough context](/.readme/image.png)

### I can't see all tools.

Some MCP clients have local caching and do not actively update tool definitions. If tools are missing or look outdated, remove and re-add the jina-mcp-server to force a refresh of the cached definitions. In LMStudio, you can click the refresh button to load new tools.

![update local mcp clients](/.readme/image2.png)

### Claude Desktop says "Server disconnected" on Windows

Cursor and Claude Desktop (Windows) [have a bug](https://www.npmjs.com/package/mcp-remote#:~:text=Note%3A%20Cursor,env%20vars%0A%20%20%7D%0A%7D%2C) where spaces inside args aren't escaped when it invokes npx, which ends up mangling these values. You can work around it using:

```json
{
  // rest of config...
  "args": [
    "mcp-remote",
    "https://mcp.jina.ai/v1",
    "--header",
    "Authorization:${AUTH_HEADER}" // note no spaces around ':'
  ],
  "env": {
    "AUTH_HEADER": "Bearer <JINA_API_KEY>" // spaces OK in env vars
  }
},
```

### Cursor shows a red dot on this MCP status

[Likely a Cursor UI bug](https://forum.cursor.com/t/why-is-my-mcp-red/100518). The MCP works. Toggling off/on clears the dot; on a remote MCP that restarts the local proxy, not a server.

![cursor shows red dot](/.readme/image3.jpg)

### My LLM never uses some tools

If all tools are enabled but the model still ignores some, that is expected: models call the tools they were trained on. [Some research says LLMs must be trained to use a tool family](https://arxiv.org/abs/2508.09303). In Cursor, add this rule to a `.mdc` file:

```text
---
alwaysApply: true
---

When you are uncertain about knowledge, or the user doubts your answer, always use Jina MCP tools to search and read best practices and latest information. Use search_arxiv and read_url together when questions relate to theoretical deep learning or algorithm details. Use search_ssrn for social sciences, economics, law, and finance research. search_web, search_arxiv, and search_ssrn cannot be used alone - always follow with read_url on the result URLs. One read_url call can take up to 5 URLs at once.
```

### Why is my content truncated?

Claude Code, Claude Desktop, and Cursor enforce a fixed 25k token limit on MCP tool responses. To stop these clients from rejecting a large response outright, this server applies a token guardrail to `read_url`.

Items are kept whole, in order, while they fit. The first that does not fit is cut to a prefix that does, and later items are dropped. A `[jina-mcp] ...` note records what was truncated or omitted, so a partial document is marked partial. At least one item always survives, even one over budget.

The server targets below the limit. It counts tokens with cl100k, the client with its own tokenizer, the cut is a proportional character estimate, and the client measures the serialized JSON payload instead of the raw text. It therefore also enforces a ceiling of 3 bytes per allowed token, which holds across tokenizers for ASCII prose (~3.6 bytes/token) and CJK (~3 bytes/token). Cutting short loses part of the content. A rejected response loses all of it.

Any client can set its own budget with `max_tokens` on the endpoint URL (for example `https://mcp.jina.ai/v1?max_tokens=50000`), and `max_tokens=0` disables truncation entirely. Clients with configurable limits, such as OpenAI Codex (`tool_output_token_limit`), are otherwise left alone.

### Several queries or URLs in one call

`search_web`, `search_arxiv`, `search_ssrn` and `read_url` take a string or an array on `query` / `url`. An array runs every item concurrently in a single round trip. `search_images` takes one query at a time.

```jsonc
{ "url": ["https://react.dev/reference/react/useState",
          "https://docs.python.org/3/library/functions.html"],
  "question": "what does the hook or built-in return" }
```

Arrays cap at 5 entries, enforced by the schema. `withAllLinks`, `withAllImages`, `question`, `chunk_size`, `topk`, `ocr` and `page` are set once for the whole array, not per entry: every URL in the call gets the same `question`, and a multi-page OCR needs one call per page.

### Why is the endpoint called /sse but using Streamable HTTP?

The `/sse` endpoint URL is kept for backward compatibility with existing users. The recommended endpoint is now `/v1`. Both use the same **Streamable HTTP** transport (the new MCP standard from spec 2025-03-26), not the deprecated SSE transport.

This works because:
- **Claude Desktop, Cursor, Windsurf** use `mcp-remote` which defaults to `http-first` strategy (tries Streamable HTTP first)
- **Claude Code** has native support for both transports
- **LM Studio** supports direct connection to Streamable HTTP endpoints

The response streaming still uses SSE format (`Content-Type: text/event-stream`), but the protocol layer (session management, initialization) follows Streamable HTTP spec. All major MCP clients are compatible.

### Client-side tool filtering with mcp-remote

If you're using [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) as a local proxy, you can also filter tools client-side using its `--ignore-tool` flag:

```json
{
  "mcpServers": {
    "jina-mcp-server": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://mcp.jina.ai/v1",
        "--header",
        "Authorization: Bearer ${JINA_API_KEY}",
        "--ignore-tool", "search_images",
        "--ignore-tool", "search_ssrn",
        "--ignore-tool", "extract_pdf"
      ]
    }
  }
}
```

This filters at the proxy level before tools reach the client. Server-side filtering via query parameters (see [Tool Filtering](#tool-filtering-before-registering)) is cheaper, because the tokens are never sent.

### Reading a page with a question in mind

`read_url` returns the whole page. Pass `question` and the page is chunked, its passages are scored against the query by [Reranker](https://jina.ai/reranker) v3.5, and only the highest-scoring ones are returned.

| Parameter | Default | Effect |
|---|---|---|
| `question` | *(unset)* | Unset returns the full page. Set returns passages instead of `content`. |
| `chunk_size` | `100` | Target passage size in words, split at sentence boundaries, so a target, not a hard cut. Counted in words in every script. 1-4096. |
| `topk` | `1` | Passages to keep, best first. 1-50. |

`question` gates the other two. Without it the response is unchanged from a plain read.

```jsonc
// full page: 69,530 bytes
{ "url": "https://www.paulgraham.com/greatwork.html" }

// passages: 1,195 bytes
{ "url": "https://www.paulgraham.com/greatwork.html",
  "question": "Why are new ideas hard to see?", "topk": 3, "chunk_size": 50 }
```

Response shape: `question`, `snippets`, `snippet_source: content`, no `content`. `snippets` is one element holding up to `topk` passages joined by ` … `. No score is returned, so relevance cannot be thresholded here. Ladder measured at `chunk_size=40`: `topk` 1 gives 433 bytes and no separator, 2 gives 699 bytes and one separator, 5 gives 1,537 bytes and one separator. Fewer than `topk` passages can come back.

If extraction cannot run — empty page, unreadable page, no API key to rank with — the full body comes back with `snippet_source: full_content` and a `note`.

Byte cost, same URL, same endpoint, bytes of returned text:

| page | plain read | with `question` |
|---|---|---|
| docs.python.org/3/library/functions.html | 83,786 | 874 |
| en.wikipedia.org/wiki/List_of_countries_by_GDP_(nominal) | 12,295 | 912 |
| paulgraham.com/greatwork.html | 69,530 | 1,195 |

Measured against a local `wrangler dev` of this repo with an API key. `r.jina.ai` returns different sizes for the same URL, so do not mix the two sets.

Verified on this build: Python docs, Chinese Wikipedia, React references, GitHub READMEs, arXiv PDFs, essays. Compound questions worked here too (the os.path query returned both the `join` rule and the `splitext` example, and Beijing returned both population and area), so ask one thing per call as a habit, not because every multi-part question fails.

Reproduced failure modes. The response does not flag any of these:

- **Positional questions fail.** Ranking matches text, not document order. `raw.githubusercontent.com/vitejs/vite/main/packages/vite/CHANGELOG.md` is 283,749 bytes and opens with `## [8.3.0] ... (2026-09-10)`. Asked for the latest released version, it returned 1,008 bytes containing `6.0.0` and no `8.3.0` at all. Read the first screen for latest, first, current.
- **Tables, fenced code and page furniture are removed before ranking.** [read.ts](src/utils/read.ts) says so and it holds: the GDP list page is 12,295 bytes through `read_url` and contains `Japan` but not `4,379,253`. Asked for Japan's figure, `question` returned the map colour legend, `$1–5 trillion $750 billion – $1 trillion …`. A number that lives in a table is not reachable this way.
- **Inline code loses tokens.** `curl -fsSL https://bun.sh/install | bash` came back as `curl -fsSL | bash`. Never run a command copied out of a passage without checking the source.
- **Blocked pages return their login wall as content.** `x.com/jina_ai` returned 315 bytes of `Log inSign up … hasn't posted` with `snippet_source: content` and no error.
- **`chunk_size` is not monotonic.** 50 returned 521 bytes opening on the answer (`And yet empirically having new ideas is hard.`); 400 returned 2,260 bytes opening off-topic (`But the relationship is closer than that.`). Use 40-70 for commands, signatures and numbers, 150-200 for explanation.

A question-grounded read gets a 60s budget against 30s for a plain read, because chunking and reranking run after the fetch. The same 60s applies to a URL array carrying a `question`.

### Reading a scanned document or a PDF

A plain read parses HTML. It returns nothing useful when the text is not in the markup (scanned pages, image-only PDFs), and flattens formulas and table structure otherwise. Pass `ocr` and the rendered page goes through [jina-ocr-v1](https://jina.ai/models/jina-ocr-v1) as an image, returning Markdown with formulas and tables intact.

```jsonc
{ "url": "https://arxiv.org/pdf/2609.03181", "ocr": true }            // page 1
{ "url": "https://arxiv.org/pdf/2609.03181", "ocr": true, "page": 2 } // page 2
```

**One page per call.** Page 1 unless `page` says otherwise, so a long document needs one call per page. Measured on arXiv 2609.03181, a 20-page paper:

| | bytes returned | tokens billed |
|---|---|---|
| plain read | 49,466 (whole PDF) | 13,864 |
| `ocr: true` | 2,963 (page 1) | 61,520 |
| `ocr: true, page: 2` | 2,749 (page 2) | 62,720 |

Re-measured on a local `wrangler dev`: 49,745 / 2,968 / 2,923 bytes. Within 1 percent of the published figures.

Off by default, because OCR bills more tokens per page than a plain read costs per document. Turn it on when the HTML path fails or the layout matters. `page` is shared across a URL array, so several pages of one document take one call each.

### What is the difference between `search_web` and `search_web_deep`?

Removed in v1.10.0. Use `search_web`, then `read_url` on the pages you picked:

```jsonc
// 1. find pages
{ "query": "how to undo the last commit in git", "num": 5 }            // search_web

// 2. read the ones you want, reduced to answering passages
{ "url": ["https://stackoverflow.com/questions/9257533/...",
          "https://git-scm.com/docs/git-reset"],                      // read_url
  "question": "how to undo the last commit without losing work" }
```

Two calls instead of one, and the caller picks the pages. That is the reason for the removal: `search_web_deep` picked them, and picked wrong. Measured on `latest stable vite version`, where the npm result carries `Latest version: 8.3.0` — `search_web` returned that result in 2 of 5 on both runs; the deep path returned it 1 of 5 and then 0 of 5 with `v4.vite.dev/releases` ranked first, and `snippet_source=content` dropped the npm page outright. Three identical calls returned three different result sets. Output ran 3-4x the bytes of `search_web` per result (348-682 against 138-191). Its `rerank_score` ranked relevance, not correctness: at `num=2` the npm result carrying `8.3.0` scored 0.1303, below a page stating no version at 0.4765.

The pipeline is still available: `read_url` with `question` runs the same chunk-and-rerank on a page you chose. Its limits are listed in [Reading a page with a question in mind](#reading-a-page-with-a-question-in-mind).

## Developer Guide

### Local Development

```bash
# Clone the repository
git clone https://github.com/jina-ai/MCP.git
cd MCP

# Install dependencies
npm install

# Start development server
npm run start
```

### Deploy to Cloudflare Workers

[![Deploy to Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jina-ai/MCP)

This will deploy your MCP server to a URL like: `jina-mcp-server.<your-account>.workers.dev/v1`
