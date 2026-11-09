import { test, expect } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";

test("health returns ok", async () => {
    const res = await request(buildApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 
        status: "ok",
        timestamp: expect.any(String)});
});
