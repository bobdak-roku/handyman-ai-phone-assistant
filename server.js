// server.js
//
// Node backend for Handyman of Fairfax.
// - Health check at GET /health
// - WebSocket assistant at  /ws  (for testing / future chat)
// - Twilio Voice webhook at POST /twilio-voice  (answers phone calls)
//
// Twilio flow (simple v1):
// - Call comes in -> Twilio hits /twilio-voice without SpeechResult
// - We reply with <Gather input="speech"> asking what they need help with
// - Twilio transcribes caller's speech and POSTs again with SpeechResult
// - We send SpeechResult to OpenAI + knowledge base
// - We respond with <Say> using the AI's answer

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
    "\n[WARN] OPENAI_API_KEY is not set. The assistant will not be able to call OpenAI.\n"
  );
}

// Need this so Express can read Twilio's x-www-form-urlencoded POST body
app.use(express.urlencoded({ extended: true }));

// Load knowledge base
const kbPath = path.join(__dirname, "knowledge-base.json");
let knowledgeBase = {};
try {
  const raw = fs.readFileSync(kbPath, "utf8");
  knowledgeBase = JSON.parse(raw);
} catch (err) {
  console.error("Error loading knowledge-base.json:", err);
}

// ---------- 1. Health endpoint ----------
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "handyman-ai-phone-assistant" });
});

// ---------- 2. WebSocket assistant (/ws) ----------
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
            "The AI backend isn't fully configured yet (no API key). Please contact Handyman of Fairfax directly at " +
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
            "There was a problem talking to the AI. Please try again, or call the handyman directly.",
        })
      );
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected from /ws");
  });
});

// ---------- 3. Twilio Voice webhook (/twilio-voice) ----------
//
// This endpoint returns TwiML (XML) for Twilio.
//
// First request (no SpeechResult):
//   -> Greet + <Gather input="speech">
//
// Second request (with SpeechResult):
//   -> Call OpenAI, get a short voice-friendly answer
//   -> <Say> that answer back to the caller
//
app.post("/twilio-voice", async (req, res) => {
  const from = req.body.From || "";
  const speechResult = (req.body.SpeechResult || "").trim();

  // Helper to send TwiML
  function twiml(xmlBody) {
    res.set("Content-Type", "text/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>${xmlBody}</Response>`);
  }

  // First time: no speech yet -> prompt the caller
  if (!speechResult) {
    console.log("Twilio call started from", from);

    const gatherTwiml = `
      <Say voice="woman">
        Thank you for calling Handyman of Fairfax, your local home repair specialist.
      </Say>
      <Pause length="1"/>
      <Gather input="speech" action="/twilio-voice" method="POST" speechTimeout="auto">
        <Say>
          Please briefly describe what you need help with.
          For example, say something like:
          I need a TV mounted, or I have a leaky faucet, or my door will not close properly.
          Then pause for a moment.
        </Say>
      </Gather>
      <Say>Sorry, I did not catch that. Please call again later.</Say>
    `;

    twiml(gatherTwiml);
    return;
  }

  // Second time: Twilio sends us recognized speech
  console.log("Twilio SpeechResult from", from, "->", speechResult);

  if (!OPENAI_API_KEY) {
    const fallback = `
      <Say>
        Thank you. Our AI assistant is not available at this moment.
        Please call us back at ${escapeForXml(
          knowledgeBase.contact_phone || "our regular number"
        )}.
      </Say>
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

// ---------- OpenAI helpers ----------

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
You are the intake and Q&A assistant for a local handyman service called "${kb.business_name}" in ${kb.location}.

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
${(kb.service_area || []).join(", ")}

HOURS:
${kb.hours || ""}

SERVICES:
${(kb.services || []).join("; ")}

PRICING NOTES:
${(kb.pricing_notes || []).join("; ")}

BOOKING PROCESS:
${(kb.booking_process || []).join("; ")}

FAQ EXAMPLES:
${(kb.faqs || [])
  .map((f) => `Q: ${f.q}\nA: ${f.a}`)
  .join("\n\n")}

Style guidelines:
- Be friendly, clear, and professional.
- Use short sentences.
- Avoid jargon.
- ${forPhone ? "Write as if you are speaking aloud on the phone. No bullet points, just conversational sentences." : "In chat, short paragraphs and simple bullet points are okay."}
- If the caller is outside the service area or asks for work you do not handle, say so politely and suggest they contact a different type of contractor.
- Whenever appropriate, remind them that a handyman will follow up by phone or text to confirm details and scheduling.
`.trim();
}

// Escape text for use inside <Say> in XML
function escapeForXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

server.listen(PORT, () => {
  console.log(`Handyman AI assistant listening on port ${PORT}`);
});
