import { extractTextFromPDFFile } from "./lib/pdf-extractor.js";
const r = await extractTextFromPDFFile("./DINING_CHAIRS.pdf", { maxPages: 3 });
console.log("Pages:", r.pages, "Chars:", r.text.length);
console.log(r.text.substring(0, 300));
