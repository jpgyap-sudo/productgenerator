const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer sk-2c47d2f37e96490290077f85fef582ce"
  },
  body: JSON.stringify({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: "Return ONLY valid JSON. No markdown." },
      { role: "user", content: "Extract products from this catalog text:\n\nHA-790 chair, brand Home Atelier, wood and metal. HA-789 chair, brand Home Atelier, leather and steel." }
    ],
    response_format: { type: "json_object" }
  })
});
const d = await res.json();
console.log("Status:", res.status);
console.log("Content:", d.choices?.[0]?.message?.content);
