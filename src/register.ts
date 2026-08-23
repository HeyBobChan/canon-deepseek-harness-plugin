#!/usr/bin/env node

import {
  registerRegistrationCli,
  runRegistrationCli,
  type RegistrationCliOptions,
} from '@canonmsg/core';

const HELP = `canon-dsh-register — register or reconnect a DeepSeek Harness agent in Canon

USAGE
  canon-dsh-register --name <name> --description <text> --phone <e164> [flags]

REQUIRED
  --name <name>              Agent display name shown in Canon
  --description <text>       Short profile description
  --phone <e164>             Owner phone number, for example +15551234567

FLAGS
  --profile <name>           Canon profile name in ~/.canon/agents.json
  --environment <id>         Canon environment ID (or CANON_ENVIRONMENT_ID)
  --base-url <url>           Canon API base URL override
  --stream-url <url>         Canon stream URL override
  --rtdb-url <url>           Canon RTDB URL override
  --firebase-api-key <key>   Firebase web API key override
  --help, -h                 Show this help
  --version, -V              Show package version

After Canon approves the registration, install this bundle into a DeepSeek
Harness profile and launch DSH with CANON_AGENT set to the Canon profile.`;

const OPTIONS: RegistrationCliOptions = {
  moduleUrl: import.meta.url,
  clientType: 'deepseek-harness',
  cliName: 'canon-dsh-register',
  hostBinName: 'dsh',
  developerInfo: 'Canon DeepSeek Harness bundle plugin',
  registeringLabel: 'DeepSeek Harness agent',
  usage: 'Usage: canon-dsh-register --name "Agent Name" --description "Description" --phone "+15551234567" [--profile "my-agent"]',
  help: HELP,
  approvedInstructions: (profileName) => [
    `Saved Canon profile: ${profileName}`,
    'Install this Canon bundle into a selected DSH profile:',
    '  dsh plugin --profile <dsh-profile> add @canonmsg/deepseek-harness-plugin',
    'From your project workspace, inspect the composed DSH profile:',
    `  CANON_AGENT=${profileName} dsh --profile <dsh-profile> --dump-config`,
    'Confirm that row id "canon-dsh" is present and enabled.',
    'Start DSH from that same workspace with:',
    `  CANON_AGENT=${profileName} dsh --profile <dsh-profile>`,
    'Canon is then available as an additional DSH surface beside the Web UI.',
  ],
};

export const REGISTRATION_CLI_OPTIONS = OPTIONS;

export async function main(): Promise<void> {
  await runRegistrationCli(OPTIONS);
}

registerRegistrationCli(OPTIONS);
