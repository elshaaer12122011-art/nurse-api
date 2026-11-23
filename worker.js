// Cloudflare Worker — وسيط الذكاء الاصطناعي لتطبيق Staff Nurse Schedule
// المتغيرات (Settings > Variables):
//   ANTHROPIC_KEY  (Secret)  مفتاح Claude API — ما يتحطش في التطبيق أبدًا
//   ALLOWED_ORIGIN (Text)    https://elshaaer12122011-art.github.io
//   MODEL          (Text)    claude-haiku-5-5  (الأرخص — الافتراضي)  أو claude-sonnet-5-5 (أدق وأغلى)
//   LIMIT_IP       (Text)    20    حد الطلبات اليومي لكل جهاز
//   LIMIT_ALL      (Text)    200   حد الطلبات اليومي للتطبيق كله
// الربط: KV Namespace باسم KV

const PROMPT = `You are reading a photo/scan of a hospital nurse duty roster (monthly grid). The page may contain: the nurse table, a "Balance" block, a Legends block, and a separate "Workers" table.
Return ONLY one JSON object, no prose, in this exact shape:
{"month":"YYYY-MM or empty","days":<number of day columns, e.g. 30>,"rows":[{"name":"<nurse name as printed>","title":"<job title column if any, e.g. HN, CN, SN-S2, else empty>","id":"<staff id digits if any>","cells":["<day 1>","<day 2>", ... one string per day column]}],"workers":[{"name":"...","title":"...","id":"...","cells":[...]}],"legend":{"<CODE>":"<meaning as printed>"}}
Rules:
- "rows" = NURSES only (the main table). Ignore headers, the day-of-week row, "Balance"/total rows, signatures.
- "workers" = rows of the separate table titled "Workers" (same cell format). Empty array if none on this page.
- "legend" = every abbreviation explained in the Legends block, e.g. {"D":"07:00-19:00","N":"19:00-07:00","M":"07:00-15:00","SL":"Sick Leave","OC":"On Call Day","O.C":"On call Night","AL":"Annual Leave","EL":"Educational Leave","ABS":"Absent","CL":"Compassionate Leave","ML":"Maternity Leave"}. Empty object if none on this page.
- "month": from the date at the top-left such as "1-Nov-2026" -> "2026-11". Empty if not visible.
- Copy each cell EXACTLY as printed: D, N, M, E, AL, SL, EL, HC, TB, ABS, CL, ML, OC, O.C, or a time range like (11-19), (15-19), (23-7). "OC" and "O.C" are DIFFERENT codes: keep the dot exactly. Use "" for an empty cell. Never guess or fill empty cells.
- Keep row order as printed. The "cells" array length must equal "days" for every row. Do not include the per-row total column (T) or any column after the last day.`;

const NLU_PROMPT = `You rewrite a head nurse's free-text scheduling instructions (Arabic, Egyptian Arabic, English or mixed) into SIMPLE ENGLISH sentences that a rule parser understands.
You get: the nurses' names, the number of days in the month, and a list of sentences the parser could not understand.
Return ONLY JSON: {"out":[[ "rewritten sentence", ... ], ...]} — one array per input sentence, same order. Use [] if a sentence is chatter/noise with no scheduling instruction.
Rules:
- Use the EXACT nurse name from the list (full name as given) whenever a nurse is mentioned; match Arabic or misspelled names to the closest listed name. If the sentence is about everybody, write "everyone".
- One request per rewritten sentence. Use only these shapes:
  "<name> off on day 5, 6 and 9 to 12"   "<name> night on day 3"   "<name> day on day 3"   "<name> annual leave from day 10 to 14"
  "<name> no night shifts"   "<name> no day shifts"   "everyone off on Friday"   "<name> no more than 3 consecutive work days"
  "<name> no more than 2 consecutive night shifts"   "<name> must work 15 shifts"
- Convert Arabic weekday words to English (Saturday...Friday). Convert Arabic digits to normal digits.
- Do not invent requests. Do not add names that are not in the sentence.`;

export default {
  async fetch(req, env) {
    const allow = env.ALLOWED_ORIGIN || '*';
    const cors = { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST,OPTIONS' };
    const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return new Response('ok', { headers: cors });
    if (allow !== '*' && (req.headers.get('Origin') || '') !== allow) return J({ error: 'forbidden' }, 403);

    const kv = env.KV, day = new Date().toISOString().slice(0, 10);
    const ip = req.headers.get('CF-Connecting-IP') || 'x';
    const kI = `i:${day}:${ip}`, kA = `a:${day}`;
    let nI = 0, nA = 0;
    if (kv) {
      nI = +(await kv.get(kI) || 0); nA = +(await kv.get(kA) || 0);
      if (nI >= +(env.LIMIT_IP || 20) || nA >= +(env.LIMIT_ALL || 200)) return J({ error: 'limit' }, 429);
    }

    let b; try { b = await req.json(); } catch (e) { return J({ error: 'bad json' }, 400); }
    const isNlu = b.task === 'nlu';
    if (isNlu) {
      if (!Array.isArray(b.sentences) || b.sentences.length > 20 || !Array.isArray(b.names) || b.names.length > 150) return J({ error: 'bad request' }, 400);
    } else if (b.task !== 'roster' || typeof b.image !== 'string' || b.image.length > 7_000_000) return J({ error: 'bad request' }, 400);

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: env.MODEL || 'claude-haiku-5-5', max_tokens: isNlu ? 3000 : 16000,
        messages: [{ role: 'user', content: isNlu ? [
          { type: 'text', text: NLU_PROMPT + '\n\nNurses: ' + JSON.stringify(b.names.map(x => String(x).slice(0, 60))) + '\nDays in month: ' + (+b.days || 30) + '\nSentences: ' + JSON.stringify(b.sentences.map(x => String(x).slice(0, 400))) }
        ] : [
          { type: 'image', source: { type: 'base64', media_type: b.type === 'image/png' ? 'image/png' : 'image/jpeg', data: b.image } },
          { type: 'text', text: PROMPT }] }]
      })
    });
    if (!r.ok) return J({ error: 'upstream', status: r.status, detail: (await r.text()).slice(0, 300) }, 502);
    const d = await r.json();
    const txt = (d.content || []).map(c => c.text || '').join('');
    const i = txt.indexOf('{'), k = txt.lastIndexOf('}');
    let out; try { out = JSON.parse(txt.slice(i, k + 1)); } catch (e) { return J({ error: 'unparsable', detail: txt.slice(0, 200) + ' ... ' + txt.slice(-150), stop: d.stop_reason }, 502); }
    if (kv) {
      await kv.put(kI, String(nI + 1), { expirationTtl: 90000 });
      await kv.put(kA, String(nA + 1), { expirationTtl: 90000 });
    }
    return J(out);
  }
};
