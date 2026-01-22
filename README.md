# Jina AI Remote MCP Server
[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=jina-mcp-server&config=eyJ1cmwiOiJodHRwczovL21jcC5qaW5hLmFpL3NzZSIsImhlYWRlcnMiOnsiQXV0aG9yaXphdGlvbiI6IkJlYXJlciBqaW5hXzhjMGM3YjUyNDI0ZjQxNmFiMDUzYTMxYzk2Mjc3NmI2VDBwNVR4eG52SUpXdFlvemhlRnZYVi16eUpoXyJ9fQ%3D%3D)
[![Add MCP Server jina-mcp-server to LM Studio](https://files.lmstudio.ai/deeplink/mcp-install-light.svg)](https://lmstudio.ai/install-mcp?name=jina-mcp-server&config=eyJ1cmwiOiJodHRwczovL21jcC5qaW5hLmFpL3NzZSIsImhlYWRlcnMiOnsiQXV0aG9yaXphdGlvbiI6IkJlYXJlciBqaW5hXzI5NGQ5NmRiODFiYTQ1ZjY5MDFiOGM2OTRmM2I3NDU4ZVJMaV9MRS1xOGNqejRCeUE3REJ2cGZPUm5fdSJ9fQ%3D%3D)

A remote Model Context Protocol (MCP) server that provides access to Jina Reader, Embeddings and Reranker APIs with a suite of URL-to-markdown, web search, image search, and embeddings/reranker tools:

| Tool | Description | Is Jina API Key Required? |
|-----------|-------------|----------------------|
| `primer` | Get current contextual information for localized, time-aware responses | No |
| `read_url` | Extract clean, structured content from web pages as markdown via [Reader API](https://jina.ai/reader) | Optional* |
| `capture_screenshot_url` | Capture high-quality screenshots of web pages via [Reader API](https://jina.ai/reader) | Optional* |
| `guess_datetime_url` | Analyze web pages for last update/publish datetime with confidence scores | No |
| `search_web` | Search the entire web for current information and news via [Reader API](https://jina.ai/reader) | Yes |
| `search_arxiv` | Search academic papers and preprints on arXiv repository via [Reader API](https://jina.ai/reader) | Yes |
| `search_ssrn` | Search academic papers on SSRN (Social Science Research Network) via [Reader API](https://jina.ai/reader) | Yes |
| `search_images` | Search for images across the web (similar to Google Images) via [Reader API](https://jina.ai/reader) | Yes |
| `search_jina_blog` | Search Jina AI news and blog posts at [jina.ai/news](https://jina.ai/news) | No |
| `search_bibtex` | Search for academic papers and return BibTeX citations (DBLP + Semantic Scholar) | No |
| `expand_query` | Expand and rewrite search queries based on the query expansion model via [Reader API](https://jina.ai/reader) | Yes |
| `parallel_read_url` | Read multiple web pages in parallel for efficient content extraction via [Reader API](https://jina.ai/reader) | Optional* |
| `parallel_search_web` | Run multiple web searches in parallel for comprehensive topic coverage and diverse perspectives via [Reader API](https://jina.ai/reader) | Yes |
| `parallel_search_arxiv` | Run multiple arXiv searches in parallel for comprehensive research coverage and diverse academic angles via [Reader API](https://jina.ai/reader) | Yes |
| `parallel_search_ssrn` | Run multiple SSRN searches in parallel for comprehensive social science research coverage via [Reader API](https://jina.ai/reader) | Yes |
| `sort_by_relevance` | Rerank documents by relevance to a query via [Reranker API](https://jina.ai/reranker) | Yes |
| `deduplicate_strings` | Get top-k semantically unique strings via [Embeddings API](https://jina.ai/embeddings) and [submodular optimization](https://jina.ai/news/submodular-optimization-for-diverse-query-generation-in-deepresearch) | Yes |
| `deduplicate_images` | Get top-k semantically unique images via [Embeddings API](https://jina.ai/embeddings) and [submodular optimization](https://jina.ai/news/submodular-optimization-for-diverse-query-generation-in-deepresearch) | Yes |
| `extract_pdf` | Extract figures, tables, and equations from PDF documents (arXiv papers or any PDF URL) using layout detection | Yes |

> Optional tools work without an API key but have [rate limits](https://jina.ai/api-dashboard/rate-limit). For higher rate limits and better performance, use a Jina API key. You can get a free Jina API key from [https://jina.ai](https://jina.ai)

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
        "https://mcp.jina.ai/v1"
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

Every MCP tool requires the LLM to pre-allocate tokens in its context window for the tool's name, description, and schema. For LLMs with limited context windows, registering all 19 tools can consume significant space before any actual work begins.

By filtering tools server-side via query parameters on the endpoint URL (`/v1?...`), excluded tools are never registered with the MCP client. The client and LLM never see them, saving context window for what matters.

### Query Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `exclude_tools` | Comma-separated tool names to exclude | `exclude_tools=search_web,search_arxiv` |
| `include_tools` | Comma-separated tool names to include | `include_tools=read_url,search_web` |
| `exclude_tags` | Comma-separated tags to exclude | `exclude_tags=parallel,rerank` |
| `include_tags` | Comma-separated tags to include | `include_tags=search,read` |

### Available Tags

| Tag | Tools |
|-----|-------|
| `search` | search_web, search_arxiv, search_ssrn, search_images, search_jina_blog, search_bibtex |
| `parallel` | parallel_search_web, parallel_search_arxiv, parallel_search_ssrn, parallel_read_url |
| `read` | read_url, parallel_read_url, capture_screenshot_url |
| `utility` | primer, show_api_key, expand_query, guess_datetime_url, extract_pdf |
| `rerank` | sort_by_relevance, deduplicate_strings, deduplicate_images |

### Precedence

Filters are applied in this order (highest to lowest priority):
1. `exclude_tools` - Always excludes specified tools
2. `exclude_tags` - Excludes tools in specified tags
3. `include_tools` - Includes specified tools
4. `include_tags` - Starts with only tools in specified tags

### Examples

Exclude parallel tools (saves ~4 tools worth of context tokens):
```json
{
  "mcpServers": {
    "jina-mcp-server": {
      "url": "https://mcp.jina.ai/v1?exclude_tags=parallel",
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
      "url": "https://mcp.jina.ai/v1?exclude_tools=search_images,deduplicate_images",
      "headers": {
        "Authorization": "Bearer ${JINA_API_KEY}"
      }
    }
  }
}
```

## Troubleshooting

### I got stuck in a tool calling loop - what happened?

This is a common issue with LMStudio when the default context window is 4096 and you're using a thinking model like `gpt-oss-120b` or `qwen3-4b-thinking`. As the thinking and tool calling continue, once you hit the context window limit, the AI starts losing track of the beginning of the task. That's how it gets trapped in this rolling context window.

The solution is to load the model with enough context length to contain the full tool calling chain and thought process.

![set long enough context](/.readme/image.png)

### I can't see all tools.

Some MCP clients have local caching and do not actively update tool definitions. If you're not seeing all the available tools or if tools seem outdated, you may need to remove and re-add the jina-mcp-server to your MCP client configuration. This will force the client to refresh its cached tool definitions. In LMStudio, you can click the refresh button to load new tools.

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

[Likely a UI bug from Cursor](https://forum.cursor.com/t/why-is-my-mcp-red/100518), but the MCP works correctly without any problem. You can toggle off/on to "restart" the MCP if you find the red dot annoying (fact is, since you are using this as a remote MCP, it's not a real "server restart" but mostly a local proxy restart).

![cursor shows red dot](/.readme/image3.jpg)

### My LLM never uses some tools

Assuming all tools are enabled in your MCP client but LLM still never uses some tools or favors some over others, this is pretty common when an LLM is trained with a specific set of tools. For example, we rarely see `parallel_*` tools being used organically by LLMs unless they are explicitly instructed to do so. [Some research says LLMs must be trained to use `parallel_*`](https://arxiv.org/abs/2508.09303). Models like Qwen3-Next natively prefer to call the singleton version but with multiple queries in an array to achieve parallelism (which our MCP also support now). Either way, in Cursor, you can add the following rule to your `.mdc` file:

```text
---
alwaysApply: true
---

When you are uncertain about knowledge, or the user doubts your answer, always use Jina MCP tools to search and read best practices and latest information. Use search_arxiv and read_url together when questions relate to theoretical deep learning or algorithm details. Use search_ssrn for social sciences, economics, law, and finance research. search_web, search_arxiv, and search_ssrn cannot be used alone - always combine with read_url or parallel_read_url to read from multiple sources. Remember: every search must be complemented with read_url to read the source URL content. For maximum efficiency, use parallel_* versions of search and read when necessary.
```

### Why is my content truncated?

Claude Code, Claude Desktop, and Cursor enforce a fixed 25k token limit on MCP tool responses. To prevent these clients from rejecting large responses entirely, this server applies a token guardrail specifically for `read_url` and `parallel_read_url` tools when connecting from these clients. For a single large content item, the text is truncated proportionally to fit within the token budget. For responses containing multiple items, the server keeps items in order until adding the next item would exceed the limit, then stops there. This ensures the response always fits within client constraints while preserving as much content as possible. Other clients like OpenAI Codex have configurable limits (`tool_output_token_limit` in config) so no server-side truncation is applied.

### Using parallel tools vs singleton tools with arrays

Claude Code recently started preferring `parallel_*` tools (like `parallel_search_web`, `parallel_read_url`) for concurrent operations. However, models like Qwen3-Next prefer calling singleton tools with multiple queries in an array. Both approaches work: the singleton versions (`search_web`, `search_arxiv`, `search_ssrn`, `read_url`) accept either a single string or an array of strings for the query/url parameter. When given an array, these tools automatically execute all queries in parallel internally, producing the same concurrent behavior as explicitly calling `parallel_*` tools. Use whichever style your model prefers.

### Why is the endpoint called /sse but using Streamable HTTP?

The `/sse` endpoint URL is kept for backward compatibility with existing users. The recommended endpoint is now `/v1`. Both use the same **Streamable HTTP** transport (the new MCP standard from spec 2025-03-26), not the deprecated SSE transport.

This works seamlessly because:
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
        "--ignore-tool", "parallel_search_web",
        "--ignore-tool", "parallel_search_arxiv",
        "--ignore-tool", "parallel_read_url"
      ]
    }
  }
}
```

This approach filters tools at the proxy level before they reach the MCP client. However, server-side filtering via query parameters (see [Tool Filtering](#tool-filtering-before-registering)) is more efficient as it reduces token usage from the source.

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
