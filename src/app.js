//builds app defines endpoints

//express

import express from "express";

export function buildApp() {
    const app = express();


    app.get("/health", (req, res) => {
        res.json({ status: "ok" });
    });

    return app;
}

