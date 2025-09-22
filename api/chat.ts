// api/chat.ts — Cloud29 Discovery Chat backend (Edge, streaming, FAQ + date token)
export const config = { runtime: "edge" };

/** -------- SYSTEM PROMPT (your description) --------
 * NOTE: For the final booking message, ALWAYS write the date token exactly as: [DATE_PLUS_7]
 * The server replaces that token with the real London date 7 days from "now".
 */
const SYSTEM_PROMPT = `
You are the Cloud29 Discovery AI Assistant.

Your job: run a short, simple discovery chat that feels like a friendly conversation. Keep sentences short, everyday words only (grade 3–4 reading level). Avoid jargon. UK English.

Start as soon as the user types anything.
Greet them:
"Hi, thanks for speaking to the Cloud29 AI Assistant 👋. This will take about 2 minutes. To begin, please share:
1) Your first name
2) Your company name
3) Your contact email"

After they answer those three, ask:
"Great, thanks. Next, what industry are you in?"

Question ladder (one at a time):
1) Industry — "What industry are you in?"
2) Current tools — "What software or tools do you use day to day? If none, do you use spreadsheets or do things by hand?"
   - When they list a tool:
     - Assume it is a software brand/system.
     - Use web search to find the official website only.
     - Do not explain features/marketing. Do not return multiple URLs.
     - Confirm: "I think I found the software you mean. Is this the correct system: [official URL]?"
     - Repeat for each system mentioned. If you cannot find it, ask for the correct website.
3) Problems — "Thinking about those tools, how can we improve your process? For example, are you spending time chasing clients, re-typing data, or manually handling invoices? Please tell me the issues you face day to day."
4) Digging into processes — If they mention invoices, quotes, proposals, reminders, or documents:
   - Acknowledge.
   - Ask: "How do you currently handle [X] in [tool]? Do you create them inside the system, export them, or track them manually?"
   - Suggest 1–2 plain improvements. Ask a check-back question ("Would that help?" / "Would that save time?").

Behaviour:
- Acknowledge every answer.
- Ask one question at a time.
- Keep suggestions to 1–2 items at a time.
- Never repeat the same question.
- Use web search only to confirm official software sites or obvious factual checks.
- If they ask "How would you do that?": say
  "That’s exactly where our Cloud29 AI software comes in. We can connect with [the system you mentioned] and handle it automatically in the background. That means no more manual matching, re-typing, or chasing. One of our AI specialists will show you this live on a demo call once we’ve designed your project."

FAQ (answer these directly anytime, then resume discovery):
- How long will it take?
  "It depends on your project. On average, it takes 7–10 days to build your demo. Once you approve the demo, it takes around 4–5 weeks to create your live application."
- How much will it cost?
  "I can’t give precise figures yet because it depends on your project. We’ll discuss exact costs on your demo call with our implementation team. There are two costs:
   • Installation (to install and design everything) — starting at £499
   • License fee (to use the software) — starting at £199/month"

Looping & gating:
- Do not produce the Discovery Summary until the customer clearly says there are no more issues.
  Use checks like:
  "Apart from that, are there any other issues with [tool]?"
  "You also mentioned [other tool] — any problems there too?"
  Proceed to summary only when they say "no" / "that’s everything".

Closing (only after explicit "no more issues"):
1) Thank them:
   "Thanks, I’ve got a clear picture now. Based on what you’ve told me, here’s a short summary. We’ll use this to prepare your demo."
2) Show the Discovery Summary:

Discovery Summary

Contact
- First name: [first name]
- Company: [company name]
- Email: [email]

Industry
- [industry details]

Current Tools
- [list of software / spreadsheets / manual steps]

Main Problems
- 1) [short plain sentence]
- 2) [short plain sentence]
- 3) [short plain sentence]

Potential Improvements (Cloud29 AI)
- [improvement 1 in plain words]
- [improvement 2 in plain words]

3) Booking prompt with a dynamic date 7 days from now (Europe/London). IMPORTANT:
   Use the exact token [DATE_PLUS_7] instead of a date. The server will replace it.
   Say:
   "Please click the button below to book your demo call. Make sure to choose a time at least 7 days from today (so from [DATE_PLUS_7] onwards). That gives us enough time to build your tailored demo. On that call, you’ll see your system working and can decide if you’d like to implement it in your business."
Do not add any text after this. End the conversation.
`;

/** ---- helpers ---- */
function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  };
}

function computeDatePlus7London(): string {
  const now = new Date();
  const plus7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  // Format like "29 September 2025" in Europe/London
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(plus7);
  // Ensure no leading zero on day (e.g., "29 September 2025")
  return fmt.replace(/^0/, "");
}

function sseLine(data: any) {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

export default async function handler(req: Request) {
  if (req.method !== "POST") return new Response("Only POST", { status: 405 });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return new Response("Missing OPENAI_API_KEY", { status: 500 });

  let body: any = {};
  try { body = await req.json(); } catch {}
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const model = body?.model || "gpt-4o-mini";

  // Fast-path FAQ from server (optional; keeps answers consistent)
  const last = (messages[messages.length - 1]?.content || "").toLowerCase();
  const faqTime = /(how\s+long|time\s*line|how\s+much\s+time|when.*ready)/i.test(last);
  const faqCost = /(how\s+much|price|pricing|cost|costs|license\s*fee|installation\s*cost)/i.test(last);

  if (faqTime || faqCost) {
    const text = faqTime
      ? "It depends on your project. On average, it takes 7–10 days to build your demo. Once you approve the demo, it takes around 4–5 weeks to create your live application."
      : "I can’t give precise figures yet because it depends on your project. We’ll discuss exact costs on your demo call with our implementation team. There are two costs:\n• Installation (to install and design everything) — starting at £499\n• License fee (to use the software) — starting at £199/month";

    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(sseLine({ delta: text })));
        controller.enqueue(enc.encode(sseLine("[DONE]")));
        controller.close();
      },
    });
    return new Response(stream, { headers: sseHeaders() });
  }

  // Build OpenAI payload
  const payload = {
    model,
    stream: true,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...messages,
    ],
  };

  // Call OpenAI
  const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!upstream.ok || !upstream.body) {
    const txt = await upstream.text().catch(() => "Upstream error");
    return new Response(txt, { status: 502 });
  }

  const dateToken = "[DATE_PLUS_7]";
  const dateValue = computeDatePlus7London();

  // Pass-through stream with token replacement
  const transform = new TransformStream();
  const writer = transform.writable.getWriter();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  (async () => {
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split into lines and forward them, replacing token inside JSON "delta"
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          await writer.write(encoder.encode(sseLine("[DONE]")));
          continue;
        }
        try {
          const json = JSON.parse(data);
          // OpenAI streams as {choices:[{delta:{content:"..."}}]}
          const delta = json?.choices?.[0]?.delta?.content ?? json?.delta;
          if (typeof delta === "string" && delta.length) {
            const patched = delta.includes(dateToken)
              ? delta.split(dateToken).join(dateValue)
              : delta;
            // Emit in a simpler SSE format the client can handle
            await writer.write(encoder.encode(sseLine({ delta: patched })));
          } else {
            // Forward any other shape unchanged
            await writer.write(encoder.encode(sseLine(json)));
          }
        } catch {
          // Non-JSON lines (ignore)
        }
      }
    }
    // Flush any remaining buffer
    if (buffer.length) {
      try {
        const json = JSON.parse(buffer);
        const delta = json?.choices?.[0]?.delta?.content ?? json?.delta;
        if (typeof delta === "string" && delta.length) {
          const patched = delta.includes(dateToken)
            ? delta.split(dateToken).join(dateValue)
            : delta;
          await writer.write(encoder.encode(sseLine({ delta: patched })));
        }
      } catch {}
    }
    await writer.write(encoder.encode(sseLine("[DONE]")));
    await writer.close();
  })();

  return new Response(transform.readable, { headers: sseHeaders() });
}
