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
          console.log("Shared post FULL PAYLOAD:", JSON.stringify(sharedPost.payload));

          // Try direct URL match first
          const directPostId = extractPostId(attachUrl);
          if (directPostId) {
            await handlePostLinkQuery(senderId, client, directPostId, attachUrl);
            continue;
          }

          // Use ig_post_media_id from payload directly if available
          const mediaId = sharedPost.payload?.ig_post_media_id
            || attachUrl.match(/asset_id=(\d+)/)?.[1];
          if (mediaId) {
            // Try direct media_id lookup first (handles carousels too)
            const productByMediaId = await getProductByMediaId(client.id, mediaId);
            if (productByMediaId) {
              await handleProductFound(senderId, client, productByMediaId);
              continue;
            }
            // Fall back to shortcode resolution
            const shortcode = await getShortcodeFromMediaId(mediaId);
            if (shortcode) {
              await handlePostLinkQuery(senderId, client, shortcode, attachUrl);
              continue;
            }
          }

          // Fallback: use image recognition directly on the CDN image
          if (attachUrl) {
            console.log("Falling back to image recognition for shared post");
            await handleImageQuery(senderId, client, attachUrl, messageText);
            continue;
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
    "dabi", "wam bda", "wam bdn", "bo dani", "bkrem",
    "yak dana", "dw dana", "sei dana", "chwar dana", "penj dana",
    "1 dana", "2 dana", "3 dana", "4 dana", "5 dana",
    "lawam bo daney", "lawam bda", "lawam bo"
  ];
  return orderKeywords.some(k => text.toLowerCase().includes(k.toLowerCase()));
}

// ── Language label for prompts ────────────────────────────────────────────────
function getLangLabel(language) {
  if (language === "kurdish") return `You are a shop assistant who speaks Sulaimani Sorani Kurdish (کوردی سۆرانی سلێمانی) as spoken by everyday people in Sulaymaniyah city.

GOOD EXAMPLES (speak exactly like this):
- "سڵاو! نرخی ٣٥ هەزارەیە 😊"
- "باشە بەڕێز، ناو و ژمارە و شارت بنێرە"
- "داواکارییەکەت وەرگیرا ✅"
- "چ قەبارەیەک دەتەوێت؟"
- "داواکارییەکەت وەرگیرا ✅"

BAD EXAMPLES (NEVER say these):
- NEVER: دووکانەکە کۆی گشتی پشتڕاست دەکاتەوە
- NEVER: تۆڵکراوەتەوە
- NEVER: یەکجا، بەیاد، شتانە، پشتڕاستکردنەوە، کۆی گشتی
- NEVER translate word-by-word from English or Arabic
- NEVER use formal/news/literary Kurdish — only street Sulaimani dialect

RULES:
- Maximum 2 short sentences, never more
- If customer says thank you, dastxosh, spass, or anything positive → reply ❤️ ONLY, nothing else
- Never use 🙏 emoji, use ❤️ instead
- Keep names and places exactly as customer typed them (sardaw stays sardaw, NOT سەردەو)
- Use هەر not هیچ
- When customer wants to order → ask for name, phone, city ALL IN ONE message
- NEVER mention product names or numbers — never say بەرھەم ١ بەرھەم ٢ بەرھەم ٣ or any product label
- Kurdish numbers: yak=1, dw=2, sei=3, chwar=4, penj=5, dana=piece/unit
- Only use info from the CURRENT conversation`;
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

// ── In-memory cache for carousel children ────────────────────────────────────
const carouselChildCache = new Map();

async function fetchCarouselChildren(mediaId) {
  try {
    const res = await axios.get(
      `https://graph.instagram.com/v21.0/${mediaId}/children`,
      { params: { fields: "id", access_token: IG_ACCESS_TOKEN } }
    );
    const ids = new Set((res.data.data || []).map(c => c.id));
    console.log(`Carousel children of ${mediaId}:`, [...ids]);
    return ids;
  } catch (e) {
    return new Set();
  }
}

// ── Find product by Instagram media ID (handles carousel children too) ────────
async function getProductByMediaId(clientId, mediaId) {
  // Direct match first
  const { data } = await supabase
    .from("products")
    .select("*")
    .eq("client_id", clientId)
    .eq("media_id", mediaId)
    .single();
  if (data) return data;

  // Check if mediaId is a child of any product's carousel
  const { data: products } = await supabase
    .from("products")
    .select("*")
    .eq("client_id", clientId)
    .not("media_id", "is", null);

  for (const product of products || []) {
    let children = carouselChildCache.get(product.media_id);
    if (!children) {
      children = await fetchCarouselChildren(product.media_id);
      carouselChildCache.set(product.media_id, children);
    }
    if (children.has(mediaId)) {
      console.log(`Found product via carousel child: ${mediaId} → ${product.post_id}`);
      return product;
    }
  }
  return null;
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

// ── Get conversation history (last 20 messages, within 6 hours) ───────────────
async function getConversationHistory(clientId, customerIgId) {
  const sixHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("messages")
    .select("role, content")
    .eq("client_id", clientId)
    .eq("customer_ig_id", customerIgId)
    .neq("content", "")
    .not("content", "is", null)
    .gte("created_at", sixHoursAgo)
    .order("created_at", { ascending: false })
    .limit(25);
  return (data || []).reverse().filter(m => m.content && m.content.trim()); // oldest first, no empty messages
}

// ── Handle a found product (shared logic) ────────────────────────────────────
async function handleProductFound(senderId, client, product) {
  const reply = formatProductReply(product, client.language);

  // Check if customer already has a completed order — ask if they want to add to it
  const { data: existingOrder } = await supabase
    .from("orders")
    .select("status")
    .eq("client_id", client.id)
    .eq("customer_ig_id", senderId)
    .single();

  if (existingOrder && existingOrder.status === "ordered") {
    const addToOrderMsg = client.language === "kurdish"
      ? `${reply}\n\nدەتەوێت ئەمەش بخەینە سەر ئەو ئۆردەرەکەی پێشوت؟`
      : client.language === "arabic"
      ? `${reply}\n\nهل تريد إضافته لطلبك السابق؟`
      : `${reply}\n\nWould you like to add this to your previous order?`;
    await sendDM(senderId, addToOrderMsg);
    await saveMessage(client.id, senderId, "assistant", `[${product.product_name} - ${product.price} ${product.currency}] ${addToOrderMsg}`);
    await addToCart(client.id, senderId, product);
    return;
  }

  await sendDM(senderId, reply);
  await saveMessage(client.id, senderId, "assistant", `[${product.product_name} - ${product.price} ${product.currency}] ${reply}`);
  await addToCart(client.id, senderId, product);
  await saveOrder(client.id, senderId, product.id, "interested");
}

// ── Handle post link query ────────────────────────────────────────────────────
async function handlePostLinkQuery(senderId, client, postId, fallbackImageUrl = null) {
  const product = await getProductByPostId(client.id, postId);
  if (product) {
    await handleProductFound(senderId, client, product);
  } else if (fallbackImageUrl) {
    // Post ID not found — try image recognition with the actual image
    console.log("Post ID not found, falling back to image recognition:", postId);
    await handleImageQuery(senderId, client, fallbackImageUrl, "");
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

// ── Add product to cart ───────────────────────────────────────────────────────
async function addToCart(clientId, customerIgId, product) {
  const { error } = await supabase.from("cart").upsert({
    client_id: clientId,
    customer_ig_id: customerIgId,
    product_id: product.id,
    product_name: product.product_name,
    price: product.price,
    currency: product.currency
  }, { onConflict: "client_id,customer_ig_id,product_id" });
  if (error) console.error("Cart error:", error.message);
}

// ── Get cart items ────────────────────────────────────────────────────────────
async function getCart(clientId, customerIgId) {
  const { data, error } = await supabase
    .from("cart")
    .select("*")
    .eq("client_id", clientId)
    .eq("customer_ig_id", customerIgId)
    .order("created_at", { ascending: true });
  if (error) console.error("Cart fetch error:", error.message);
  return data || [];
}

// ── Clear cart after order ────────────────────────────────────────────────────
async function clearCart(clientId, customerIgId) {
  await supabase.from("cart").delete()
    .eq("client_id", clientId)
    .eq("customer_ig_id", customerIgId);
}

// ── Handle order intent ───────────────────────────────────────────────────────
async function handleOrder(senderId, client, messageText) {
  const history = await getConversationHistory(client.id, senderId);

  // Read cart directly from DB — no guessing from history
  const cartItems = await getCart(client.id, senderId);
  const cartText = cartItems.length > 0
    ? cartItems.map(p => `- ${p.product_name}: ${p.price} ${p.currency}`).join("\n")
    : "";

  // Check if there's already a completed order
  const { data: existingOrder } = await supabase
    .from("orders")
    .select("status")
    .eq("client_id", client.id)
    .eq("customer_ig_id", senderId)
    .single();
  const hasPreviousOrder = existingOrder && existingOrder.status === "ordered";

  const systemPrompt = `${cartText ? `⚠️ CURRENT CART (USE ONLY THESE PRICES - IGNORE ALL PRICES IN CONVERSATION HISTORY):\n${cartText}\n\n` : ""}You are a friendly assistant for ${client.shop_name}, an Instagram shop. Always reply in ${getLangLabel(client.language)}.

The customer wants to place an order.${hasPreviousOrder ? `\n⚠️ THIS CUSTOMER ALREADY HAS A PREVIOUS ORDER. Ask them: "دەتەوێت ئەمەش بخەینە سەر ئەو ئۆردەرەکەی پێشوت؟" and wait for their answer before collecting info.` : ""}

Your job:
1. If customer has a previous order → ask if they want to add to it first
2. If no name/phone/address yet → ask for ALL THREE in one message: "بەڕێزم، ناو و ژمارەی تەلەفون و ناونیشانەکەت بنێرە بێزەحمەت 😊"
3. Once you have name, phone, address → confirm using EXACTLY this format:
داواکارییەکەت وەرگیرا ✅
ناو: [name exactly as typed]
ژمارە: [phone]
ناونیشان: [address exactly as typed]
نرخ: [price from CART ABOVE ONLY] هەزار ❤️

RULES:
- ONLY use prices from the CART — never from history
- NEVER calculate totals
- If cart has multiple items, one نرخ: line each
- You can add one closing line after ❤️`;

  const reply = await callClaude(systemPrompt, [...history, { role: "user", content: messageText }]);
  await sendDM(senderId, reply);
  await saveMessage(client.id, senderId, "assistant", reply);

  // Mark as ordered only if reply contains the confirmation format
  if (reply.includes("داواکارییەکەت وەرگیرا")) {
    await saveOrder(client.id, senderId, null, "ordered");
    await clearCart(client.id, senderId);
    await saveMessage(client.id, senderId, "assistant", "[ORDER COMPLETED - ignore all prices and quantities mentioned before this line]");
  } else {
    await saveOrder(client.id, senderId, null, "collecting_info");
  }
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