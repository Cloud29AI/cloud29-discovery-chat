// api/chat.ts — Cloud29 Discovery Chat backend (Edge, streaming, FAQ + date + tone variation + canned answers)
export const config = { runtime: "edge" };

const SYSTEM_PROMPT = `
You are the Cloud29 Discovery AI Assistant.

Core rules:
- Friendly, UK English, grade 3–4 reading level.
- Greet, collect first name/company/email, then industry → tools → problems.
- One question at a time. Acknowledge each answer.
- Use clickable markdown links [https://url](https://url) when confirming software.
- Confirmation wording: "I found this official website: [URL]. Please confirm if this is the correct system, as it’s important we note the right CRM/software you use."
- Never repeat the same question exactly. Rotate phrasings for "any other issues" (e.g. "Anything else to note?", "Any other challenges with [tool]?", "Apart from that, is there more?").
- If asked "how will I see what’s going on?" → answer:
  "You’ll get a secure Cloud29 login. Inside, you can see everything we’ve built for you — live and in one place. That means no chasing or guessing; you’ll be able to view your automations and data any time."
- FAQ answers:
  - How long: "On average, it takes 7–10 days to build your demo. Once you approve it, it takes 4–5 weeks to create your live application."
  - How much: "There are two costs: Installation — starting at £499. License fee — starting at £199/month. Exact figures depend on your project and are explained in the demo."
- Do not produce the Discovery Summary until the user clearly says there are no more issues.
- When closing, always use the token [DATE_PLUS_7] (the server replaces this with the real UK date).
`;

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
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(plus7);
  return fmt;
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

  // FAQ shortcuts
  const last = (messages[messages.length - 1]?.content || "").toLowerCase();
  const faqTime = /(how\s+long|timeline|how\s+much\s+time|when.*ready)/i.test(last);
  const faqCost = /(how\s+much|price|pricing|cost|license|installation)/i.test(last);
  const faqVisibility = /(how.*see|how.*going|how.*track|how.*watch)/i.test(last);

  if (faqTime || faqCost || faqVisibility) {
    const text = faqTime
      ? "On average, it takes 7–10 days to build your demo. Once you approve it, it takes 4–5 weeks to create your live application."
      : faqCost
        ? "There are two costs: Installation — starting at £499. License fee — starting at £199/month. Exact figures depend on your project and are explained in the demo."
        : "You’ll get a secure Cloud29 login. Inside, you can see everything we’ve built for you — live and in one place. That means no chasing or guessing; you’ll be able to view your automations and data any time.";

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

  const payload = {
    model,
    stream: true,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
  };

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
          const delta = json?.choices?.[0]?.delta?.content ?? json?.delta;
          if (typeof delta === "string" && delta.length) {
            const patched = delta.includes(dateToken)
              ? delta.replaceAll(dateToken, dateValue)
              : delta;
            await writer.write(encoder.encode(sseLine({ delta: patched })));
          }
        } catch {}
      }
    }
    if (buffer.length) {
      try {
        const json = JSON.parse(buffer);
        const delta = json?.choices?.[0]?.delta?.content ?? json?.delta;
        if (typeof delta === "string" && delta.length) {
          const patched = delta.includes(dateToken)
            ? delta.replaceAll(dateToken, dateValue)
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
