
import { buildApp } from "./app.js";

const app = buildApp();
app.listen(3000, () => {
    console.log("Listening on http://127.0.0.1:3000");
});