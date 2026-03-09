const STYLE_PROMPTS = {
  casual: "Use a casual, friendly, conversational tone",
  polite: "Use a polite, respectful, and formal tone",
  business: "Use a formal, professional business tone",
};

const LANG_NAMES = {
  english: "English",
  japanese: "Japanese",
  vietnamese: "Vietnamese",
  chinese: "Chinese",
  korean: "Korean",
  french: "French",
  german: "German",
  spanish: "Spanish",
  portuguese: "Portuguese",
  russian: "Russian",
  thai: "Thai",
  indonesian: "Indonesian",
  italian: "Italian",
  dutch: "Dutch",
  arabic: "Arabic",
  hindi: "Hindi",
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "translate") {
    handleTranslate(request.text, request.sourceLang, request.targetLang, request.style)
      .then((translation) => sendResponse({ success: true, translation }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // keep channel open for async response
  }
});

async function handleTranslate(text, sourceLang, targetLang, style) {
  const data = await chrome.storage.sync.get(["apiKey"]);
  if (!data.apiKey) {
    throw new Error("No API key set. Click the extension icon to configure.");
  }

  const styleInstruction = STYLE_PROMPTS[style] || STYLE_PROMPTS.casual;
  const source = LANG_NAMES[sourceLang] || sourceLang;
  const target = LANG_NAMES[targetLang] || targetLang;

  const systemPrompt = `You are a translator. Translate the following text from ${source} to ${target}.\n${styleInstruction}.\nReturn ONLY the translated text, no explanations or extra formatting.`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${data.apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      temperature: 0.3,
      max_tokens: 1024,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error: ${response.status}`);
  }

  const result = await response.json();
  return result.choices[0].message.content.trim();
}
