const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const built = path.join(root, "dist", "index.js");
assert.ok(fs.existsSync(built), "dist/index.js should exist after build");

const fixture = require(built);
const text = fixture.message();
assert.match(text, /unpriv npm fixture/);
console.log(text);
