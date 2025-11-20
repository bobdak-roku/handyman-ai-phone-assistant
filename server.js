// server.js
//
// Backend for Handyman of Fairfax AI assistant
// - GET  /health         : health check
// - WS   /ws             : WebSocket chat interface
// - ALL  /twilio-voice   : Twilio Voice webhook (phone calls)
//
// Requirements:
// - Node 18+ (for global fetch)
// - OPENAI_API_KEY in environment
// - knowledge-base.json in the same directory

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.warn(
    "\n[WARN] OPENAI_API_KEY is not set. The assistant will respond with a fallback message.\n"
  );
}

// Parse x-www-form-urlencoded bodies (Twilio sends this)
app.use(express.urlencoded({ extended: true }));

// ------------------------ Load knowledge base ------------------------

const kbPath = path.join(__dirname, "knowledge-base.json");
let knowledgeBase = {};

try {
  const raw = fs.readFileSync(kbPath, "utf8");
  knowledgeBase = JSON.parse(raw);
  console.log("Loaded knowledge-base.json");
} catch (err) {
  console.error("Error loading knowledge-base.json:", err.message);
  knowledgeBase = {
    business_name: "Handyman of Fairfax",
    location: "Fairfax, VA",
    summary:
      "Local handyman service for small to medium home repairs, minor carpentry, TV mounting, and general home fixes.",
    service_area: ["Fairfax", "Fairfax Station", "Burke", "Springfield"],
    hours: "Monday–Saturday, 8:00 AM – 6:00 PM",
    contact_phone: "(555) 555-5555",
  };
}

// ------------------------ 1. Health endpoint ------------------------

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "handyman-ai-phone-assistant" });
});

// ------------------------ 2. WebSocket assistant ------------------------

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  console.log("Client connected to /ws");

  ws.send(
    JSON.stringify({
      type: "info",
      message:
        'Connected to Handyman of Fairfax AI assistant. Send { "question": "..." } as JSON.',
    })
  );

  ws.on("message", async (data) => {
    let payload;
    try {
      payload = JSON.parse(data.toString());
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    const question = (payload.question || "").trim();
    if (!question) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: 'Missing "question" field in payload.',
        })
      );
      return;
    }

    console.log("Question received (WS):", question);

    if (!OPENAI_API_KEY) {
      ws.send(
        JSON.stringify({
          type: "answer",
          answer:
            "The AI backend is not fully configured yet (missing API key). Please contact Handyman of Fairfax directly at " +
            (knowledgeBase.contact_phone || "(phone not set)") +
            ".",
        })
      );
      return;
    }

    try {
      const answer = await askOpenAIForChat(question, knowledgeBase);
      ws.send(JSON.stringify({ type: "answer", answer }));
    } catch (err) {
      console.error("Error from OpenAI (WS):", err);
      ws.send(
        JSON.stringify({
          type: "error",
          message:
            "There was a problem talking to the AI. Please try again later or call the handyman directly.",
        })
      );
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected from /ws");
  });
});

// ------------------------ 3. Twilio Voice webhook ------------------------
//
// IMPORTANT:
// We use app.all so that both POST (Twilio) and manual GET/POST tests hit
// the same handler. Twilio will send application/x-www-form-urlencoded.

app.all("/twilio-voice", async (req, res) => {
  const from = req.body.From || "";
  const speechResult = (req.body.SpeechResult || "").trim();

  // Helper to send TwiML
  function twiml(xmlBody) {
    res.set("Content-Type", "text/xml");
    res.send(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Response>' + xmlBody + "</Response>"
    );
  }

  // First request: no SpeechResult yet -> greet + <Gather>
  if (!speechResult) {
    console.log("Twilio call started from", from || "(unknown)");

    const gatherTwiml = `
      <Say voice="woman">
        Thank you for calling Handyman of Fairfax, your local home repair specialist.
      </Say>
      <Pause length="1"/>
      <Gather input="speech" action="/twilio-voice" method="POST" speechTimeout="auto">
        <Say>
          Please briefly describe what you need help with.
          For example, you can say:
          I need a TV mounted, or I have a leaky faucet, or my door will not close properly.
          Then pause for a moment.
        </Say>
      </Gather>
      <Say>Sorry, I did not catch that. Please call again later.</Say>
    `;

    twiml(gatherTwiml);
    return;
  }

  // Second request: Twilio sends recognized speech
  console.log("Twilio SpeechResult from", from || "(unknown)", "->", speechResult);

  if (!OPENAI_API_KEY) {
    const fallback = `
      <Say>
        Thank you. Our AI assistant is not available at this moment.
        Please call us back at ${escapeForXml(
          knowledgeBase.contact_phone || "our regular number"
        )}.
      </Say>
      <Hangup/>
    `;
    twiml(fallback);
    return;
  }

  try {
    const answer = await askOpenAIForPhone(speechResult, knowledgeBase, from);

    const responseTwiml = `
      <Say voice="woman">
        ${escapeForXml(answer)}
      </Say>
      <Pause length="1"/>
      <Say>
        A member of the Handyman of Fairfax team will follow up with you as soon as possible.
        Thank you for calling. Goodbye.
      </Say>
      <Hangup/>
    `;

    twiml(responseTwiml);
  } catch (err) {
    console.error("Error from OpenAI (Twilio):", err);
    const errorTwiml = `
      <Say>
        I am sorry, but there was a problem handling your request.
        Please try calling again in a few minutes.
      </Say>
      <Hangup/>
    `;
    twiml(errorTwiml);
  }
});

// ------------------------ OpenAI helpers ------------------------

async function askOpenAIForChat(question, kb) {
  const systemPrompt = buildSystemPrompt(kb, false);

  const body = {
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: question },
    ],
    temperature: 0.3,
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${text}`);
  }

  const json = await response.json();
  const answer =
    json.choices?.[0]?.message?.content ||
    "I'm not sure how to answer that, but a handyman can call you back with more details.";
  return answer.trim();
}

async function askOpenAIForPhone(speech, kb, fromNumber) {
  const systemPrompt = buildSystemPrompt(kb, true);

  const userContent = `
Caller phone number (from metadata, may be empty): ${fromNumber}

The caller said (transcription from Twilio SpeechResult):

"${speech}"

Write a short, natural voice response that:
- Acknowledges what they need.
- Confirms whether it is something Handyman of Fairfax typically handles.
- Mentions service area or limitations if relevant.
- Briefly sets expectations about scheduling and pricing.
- Sounds like a human speaking on the phone.
`;

  const body = {
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature: 0.4,
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${text}`);
  }

  const json = await response.json();
  const answer =
    json.choices?.[0]?.message?.content ||
    "Thank you for calling. A handyman will review your request and call you back shortly.";
  return answer.trim();
}

function buildSystemPrompt(kb, forPhone) {
  return `
You are the intake and Q&A assistant for a local handyman service called "${kb.business_name ||
    "Handyman of Fairfax"}" in ${kb.location || "Fairfax, VA"}.

You answer questions about:
- Services provided
- Service areas
- Hours
- Typical pricing ranges
- How booking and scheduling works

Business knowledge:
SUMMARY:
${kb.summary || ""}

SERVICE AREA:
${Array.isArray(kb.service_area) ? kb.service_area.join(", ") : ""}

HOURS:
${kb.hours || ""}

SERVICES:
${Array.isArray(kb.services) ? kb.services.join("; ") : ""}

PRICING NOTES:
${Array.isArray(kb.pricing_notes) ? kb.pricing_notes.join("; ") : ""}

BOOKING PROCESS:
${Array.isArray(kb.booking_process) ? kb.booking_process.join("; ") : ""}

FAQ EXAMPLES:
${Array.isArray(kb.faqs)
    ? kb.faqs
        .map((f) => `Q: ${f.q}\nA: ${f.a}`)
        .join("\n\n")
    : ""}

Style guidelines:
- Be friendly, clear, and professional.
- Use short sentences.
- Avoid jargon.
- ${forPhone ? "Write as if you are speaking aloud on the phone. No bullet points, just conversational sentences." : "In chat, short paragraphs and simple bullet points are okay."}
- If the caller is outside the service area or asks for work you do not handle, say so politely and suggest they contact a different type of contractor.
- Whenever appropriate, remind them that a handyman will follow up by phone or text to confirm details and scheduling.
`.trim();
}

// Escape text for use inside <Say>
function escapeForXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ------------------------ Start server ------------------------

server.listen(PORT, () => {
  console.log(`Handyman AI assistant listening on port ${PORT}`);
});
