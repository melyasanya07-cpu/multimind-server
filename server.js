import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;

function envProviderDefs() {
  const defs = [];

  if (process.env.GEMINI_API_KEY) {
    defs.push({
      id: "gemini",
      name: "Google Gemini",
      type: "gemini-native",
      key: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
      base: "https://generativelanguage.googleapis.com/v1beta"
    });
  }

  if (process.env.MISTRAL_API_KEY) {
    defs.push({
      id: "mistral",
      name: "Mistral AI",
      type: "openai-chat",
      key: process.env.MISTRAL_API_KEY,
      model: process.env.MISTRAL_MODEL || "mistral-large-2512",
      base: "https://api.mistral.ai/v1"
    });
  }

  return defs;
}

function publicProviders() {
  return envProviderDefs().map(p => ({
    id: p.id, name: p.name || p.id, model: p.model, enabled: true
  }));
}

async function callProvider(p, system, prompt) {
  if (p.type === "gemini-native") {
    const r = await fetch(`${p.base}/models/${encodeURIComponent(p.model)}:generateContent`, {
      method: "POST",
      headers: {
        "x-goog-api-key": p.key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }]
      })
    });

    const j = await safeJson(r);
    if (!r.ok) throw new Error(`${p.name}: ${errorText(j, r.status)}`);

    const text = (j?.candidates?.[0]?.content?.parts || [])
      .map(x => x?.text || "")
      .join("\n")
      .trim();
    if (!text) throw new Error(`${p.name}: empty response`);
    return text;
  }

  const r = await fetch(`${p.base.replace(/\/$/,"")}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${p.key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: p.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt }
      ]
    })
  });

  const j = await safeJson(r);
  if (!r.ok) throw new Error(`${p.name}: ${errorText(j, r.status)}`);

  const content = j?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const text = content.map(x => typeof x === "string" ? x : (x?.text || "")).join("\n").trim();
    if (text) return text;
  }
  throw new Error(`${p.name}: empty response`);
}

async function safeJson(r) {
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function errorText(j, status) {
  const nested = j?.error;
  return nested?.message || nested?.status || j?.message || j?.detail || j?.raw || `HTTP ${status}`;
}

const rolePrompt = `You are one expert in a multi-AI council.
Give a concrete, useful solution. Do not claim to have consulted other models.
For code tasks, prioritize correctness and implementation details.
For translation/writing tasks, return clean final text.
For factual tasks, distinguish known facts from uncertainty.`;

function judgePrompt(task, drafts) {
  return `You are the final editor and judge of a multi-AI council.
The user asked:
---
${task}
---

Below are independent candidate answers:
${drafts.map((d,i)=>`\n### Candidate ${i+1} (${d.provider})\n${d.text}`).join("\n")}

Produce ONE best final answer for the user.
Do not mention voting, internal chain-of-thought, hidden reasoning, or "candidate 1/2".
Resolve contradictions. Keep the strongest parts, discard errors and repetition.
If candidates disagree on a factual claim and you cannot verify it, explicitly state uncertainty.
Answer in the language of the user's message.`;
}

function reviewPrompt(task, draft) {
  return `Review the following proposed answer to the user's task.
Find concrete mistakes, missing steps, unsafe assumptions, incompatibilities, or better approaches.
Then provide a corrected final version.

USER TASK:
${task}

PROPOSED ANSWER:
${draft}`;
}

function debatePrompt(task, drafts) {
  return `Act as a critical reviewer. The user task is:
${task}

Here are proposed solutions:
${drafts.map(d=>`\n[${d.provider}]\n${d.text}`).join("\n")}

Identify important disagreements and technical errors, then write a superior corrected solution.
Do not expose private reasoning. Return only useful review conclusions and improved answer.`;
}

async function parallelDrafts(providers, task) {
  const settled = await Promise.allSettled(
    providers.map(p => callProvider(p, rolePrompt, task).then(text => ({provider:p.name, p, text})))
  );
  const ok = settled.filter(x => x.status === "fulfilled").map(x => x.value);
  if (!ok.length) throw new Error(settled.map(x => x.reason?.message).join(" | "));
  return ok;
}

function autoMode(message) {
  const m = message.toLowerCase();
  if (message.length < 180 && !/(код|code|архитект|ошиб|bug|сравн|анализ|проект|проверь|review)/i.test(m)) return "single";
  if (/(переведи|translate|übersetz)/i.test(m) && message.length < 1200) return "single";
  if (/(код|code|ошиб|bug|архитект|рефактор|security|безопас)/i.test(m)) return "review";
  return "council";
}

app.get("/api/health", (req,res) => {
  const ps = publicProviders();
  res.json({
    ok: true,
    service: "MultiMind",
    version: "1.1.1",
    providers: ps.length ? ps.map(p=>`${p.name}: ${p.model}`).join(", ") : "none"
  });
});

app.get("/api/providers", (req,res) => {
  res.json({providers: publicProviders()});
});

app.post("/api/chat", async (req,res) => {
  try {
    const message = String(req.body?.message || "").trim();
    let mode = String(req.body?.mode || "auto");
    const project = String(req.body?.project || "").trim();
    if (!message) return res.status(400).json({error:"Empty message"});

    const providers = envProviderDefs();
    if (!providers.length) return res.status(503).json({
      error:"No AI providers configured. Add GEMINI_API_KEY and/or MISTRAL_API_KEY on the server."
    });

    const task = project
      ? `Project context/name: ${project}\nUser request: ${message}`
      : message;

    if (mode === "auto") mode = autoMode(message);

    if (mode === "single" || providers.length === 1) {
      const p = providers[0];
      const answer = await callProvider(p, rolePrompt, task);
      return res.json({answer, mode:"single", used:p.name});
    }

    if (mode === "review") {
      const first = providers[0];
      const second = providers[1] || providers[0];
      const draft = await callProvider(first, rolePrompt, task);
      const answer = await callProvider(second,
        "You are a meticulous expert reviewer and final editor.",
        reviewPrompt(task, draft)
      );
      return res.json({answer, mode:"review", used:`${first.name} → ${second.name}`});
    }

    if (mode === "council") {
      const members = providers.slice(0, Math.min(2, providers.length));
      const drafts = await parallelDrafts(members, task);
      const judge = providers[0];
      const answer = await callProvider(judge,
        "You are the final synthesis editor of a multi-model system.",
        judgePrompt(task, drafts)
      );
      return res.json({
        answer, mode:"council",
        used:`${drafts.map(x=>x.provider).join(" + ")} → Judge: ${judge.name}`
      });
    }

    if (mode === "debate") {
      const members = providers.slice(0, Math.min(2, providers.length));
      const drafts = await parallelDrafts(members, task);
      const reviewer = providers[1] || providers[0];
      const improved = await callProvider(reviewer,
        "You are a critical technical reviewer.",
        debatePrompt(task, drafts)
      );
      const judge = providers[0];
      const final = await callProvider(judge,
        "You are the final editor. Produce one polished answer.",
        judgePrompt(task, [{provider:reviewer.name,text:improved}, ...drafts])
      );
      return res.json({
        answer: final, mode:"debate",
        used:`${drafts.map(x=>x.provider).join(" + ")} → Review: ${reviewer.name} → Judge: ${judge.name}`
      });
    }

    return res.status(400).json({error:"Unknown mode"});
  } catch (e) {
    console.error(e);
    res.status(500).json({error:e.message || "Server error"});
  }
});

app.listen(PORT, () => console.log(`MultiMind listening on ${PORT}`));
