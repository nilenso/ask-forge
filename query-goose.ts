import { connect } from "./index.ts";

const session = await connect("https://github.com/nilenso/goose");
console.log("Connected to:", session.repo.localPath);
session.close();
