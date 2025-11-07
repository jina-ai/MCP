# Jina AI Remote MCP Server
[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=jina-mcp-server&config=eyJ1cmwiOiJodHRwczovL21jcC5qaW5hLmFpL3NzZSIsImhlYWRlcnMiOnsiQXV0aG9yaXphdGlvbiI6IkJlYXJlciBqaW5hXzg3ZGEyOTM2NDI2NDQzNDliNmE0MGM4Mzc4NDViNGYzR0hpZ3FXay1yNmtIY0ZPSm1jY29rb1RiaWpZYiJ9fQ%3D%3D)
[![Add MCP Server jina-mcp-server to LM Studio](https://files.lmstudio.ai/deeplink/mcp-install-light.svg)](https://lmstudio.ai/install-mcp?name=jina-mcp-server&config=eyJ1cmwiOiJodHRwczovL21jcC5qaW5hLmFpL3NzZSIsImhlYWRlcnMiOnsiQXV0aG9yaXphdGlvbiI6IkJlYXJlciBqaW5hXzQ5NzM0MjYwOTRkOTRkNmFhMGQwNGU3MDFlMGFkZTZkRjNBU0dzRE1ibjlfUm15MlBVYTZPY0ItR2xVRiJ9fQ%3D%3D)

A remote Model Context Protocol (MCP) server that provides access to Jina Reader, Embeddings and Reranker APIs with a suite of URL-to-markdown, web search, image search, and embeddings/reranker tools:

<a href="https://glama.ai/mcp/servers/@jina-ai/MCP">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@jina-ai/MCP/badge" alt="Jina AI Remote Server MCP server" />
</a>

| Tool | Description | Is Jina API Key Required? |
|-----------|-------------|----------------------|
| `read_url` | Extract clean, structured content from web pages as markdown via [Reader API](https://jina.ai/reader) | Optional* |
| `capture_screenshot_url` | Capture high-quality screenshots of web pages via [Reader API](https://jina.ai/reader) | Optional* |
| `search_web` | Search the entire web for current information and news via [Reader API](https://jina.ai/reader) | Yes |
| `search_arxiv` | Search academic papers and preprints on arXiv repository via [Reader API](https://jina.ai/reader) | Yes |
| `search_images` | Search for images across the web (similar to Google Images) via [Reader API](https://jina.ai/reader) | Yes |
| `expand_query` | Expand and rewrite search queries based on the query expansion model via [Reader API](https://jina.ai/reader) | Yes |
| `sort_by_relevance` | Rerank documents by relevance to a query via [Reranker API](https://jina.ai/reranker) | Yes |
| `deduplicate_strings` | Get top-k semantically unique strings via [Embeddings API](https://jina.ai/embeddings) and [submodular optimization](https://jina.ai/news/submodular-optimization-for-diverse-query-generation-in-deepresearch) | Yes |
| `deduplicate_images` | Get top-k semantically unique images via [Embeddings API](https://jina.ai/embeddings) and [submodular optimization](https://jina.ai/news/submodular-optimization-for-diverse-query-generation-in-deepresearch) | Yes |

> Optional tools work without an API key but have [rate limits](https://jina.ai/api-dashboard/rate-limit). For higher rate limits and better performance, use a Jina API key. You can get a free Jina API key from [https://jina.ai](https://jina.ai)

## Usage

For client that supports remote MCP server:
```json
{
  "mcpServers": {
    "jina-mcp-server": {
      "url": "https://mcp.jina.ai/sse",
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
        "https://mcp.jina.ai/sse"
        // optional bearer token
        "--header",
        "Authorization: Bearer ${JINA_API_KEY}"
        ]
    }
  }
}
```

## Troubleshooting

### I got stuck in a tool calling loop - what happened?

This is a common issue with LMStudio when the default context window is 4096 and you're using a thinking model like `gpt-oss-120b` or `qwen3-4b-thinking`. As the thinking and tool calling continue, once you hit the context window limit, the AI starts losing track of the beginning of the task. That's how it gets trapped in this rolling context window.

The solution is to load the model with enough context length to contain the full tool calling chain and thought process.

![set long enough context](/.readme/image.png)


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

This will deploy your MCP server to a URL like: `jina-mcp-server.<your-account>.workers.dev/sse`