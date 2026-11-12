# Superagent

Superagent is a resident super agent plugin for Paseo. It connects message sources, routes events through a shared judge, manages tickets and execution agents, and brings approvals and results back to the main chat and WeCom.

## Install

Install directly from Git:

```sh
paseo plugin add git:CasonMo/paseo-superagent
```

For local development:

```sh
npm install
npm run typecheck
npm test
```

## Configuration

Open the Superagent screen from the Paseo sidebar. Use the settings dialog to choose provider and model settings for the main agent, judge, and execution agents. WeCom is optional; configure a WeCom AI bot Bot ID and Secret to enable notifications and replies.

Message sources are scripts that emit NDJSON. Ask Superagent to add a source, confirm the source checklist, test the script, and approve it before enabling it.

## Documentation

The listing overview is in [OVERVIEW.md](OVERVIEW.md), with a Simplified Chinese translation in [OVERVIEW.zh-CN.md](OVERVIEW.zh-CN.md).
