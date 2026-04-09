const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-proto");
const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-proto");
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { resourceFromAttributes } = require("@opentelemetry/resources");
const { trace, SpanStatusCode } = require("@opentelemetry/api");
const { LoggerProvider, SimpleLogRecordProcessor } = require("@opentelemetry/sdk-logs");
const { OpenTelemetryTransportV3 } = require("@opentelemetry/winston-transport");
const winston = require("winston");

// ============================================================
// Configuration — set these as environment variables
// ============================================================
const DYNATRACE_URL   = process.env.DYNATRACE_URL   || "";
const DYNATRACE_TOKEN = process.env.DYNATRACE_TOKEN || "";
const ANTHROPIC_KEY   = process.env.ANTHROPIC_KEY;
const TAVILY_KEY      = process.env.TAVILY_KEY;

if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_KEY environment variable is required");
if (!TAVILY_KEY)    throw new Error("TAVILY_KEY environment variable is required");
// ============================================================

// --- Trace exporter ---
const traceExporter = new OTLPTraceExporter({
  url: `${DYNATRACE_URL}/api/v2/otlp/v1/traces`,
  headers: { Authorization: `Api-Token ${DYNATRACE_TOKEN}` },
});

// --- Log exporter ---
const logExporter = new OTLPLogExporter({
  url: `${DYNATRACE_URL}/api/v2/otlp/v1/logs`,
  headers: { Authorization: `Api-Token ${DYNATRACE_TOKEN}` },
});

// --- Resource (shared by traces + logs) ---
const resource = resourceFromAttributes({
  "service.name": "ai-search-agent",
  "service.version": "1.0.0",
});

// --- Start trace SDK ---
const sdk = new NodeSDK({
  resource,
  traceExporter,
});
sdk.start();

// --- Start log SDK ---
const { BatchLogRecordProcessor } = require("@opentelemetry/sdk-logs");

const loggerProvider = new LoggerProvider({
  resource,
  processors: [new BatchLogRecordProcessor(logExporter)],
});

// --- Winston logger (terminal + Dynatrace) ---
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp, ...meta }) => {
      const metaStr = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
      return `${timestamp} [${level.toUpperCase()}] ${message}${metaStr}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new OpenTelemetryTransportV3({ loggerProvider }),
  ],
});

logger.info("OpenTelemetry traces and logs started");

// --- App setup ---
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

const SYSTEM_PROMPT = `You are a helpful assistant with the ability to search the web.
When a user asks something that requires current or real-world information, use the search tool.
Always summarize the search results in a clear, concise way.`;

const tools = [
  {
    name: "web_search",
    description: "Search the web for current, real-time information.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query to look up" },
      },
      required: ["query"],
    },
  },
];

async function runSearch(query) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TAVILY_KEY,
      query,
      max_results: 5,
    }),
  });
  const data = await response.json();
  return data.results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`)
    .join("\n\n");
}

async function runAgent(messages, tracer) {
  while (true) {
    const span = tracer.startSpan("claude.messages.create");
    span.setAttribute("gen_ai.system", "anthropic");
    span.setAttribute("gen_ai.request.model", "claude-sonnet-4-20250514");

    let response;
    try {
      response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });

      span.setAttribute("gen_ai.usage.input_tokens", response.usage.input_tokens);
      span.setAttribute("gen_ai.usage.output_tokens", response.usage.output_tokens);
      span.setAttribute("gen_ai.response.stop_reason", response.stop_reason);
      span.setStatus({ code: SpanStatusCode.OK });

      logger.info("Claude API call successful", {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        stop_reason: response.stop_reason,
      });
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.end();
      logger.error("Claude API call failed", { error: err.message });
      throw err;
    }
    span.end();

    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find((b) => b.type === "text");
      return textBlock ? textBlock.text : "No response generated.";
    }

    if (response.stop_reason === "tool_use") {
      const toolUseBlock = response.content.find((b) => b.type === "tool_use");

      logger.info("Agent performing web search", { query: toolUseBlock.input.query });

      const toolSpan = tracer.startSpan("tool.web_search");
      toolSpan.setAttribute("tool.name", "web_search");
      toolSpan.setAttribute("tool.query", toolUseBlock.input.query);

      try {
        const searchResults = await runSearch(toolUseBlock.input.query);
        toolSpan.setStatus({ code: SpanStatusCode.OK });
        toolSpan.end();
        logger.info("Web search completed", { query: toolUseBlock.input.query });

        messages = [
          ...messages,
          { role: "assistant", content: response.content },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUseBlock.id,
                content: searchResults,
              },
            ],
          },
        ];
      } catch (err) {
        toolSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        toolSpan.end();
        logger.error("Web search failed", { query: toolUseBlock.input.query, error: err.message });
        throw err;
      }
    }
  }
}

app.post("/chat", async (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array is required" });
  }

  const tracer = trace.getTracer("ai-search-agent");
  const requestSpan = tracer.startSpan("chat.request");
  requestSpan.setAttribute("chat.message_count", messages.length);

  logger.info("Chat request received", { message_count: messages.length });

  try {
    const reply = await runAgent(messages, tracer);
    requestSpan.setStatus({ code: SpanStatusCode.OK });
    requestSpan.end();
    logger.info("Chat request completed successfully");
    res.json({ reply });
  } catch (err) {
    logger.error("Chat request failed", { error: err.message });
    requestSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    requestSpan.end();
    res.status(500).json({ error: "Something went wrong: " + err.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  logger.info("Agent started", { port: PORT, url: `http://localhost:${PORT}` });
});

process.on("SIGTERM", () => sdk.shutdown());
process.on("SIGINT", () => sdk.shutdown());
