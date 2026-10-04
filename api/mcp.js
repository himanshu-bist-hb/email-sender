// Stateless MCP server (Streamable HTTP, JSON responses) for Vercel.
const { sendEmail } = require("./gmail");

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "email-mcp", version: "1.0.0" };

const TOOLS = [
  {
    name: "send_email",
    description:
      "Send an email from the configured Gmail account. Provide 'body' for plain text and/or 'html' for a formatted message. Set dry_run to true to validate and preview without sending. Sending cannot be undone, so confirm recipients and content with the user first.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "array",
          items: { type: "string" },
          description: "Recipient email addresses",
        },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Plain-text body" },
        html: { type: "string", description: "Optional HTML body (sent alongside the plain text)" },
        cc: { type: "array", items: { type: "string" }, description: "CC addresses" },
        bcc: { type: "array", items: { type: "string" }, description: "BCC addresses" },
        reply_to: { type: "string", description: "Reply-To address" },
        from_name: { type: "string", description: "Display name for the sender" },
        dry_run: { type: "boolean", description: "Validate and preview only; do not send" },
      },
      required: ["to", "subject"],
    },
    handler: (a) => sendEmail(a),
  },
];

function validate(args, tool) {
  const missing = (tool.inputSchema.required || []).filter((k) => !args[k] || (Array.isArray(args[k]) && !args[k].length));
  return missing.length ? `Missing required argument(s): ${missing.join(", ")}` : null;
}

async function handleRpc(msg) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS.map(({ handler, ...t }) => t) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return err(-32602, `Unknown tool: ${params?.name}`);
      const args = params.arguments || {};
      const problem = validate(args, tool);
      if (problem) return ok({ isError: true, content: [{ type: "text", text: problem }] });
      try {
        const result = await tool.handler(args);
        return ok({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        return ok({ isError: true, content: [{ type: "text", text: `Email failed: ${e.message}` }] });
      }
    }
    default:
      return err(-32601, `Method not found: ${method}`);
  }
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Accept");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    if ((req.headers.accept || "").includes("text/event-stream")) return res.status(405).end();
    return res.status(200).json({ ...SERVER_INFO, status: "ok", tools: TOOLS.map((t) => t.name) });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body;
  try {
    body = await readBody(req);
  } catch {
    return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }

  const batch = Array.isArray(body);
  const msgs = batch ? body : [body];
  const responses = [];
  for (const m of msgs) {
    if (!m || typeof m !== "object" || !m.method) continue;
    if (m.id === undefined) continue; // notification, no response
    responses.push(await handleRpc(m));
  }
  if (!responses.length) return res.status(202).end();
  return res.status(200).json(batch ? responses : responses[0]);
};
