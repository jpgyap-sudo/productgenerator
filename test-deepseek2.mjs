import { extractTextFromPDFFile } from "./lib/pdf-extractor.js";
import { extractProductInfo } from "./lib/deepseek.js";

const r = await extractTextFromPDFFile("./DINING_CHAIRS.pdf", { maxPages: 3 });
console.log("Text length:", r.text.length);
console.log("--- TEXT ---");
console.log(r.text);
console.log("--- ANALYZING ---");
const products = await extractProductInfo(r.text);
console.log("Products found:", products.length);
console.log(JSON.stringify(products, null, 2));
