const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────────
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "fastreplyai_secret";
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Deduplication — ignore duplicate webhook events ───────────────────────────
const processedMids = new Set();
function isDuplicate(mid) {
  if (!mid) return false;
  if (processedMids.has(mid)) return true;
  processedMids.add(mid);
  // Keep set small — remove after 5 minutes
  setTimeout(() => processedMids.delete(mid), 5 * 60 * 1000);
  return false;
}

// ── Webhook verification ──────────────────────────────────────────────────────
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

// ── Receive events ────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object !== "instagram") return res.sendStatus(404);
  res.sendStatus(200);

  for (const entry of body.entry || []) {
    // Handle DMs
    for (const event of entry.messaging || []) {
      if (event.message && !event.message.is_echo) {
        const mid = event.message.mid;
        if (isDuplicate(mid)) {
          console.log(`Skipping duplicate message: ${mid}`);
          continue;
        }

        const senderId = event.sender.id;
        const messageText = event.message.text || "";
        const attachments = event.message.attachments || [];

        console.log(`DM from ${senderId}: ${messageText}`);

        // Get client info from DB
        const client = await getClientByIgUserId(entry.id);
        if (!client) {
          console.log("Client not found for IG user:", entry.id);
          continue;
        }

        // Save incoming message to history (only non-empty text)
        if (messageText && messageText.trim()) {
          await saveMessage(client.id, senderId, "user", messageText);
        }

        // Check if message is a shared Instagram post (via share button)
        const sharedPost = attachments.find(a => a.type === "ig_post" || a.type === "ig_reel" || a.type === "share");
        if (sharedPost) {
          const attachUrl = sharedPost.payload?.url || "";
          console.log("Shared post attachment:", sharedPost.type, attachUrl);

          // Try direct URL match first
          const directPostId = extractPostId(attachUrl);
          if (directPostId) {
            await handlePostLinkQuery(senderId, client, directPostId);
            continue;
          }

          // Extract asset_id from CDN URL and resolve via Instagram API
          const assetMatch = attachUrl.match(/asset_id=(\d+)/);
          if (assetMatch) {
            const mediaId = assetMatch[1];
            const shortcode = await getShortcodeFromMediaId(mediaId);
            if (shortcode) {
              await handlePostLinkQuery(senderId, client, shortcode);
              continue;
            }
          }
        }

        // Check if customer wants to order
        if (isOrderIntent(messageText)) {
          await handleOrder(senderId, client, messageText);
          continue;
        }

        // Check if message has an image (screenshot)
        if (attachments.length > 0 && attachments[0].type === "image") {
          const imageUrl = attachments[0].payload.url;
          await handleImageQuery(senderId, client, imageUrl, messageText);
          continue;
        }

        // Check if message has an Instagram post link (typed/pasted)
        const postId = extractPostId(messageText);
        if (postId) {
          await handlePostLinkQuery(senderId, client, postId);
          continue;
        }

        // General question — reply with AI (only if there is actual text)
        if (!messageText || !messageText.trim()) {
          // Maybe it's a shared post with a URL buried in the attachment
          const anyAttachment = attachments[0];
          if (anyAttachment) {
            const attachmentUrl = anyAttachment.payload?.url || anyAttachment.payload?.src || "";
            console.log(`Empty text, attachment type: ${anyAttachment.type}, url: ${attachmentUrl}`);
            const sharedPostId = extractPostId(attachmentUrl);
            if (sharedPostId) {
              await handlePostLinkQuery(senderId, client, sharedPostId);
              continue;
            }
          }
          console.log(`Skipping empty message from ${senderId}`);
          continue;
        }
        await handleGeneralQuery(senderId, client, messageText);
      }
    }

    // Handle Comments
    for (const change of entry.changes || []) {
      if (change.field === "comments" && change.value) {
        const comment = change.value;
        if (comment.text) {
          console.log(`Comment: ${comment.text}`);
          const client = await getClientByIgUserId(entry.id);
          if (!client) continue;
          const reply = await generateCommentReply(comment.text, client);
          await replyToComment(comment.id, reply);
        }
      }
    }
  }
});

// ── Extract Instagram post/reel ID from URL ───────────────────────────────────
function extractPostId(text) {
  const match = text.match(/instagram\.com\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

// ── Resolve Instagram media ID to post shortcode ──────────────────────────────
async function getShortcodeFromMediaId(mediaId) {
  try {
    const res = await axios.get(
      `https://graph.instagram.com/v21.0/${mediaId}`,
      { params: { fields: "shortcode", access_token: IG_ACCESS_TOKEN } }
    );
    console.log("Resolved shortcode:", res.data.shortcode);
    return res.data.shortcode || null;
  } catch (err) {
    console.error("Shortcode lookup error:", err.response?.data || err.message);
    return null;
  }
}

// ── Check if customer wants to buy ───────────────────────────────────────────
function isOrderIntent(text) {
  const orderKeywords = [
    "اريد اشتري", "أريد أشتري", "ابي اشتري", "أبي أشتري",
    "اريد احجز", "أريد أحجز", "بدي اشتري", "حجز", "طلب",
    "i want to buy", "i want to order", "i'll take it", "i want this",
    "دەمەوێت بیکڕم", "دەمەوێت بیکڕێت", "کڕینەکەم", "دەیکڕم",
    "danam bo dani", "danam", "bom bda", "bom bna", "order", "dakam",
    "dabi", "wam bda", "wam bdn", "bo dani", "bkrem"
  ];
  return orderKeywords.some(k => text.toLowerCase().includes(k.toLowerCase()));
}

// ── Language label for prompts ────────────────────────────────────────────────
function getLangLabel(language) {
  if (language === "kurdish") return `Sorani Kurdish (کوردی سۆرانی) as spoken in Kurdistan Region of Iraq. Rules:
- Use natural short everyday expressions, never formal or translated text
- Maximum 1-2 sentences, never more
- If the customer says thank you or anything positive, just reply with ❤️ or 🙏 only — no extra words
- Never transliterate names or places — keep them exactly as the customer typed them (Latin or Kurdish)
- Use هەر not هیچ when meaning "anything"
- Never repeat info the customer already knows
- Never add extra sentences like "if you need anything let us know" or "we will contact you soon"`;
  if (language === "arabic") return "Iraqi Arabic dialect, short and natural, max 1-2 sentences";
  return "English, short and natural, max 1-2 sentences";
}

// ── Get client from DB by Instagram user ID ───────────────────────────────────
async function getClientByIgUserId(igUserId) {
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .eq("instagram_user_id", igUserId)
    .single();
  if (error) console.error("DB error:", error.message);
  return data;
}

// ── Get last 15 products for a client ─────────────────────────────────────────
async function getRecentProducts(clientId) {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("client_id", clientId)
    .eq("is_available", true)
    .order("created_at", { ascending: false })
    .limit(15);
  if (error) console.error("DB error:", error.message);
  return data || [];
}

// ── Find product by post ID ───────────────────────────────────────────────────
async function getProductByPostId(clientId, postId) {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("client_id", clientId)
    .eq("post_id", postId)
    .single();
  if (error) console.error("DB error:", error.message);
  return data;
}

// ── Save message to conversation history ──────────────────────────────────────
async function saveMessage(clientId, customerIgId, role, content) {
  const { error } = await supabase.from("messages").insert({
    client_id: clientId,
    customer_ig_id: customerIgId,
    role: role,
    content: content
  });
  if (error) console.error("Save message error:", error.message);
}

// ── Get conversation history (last 8 messages) ────────────────────────────────
async function getConversationHistory(clientId, customerIgId) {
  const { data } = await supabase
    .from("messages")
    .select("role, content")
    .eq("client_id", clientId)
    .eq("customer_ig_id", customerIgId)
    .neq("content", "")
    .not("content", "is", null)
    .order("created_at", { ascending: false })
    .limit(8);
  return (data || []).reverse().filter(m => m.content && m.content.trim()); // oldest first, no empty messages
}

// ── Handle post link query ────────────────────────────────────────────────────
async function handlePostLinkQuery(senderId, client, postId) {
  const product = await getProductByPostId(client.id, postId);
  if (product) {
    const reply = formatProductReply(product, client.language);
    await sendDM(senderId, reply);
    await saveMessage(client.id, senderId, "assistant", reply);
    await saveOrder(client.id, senderId, product.id, "interested");
  } else {
    const reply = client.language === "arabic"
      ? "شكراً! سأتحقق من السعر وأعود إليك قريباً ⏳"
      : client.language === "kurdish"
      ? "سپاس! نرخەکە دەبینم و زوو وەڵامت دەدەمەوە ⏳"
      : "Thanks! Let me check on that and get back to you shortly ⏳";
    await sendDM(senderId, reply);
    await saveMessage(client.id, senderId, "assistant", reply);
    await flagForHumanReply(client.id, senderId, "Post not found in database");
  }
}

// ── Handle image/screenshot query ────────────────────────────────────────────
async function handleImageQuery(senderId, client, imageUrl, messageText) {
  const products = await getRecentProducts(client.id);
  if (products.length === 0) {
    await flagForHumanReply(client.id, senderId, "No products in database");
    return;
  }

  const productList = products.map(p =>
    `- ${p.product_name}: ${p.price} ${p.currency}${p.colors ? ", Colors: " + p.colors : ""}${p.sizes ? ", Sizes: " + p.sizes : ""}`
  ).join("\n");

  const systemPrompt = `You are a helpful shopping assistant for ${client.shop_name}, an Instagram shop. Always reply in ${getLangLabel(client.language)}. Be warm, friendly, and natural. Keep replies under 3 sentences.`;

  const userContent = `A customer sent an image. Here are the shop's products:\n${productList}\n\nBased on image URL (${imageUrl}) and message "${messageText}", match to a product and reply with price and details. If no match, say you will check and get back to them.`;

  const history = await getConversationHistory(client.id, senderId);
  const reply = await callClaude(systemPrompt, [...history, { role: "user", content: userContent }]);
  await sendDM(senderId, reply);
  await saveMessage(client.id, senderId, "assistant", reply);

  if (reply.includes("check") || reply.includes("get back") || reply.includes("أتحقق") || reply.includes("دەبینم")) {
    await flagForHumanReply(client.id, senderId, "Image not matched to product");
  } else {
    await saveOrder(client.id, senderId, null, "interested");
  }
}

// ── Handle order intent ───────────────────────────────────────────────────────
async function handleOrder(senderId, client, messageText) {
  const reply = client.language === "arabic"
    ? "تم تسجيل طلبك! ✅ سنتواصل معك قريباً 🛍️"
    : client.language === "kurdish"
    ? "داواکارییەکەت تۆمارکرا! ✅ بەم زووانە پەیوەندیت پێوە دەکەین 🛍️"
    : "Order registered! ✅ We'll contact you soon 🛍️";
  await sendDM(senderId, reply);
  await saveMessage(client.id, senderId, "assistant", reply);
  await saveOrder(client.id, senderId, null, "ordered");
}

// ── Handle general query ──────────────────────────────────────────────────────
async function handleGeneralQuery(senderId, client, messageText) {
  const products = await getRecentProducts(client.id);
  const productContext = products.length > 0
    ? `Shop products:\n${products.map(p => `- ${p.product_name}: ${p.price} ${p.currency}`).join("\n")}`
    : "";

  const systemPrompt = `You are a friendly assistant for ${client.shop_name}, an Instagram shop. Always reply in ${getLangLabel(client.language)}. Be warm, natural, and helpful. Keep replies under 3 sentences.${productContext ? "\n\n" + productContext : ""}`;

  const history = await getConversationHistory(client.id, senderId);
  const reply = await callClaude(systemPrompt, [...history, { role: "user", content: messageText }]);
  await sendDM(senderId, reply);
  await saveMessage(client.id, senderId, "assistant", reply);
}

// ── Format product reply ──────────────────────────────────────────────────────
function formatProductReply(product, language) {
  if (language === "arabic") {
    let msg = `سلام! السعر ${product.price} دينار`;
    if (product.sizes) msg += `\nالمقاسات: ${product.sizes}`;
    if (product.colors) msg += `\nالألوان: ${product.colors}`;
    return msg;
  } else if (language === "kurdish") {
    let msg = `سڵاو! بەرێزم نرخی ${Number(product.price).toLocaleString("ar-EG")} هەزارە`;
    if (product.sizes) msg += `\nقەبارەکان: ${product.sizes}`;
    if (product.colors) msg += `\nڕەنگەکان: ${product.colors}`;
    return msg;
  } else {
    let msg = `Hi! The price is ${product.price} ${product.currency}`;
    if (product.sizes) msg += `\nSizes: ${product.sizes}`;
    if (product.colors) msg += `\nColors: ${product.colors}`;
    return msg;
  }
}

// ── Save order to DB ──────────────────────────────────────────────────────────
async function saveOrder(clientId, customerIgId, productId, status) {
  const { error } = await supabase.from("orders").upsert({
    client_id: clientId,
    customer_ig_id: customerIgId,
    product_id: productId,
    status: status,
    label: status,
    updated_at: new Date().toISOString()
  }, { onConflict: "client_id,customer_ig_id" });
  if (error) console.error("Order save error:", error.message);
}

// ── Flag conversation for human reply ─────────────────────────────────────────
async function flagForHumanReply(clientId, customerIgId, notes) {
  const { error } = await supabase.from("orders").upsert({
    client_id: clientId,
    customer_ig_id: customerIgId,
    status: "needs_answer",
    label: "needs_answer",
    notes: notes,
    updated_at: new Date().toISOString()
  }, { onConflict: "client_id,customer_ig_id" });
  if (error) console.error("Flag error:", error.message);
  console.log(`⚠️ Flagged conversation ${customerIgId} for human reply: ${notes}`);
}

// ── Call Claude API ───────────────────────────────────────────────────────────
async function callClaude(systemPrompt, messages) {
  try {
    const response = await axios.post(
      "https://claude.gg/v1/chat/completions",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 200,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${CLAUDE_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );
    return response.data.choices[0].message.content.trim();
  } catch (err) {
    console.error("Claude error:", err.response?.data || err.message);
    return "Thanks for your message! We'll get back to you shortly. 😊";
  }
}

// ── Generate reply for comments ───────────────────────────────────────────────
async function generateCommentReply(message, client) {
  const systemPrompt = `You are a friendly assistant for ${client.shop_name} on Instagram. Reply in ${getLangLabel(client.language)}. Keep it under 2 sentences. Be warm and engaging.`;
  return await callClaude(systemPrompt, [{ role: "user", content: message }]);
}

// ── Send DM ───────────────────────────────────────────────────────────────────
async function sendDM(recipientId, message) {
  try {
    await axios.post(
      "https://graph.instagram.com/v21.0/me/messages",
      { recipient: { id: recipientId }, message: { text: message } },
      { params: { access_token: IG_ACCESS_TOKEN } }
    );
    console.log(`DM sent to ${recipientId}`);
  } catch (err) {
    console.error("Send DM error:", err.response?.data || err.message);
  }
}

// ── Reply to comment ──────────────────────────────────────────────────────────
async function replyToComment(commentId, message) {
  try {
    await axios.post(
      `https://graph.instagram.com/v21.0/${commentId}/replies`,
      { message },
      { params: { access_token: IG_ACCESS_TOKEN } }
    );
    console.log("Comment reply sent");
  } catch (err) {
    console.error("Reply comment error:", err.response?.data || err.message);
  }
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("FastReplyAI v2 is running! 🚀");
});

app.listen(PORT, () => {
  console.log(`FastReplyAI server running on port ${PORT}`);
});