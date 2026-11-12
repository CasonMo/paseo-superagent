import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";

function daemonAddress(): string {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  try {
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
      daemon?: { listen?: string };
    };
    return config.daemon?.listen || "127.0.0.1:6767";
  } catch {
    return "127.0.0.1:6767";
  }
}

function resolvePassword(): string | undefined {
  if (process.env.PASEO_PASSWORD) return process.env.PASEO_PASSWORD;
  try {
    const zshenv = readFileSync(join(homedir(), ".zshenv"), "utf8");
    const match = /^\s*export\s+PASEO_PASSWORD\s*=\s*(.+)\s*$/m.exec(zshenv);
    if (!match) return undefined;
    return match[1].trim().replace(/^['"]|['"]$/g, "");
  } catch {
    return undefined;
  }
}

export async function connectDaemon(): Promise<PaseoClient> {
  const client = createPaseoClient({
    url: `ws://${daemonAddress()}/ws`,
    password: resolvePassword(),
    clientId: "paseo-superagent",
  });
  await client.connect();
  return client;
}
