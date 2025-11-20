# Handyman of Fairfax – AI Assistant Backend (Node + Render)

This project is a **minimal Node.js backend** for an AI assistant for:

> Handyman of Fairfax – handymanoffairfax.com

It is designed to be deployed on **Render** as a **Web Service**, and later
extended to connect with **Twilio Media Streams** for a live phone assistant.

For now, it provides:

- A health-check HTTP endpoint at `GET /health`
- A WebSocket endpoint at `ws://YOUR-SERVICE/\ws`
- A simple knowledge base about Handyman of Fairfax (`knowledge-base.json`)
- When a WebSocket client sends `{ "question": "..." }` as JSON,
  the server calls OpenAI's Chat Completions API and responds with
  `{ "answer": "..." }`.

This is step one: a working AI handyman Q&A backend that you can use
as the "brain" for a phone assistant or web chat.

## Files

- `server.js` – Express + WebSocket server, calls OpenAI
- `package.json` – Node dependencies and start script
- `knowledge-base.json` – Business info used by the assistant
- `.env.example` – Template for environment variables

## Running locally

1. Install Node 18+.
2. In this folder, run:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and set your real values:

   ```bash
   OPENAI_API_KEY=sk-...
   PORT=3000
   ```

4. Start the server:

   ```bash
   npm start
   ```

5. In another terminal, you can test with `wscat` or any WebSocket client:

   ```bash
   wscat -c ws://localhost:3000/ws
   ```

   Then send:

   ```json
   { "question": "Do you work in Springfield and can you mount a TV?" }
   ```

   The server will respond with an AI-generated answer based on the
   handyman knowledge base.

## Deploying to Render

1. Push these files to your GitHub repository
   (for example: `handyman-ai-phone-assistant`).

2. In Render:
   - Click **New → Web Service**
   - Choose your GitHub repo
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`

3. In the Render **Environment** settings, add:

   - `OPENAI_API_KEY` – your real OpenAI API key
   - `PORT` – `10000` (or leave blank; Render will set `PORT` automatically and the code will use it)

4. Deploy. Once the service is live, you will have a URL like:

   ```
   https://handyman-ai.onrender.com
   ```

   The WebSocket endpoint will be:

   ```
   wss://handyman-ai.onrender.com/ws
   ```

## Next Steps (Twilio Voice Integration)

This project gives you a clean AI backend you can talk to over WebSockets.

To turn it into a real **phone assistant**:

- Use Twilio Voice + Media Streams to stream call audio into a Node app.
- In that Node app, connect the audio stream to the OpenAI Realtime API and
  use this same handyman knowledge base as the "brain".

Twilio has official examples showing how to bridge Twilio Media Streams and
OpenAI Realtime. This repo can act as the business-specific logic and
knowledge layer for Handyman of Fairfax.
