import { ask, connect } from "./index.ts";

const repo = await connect("https://github.com/nilenso/goose");
console.log("Connected to:", repo.localPath);
