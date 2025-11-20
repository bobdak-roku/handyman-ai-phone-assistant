// server.js
    //
    // Minimal Node backend for an AI assistant for Handyman of Fairfax.
    // - Serves a simple health check on GET /health
    // - Exposes a WebSocket endpoint at /ws
    // - When a client sends { "question": "..." } over the websocket,
    //   the server calls OpenAI's Chat Completions API and responds with
    //   { "answer": "..." }.
    //
    // This is NOT yet wired to Twilio Media Streams. It is a clean,
    // Render-ready starting point that you can later extend to handle
    // phone audio. For now, it's a knowledge-base Q&A assistant over WS.

    const fs = require('fs');
    const path = require('path');
    const http = require('http');
    const express = require('express');
    const { WebSocketServer } = require('ws');
    require('dotenv').config();

    const app = express();
    const server = http.createServer(app);

    const PORT = process.env.PORT || 3000;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    if (!OPENAI_API_KEY) {
      console.warn('\n[WARN] OPENAI_API_KEY is not set. The assistant will not be able to call OpenAI.\n');
    }

    // Load knowledge base
    const kbPath = path.join(__dirname, 'knowledge-base.json');
    let knowledgeBase = {};
    try {
      const raw = fs.readFileSync(kbPath, 'utf8');
      knowledgeBase = JSON.parse(raw);
    } catch (err) {
      console.error('Error loading knowledge-base.json:', err);
    }

    // Simple health endpoint so Render can check the service
    app.get('/health', (req, res) => {
      res.json({ status: 'ok', service: 'handyman-ai-phone-assistant' });
    });

    // WebSocket server at /ws
    const wss = new WebSocketServer({ server, path: '/ws' });

    wss.on('connection', (ws) => {
      console.log('Client connected to /ws');

      ws.send(JSON.stringify({
        type: 'info',
        message: 'Connected to Handyman of Fairfax AI assistant. Send { "question": "..." } as JSON.'
      }));

      ws.on('message', async (data) => {
        let payload;
        try {
          payload = JSON.parse(data.toString());
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
          return;
        }

        const question = (payload.question || '').trim();
        if (!question) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing "question" field in payload.' }));
          return;
        }

        console.log('Question received:', question);

        if (!OPENAI_API_KEY) {
          ws.send(JSON.stringify({
            type: 'answer',
            answer: "The AI backend isn't fully configured yet (no API key). Please contact Handyman of Fairfax directly at " + (knowledgeBase.contact_phone || '(phone not set)') + "."
          }));
          return;
        }

        try {
          const answer = await askOpenAI(question, knowledgeBase);
          ws.send(JSON.stringify({ type: 'answer', answer }));
        } catch (err) {
          console.error('Error from OpenAI:', err);
          ws.send(JSON.stringify({
            type: 'error',
            message: 'There was a problem talking to the AI. Please try again, or call the handyman directly.'
          }));
        }
      });

      ws.on('close', () => {
        console.log('Client disconnected from /ws');
      });
    });

    async function askOpenAI(question, kb) {
      const systemPrompt = `
You are the phone intake and Q&A assistant for a local handyman service called "${kb.business_name}" in ${kb.location}.

You answer questions about:
- Services provided
- Service areas
- Hours
- Typical pricing ranges
- How booking and scheduling works

You must:
- Be concise and friendly.
- Prefer short paragraphs and bullet points.
- Always try to end by offering to take the caller's name, phone number, address, and a short description of the job so a human handyman can follow up.

Here is structured knowledge about the business:

SUMMARY:
${kb.summary || ''}

SERVICE AREA:
${(kb.service_area || []).join(', ')}

HOURS:
${kb.hours || ''}

SERVICES:
${(kb.services || []).join('; ')}

PRICING NOTES:
${(kb.pricing_notes || []).join('; ')}

BOOKING PROCESS:
${(kb.booking_process || []).join('; ')}

EXAMPLE FAQ ANSWERS:
${(kb.faqs || []).map(f => `Q: ${f.q}\nA: ${f.a}`).join('\n\n')}
`.trim();

      const body = {
        model: 'gpt-4.1-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question }
        ],
        temperature: 0.3
      };

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${text}`);
      }

      const json = await response.json();
      const answer = json.choices?.[0]?.message?.content || "I'm not sure how to answer that, but a handyman can call you back with more details.";
      return answer.trim();
    }

    server.listen(PORT, () => {
      console.log(`Handyman AI assistant listening on port ${PORT}`);
    });
