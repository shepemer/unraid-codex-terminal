#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { MediaIssueAgent } from "./agent.js";
import { redactText, redactJson } from "./redact.js";

function usage() {
  return `Usage:
  media-issue-agent serve
  media-issue-agent web
  media-issue-agent poll-once
  media-issue-agent list
  media-issue-agent investigate <snapshot-id> <index>
  media-issue-agent approve <job-id> [actor]
  media-issue-agent reject <job-id> [actor]
  media-issue-agent status`;
}

function integerArg(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const command = argv[0] || "serve";
  if (["help", "-h", "--help"].includes(command)) {
    console.log(usage());
    return 0;
  }
  const config = await loadConfig(env, {
    requireCodexAuth: command === "investigate",
    requireWebPassword: ["serve", "web"].includes(command)
  });
  const agent = new MediaIssueAgent(config);
  await agent.init();

  if (command === "serve") {
    await agent.serve();
    return 0;
  }
  if (command === "web") {
    const { startWebServer } = await import("./web.js");
    await startWebServer(agent, config);
    await new Promise(() => {});
    return 0;
  }
  if (command === "poll-once") {
    const result = await agent.pollOnce();
    console.log(result.markdown);
    return 0;
  }
  if (command === "list") {
    const snapshot = agent.latest();
    if (!snapshot) {
      console.log("No issue snapshot exists yet. Run poll-once first.");
    } else {
      console.log(snapshot.markdown);
    }
    return 0;
  }
  if (command === "investigate") {
    const snapshotId = integerArg(argv[1], "snapshot-id");
    const index = integerArg(argv[2], "index");
    const result = await agent.investigate(snapshotId, index);
    console.log(result.summary);
    console.log("");
    console.log(`Job: ${result.jobId}`);
    console.log(`Approval: ${result.approvalId}`);
    return 0;
  }
  if (command === "approve") {
    const jobId = integerArg(argv[1], "job-id");
    const actor = argv[2] || "operator";
    console.log(redactJson(agent.approve(jobId, actor)));
    return 0;
  }
  if (command === "reject") {
    const jobId = integerArg(argv[1], "job-id");
    const actor = argv[2] || "operator";
    console.log(redactJson(agent.reject(jobId, actor)));
    return 0;
  }
  if (command === "status") {
    console.log(redactJson(agent.status()));
    return 0;
  }
  throw new Error(`Unknown command: ${command}\n${usage()}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(redactText(error.stack || error.message));
    process.exit(1);
  });
}
