const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

let cached = { token: null, expires: 0 };

async function getAccessToken() {
  if (cached.token && Date.now() < cached.expires - 60_000) return cached.token;

  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error("GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN must be configured on the server");
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Google token refresh failed: ${data.error_description || data.error || res.status}`);
  }
  cached = { token: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 };
  return cached.token;
}

function toList(v) {
  if (!v) return [];
  return (Array.isArray(v) ? v : String(v).split(",")).map((s) => s.trim()).filter(Boolean);
}

function checkAddresses(label, list) {
  for (const a of list) {
    if (!EMAIL_RE.test(a)) throw new Error(`Invalid ${label} address: ${a}`);
  }
}

function checkAllowed(all) {
  const allowed = toList(process.env.EMAIL_ALLOWED_DOMAINS).map((d) => d.toLowerCase());
  if (!allowed.length) return;
  for (const a of all) {
    const domain = a.split("@")[1].toLowerCase();
    if (!allowed.includes(domain)) throw new Error(`Recipient domain not allowed: ${domain}`);
  }
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");
const encodeHeader = (s) => `=?UTF-8?B?${b64(s)}?=`;

function buildMime({ to, cc, bcc, subject, text, html, reply_to, from_name }) {
  const fromAddr = process.env.GMAIL_SENDER; // optional; Gmail uses the authorised account regardless
  const headers = [];
  if (fromAddr) headers.push(`From: ${from_name ? `${encodeHeader(from_name)} ` : ""}<${fromAddr}>`);
  headers.push(`To: ${to.join(", ")}`);
  if (cc.length) headers.push(`Cc: ${cc.join(", ")}`);
  if (bcc.length) headers.push(`Bcc: ${bcc.join(", ")}`);
  if (reply_to) headers.push(`Reply-To: ${reply_to}`);
  headers.push(`Subject: ${encodeHeader(subject)}`, "MIME-Version: 1.0");

  if (html) {
    const boundary = `b_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const part = (type, body) =>
      `--${boundary}\r\nContent-Type: ${type}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(body)}\r\n`;
    return `${headers.join("\r\n")}\r\n\r\n${part("text/plain", text || "")}${part("text/html", html)}--${boundary}--`;
  }
  headers.push('Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64");
  return `${headers.join("\r\n")}\r\n\r\n${b64(text || "")}`;
}

async function sendEmail(args) {
  const to = toList(args.to);
  const cc = toList(args.cc);
  const bcc = toList(args.bcc);
  if (!to.length) throw new Error("At least one recipient is required in 'to'");
  checkAddresses("to", to);
  checkAddresses("cc", cc);
  checkAddresses("bcc", bcc);
  if (args.reply_to) checkAddresses("reply_to", [args.reply_to]);
  if (/[\r\n]/.test(args.subject) || (args.from_name && /[\r\n]/.test(args.from_name))) {
    throw new Error("subject and from_name must not contain line breaks");
  }
  if (!args.body && !args.html) throw new Error("Provide 'body' (plain text) or 'html'");
  checkAllowed([...to, ...cc, ...bcc]);

  const preview = {
    to,
    cc,
    bcc,
    subject: args.subject,
    format: args.html ? "html" : "text",
    body_chars: (args.html || args.body).length,
  };
  if (args.dry_run) return { sent: false, dry_run: true, would_send: preview };

  const mime = buildMime({
    to,
    cc,
    bcc,
    subject: args.subject,
    text: args.body,
    html: args.html,
    reply_to: args.reply_to,
    from_name: args.from_name,
  });
  const token = await getAccessToken();
  const res = await fetch(SEND_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: b64url(mime) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gmail send failed: ${data.error?.message || res.status}`);
  return { sent: true, message_id: data.id, thread_id: data.threadId, ...preview };
}

module.exports = { sendEmail };
