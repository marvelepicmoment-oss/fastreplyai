const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────────
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "fastreplyai_secret";
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Your brand info — edit this to match the account you're managing
const BRAND_CONTEXT = process.env.BRAND_CONTEXT ||
  "You are a friendly social media assistant for a brand. Reply helpfully and concisely to Instagram DMs and comments. Keep replies under 3 sentences. Be warm and professional.";

// ── Webhook verification (Meta requires this) ─────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── Receive events from Instagram ────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object !== "instagram") {
    return res.sendStatus(404);
  }

  res.sendStatus(200); // Acknowledge immediately

  for (const entry of body.entry || []) {
    // Handle DMs
    for (const event of entry.messaging || []) {
      if (event.message && !event.message.is_echo) {
        const senderId = event.sender.id;
        const messageText = event.message.text;
        if (messageText) {
          console.log(`DM from ${senderId}: ${messageText}`);
          const reply = await generateReply(messageText);
          await sendDM(senderId, reply);
        }
      }
    }

    // Handle Comments
    for (const change of entry.changes || []) {
      if (change.field === "comments" && change.value) {
        const comment = change.value;
        if (comment.text && !comment.from?.id === process.env.IG_USER_ID) {
          console.log(`Comment: ${comment.text}`);
          const reply = await generateReply(comment.text);
          await replyToComment(comment.id, reply);
        }
      }
    }
  }
});

// ── Generate reply using Claude ───────────────────────────────────────────────
async function generateReply(userMessage) {
  try {
    const response = await axios.post(
      `https://claude.gg/v1/chat/completions`,
      {
        model: "claude-sonnet-4-6",
        max_tokens: 150,
        messages: [
          {
            role: "user",
            content: `${BRAND_CONTEXT}\n\nUser message: "${userMessage}"\n\nWrite a reply:`
          }
        ]
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.CLAUDE_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );
    const reply = response.data.choices[0].message.content.trim();
    console.log(`Claude reply: ${reply}`);
    return reply;
  } catch (err) {
    console.error("Claude error:", err.response?.data || err.message);
    return "Thanks for your message! We'll get back to you shortly. 😊";
  }
}

// ── Send a DM ─────────────────────────────────────────────────────────────────
async function sendDM(recipientId, message) {
  try {
    await axios.post(
      `https://graph.instagram.com/v21.0/me/messages`,
      {
        recipient: { id: recipientId },
        message: { text: message }
      },
      {
        params: { access_token: IG_ACCESS_TOKEN }
      }
    );
    console.log(`DM sent to ${recipientId}`);
  } catch (err) {
    console.error("Send DM error:", err.response?.data || err.message);
  }
}

// ── Reply to a comment ────────────────────────────────────────────────────────
async function replyToComment(commentId, message) {
  try {
    await axios.post(
      `https://graph.instagram.com/v21.0/${commentId}/replies`,
      { message },
      {
        params: { access_token: IG_ACCESS_TOKEN }
      }
    );
    console.log(`Comment reply sent`);
  } catch (err) {
    console.error("Reply comment error:", err.response?.data || err.message);
  }
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("FastReplyAI is running! 🚀");
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FastReplyAI server running on port ${PORT}`);
});