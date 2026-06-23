import express from "express";
import cors from "cors";
import { App } from "@slack/bolt";
import { debugIssue } from "./services/aiService.js";
import dotenv from "dotenv";
dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const slackApp = new App({
  token: process.env.SLACK_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

slackApp.event("app_mention", async ({ event, client }) => {
  const issue = event.text;

  const result = await debugIssue(issue);
  await client.chat.postMessage({
    channel: event.channel,

    thread_ts: event.ts,

    text: result,
  });
});
slackApp.start();

console.log("Bot running");
app.post("/analyze", async (req, res) => {
  const issue = req.body.issue;
  const result = await debugIssue(issue);
  res.json({
    analysis: result,
  });
});

app.listen(5001);
