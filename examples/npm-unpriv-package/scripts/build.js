const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "src", "index.js");
const outputDir = path.join(root, "dist");
const output = path.join(outputDir, "index.js");

fs.mkdirSync(outputDir, { recursive: true });
fs.copyFileSync(source, output);
console.log(`built ${path.relative(root, output)}`);
