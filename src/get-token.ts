#!/usr/bin/env node
import axios from 'axios';
import { config } from 'dotenv';
import { URL } from 'url';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

config();

const CLIENT_ID = process.env.YAHOO_CLIENT_ID || '';
const CLIENT_SECRET = process.env.YAHOO_CLIENT_SECRET || '';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET must be defined in .env file');
  process.exit(1);
}

const REDIRECT_URI = 'https://localhost:8080';
const AUTH_URL = 'https://api.login.yahoo.com/oauth2/request_auth';
const TOKEN_URL = 'https://api.login.yahoo.com/oauth2/get_token';

function updateEnvFile(accessToken: string, refreshToken: string) {
  const envPath = path.resolve(process.cwd(), '.env');
  let content = fs.readFileSync(envPath, 'utf8');

  if (content.match(/^YAHOO_ACCESS_TOKEN=.*/m)) {
    content = content.replace(/^YAHOO_ACCESS_TOKEN=.*/m, `YAHOO_ACCESS_TOKEN=${accessToken}`);
  } else {
    content += `\nYAHOO_ACCESS_TOKEN=${accessToken}`;
  }

  if (content.match(/^YAHOO_REFRESH_TOKEN=.*/m)) {
    content = content.replace(/^YAHOO_REFRESH_TOKEN=.*/m, `YAHOO_REFRESH_TOKEN=${refreshToken}`);
  } else {
    content += `\nYAHOO_REFRESH_TOKEN=${refreshToken}`;
  }

  fs.writeFileSync(envPath, content);
}

async function exchangeCodeForToken(code: string): Promise<void> {
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams();
  params.append('grant_type', 'authorization_code');
  params.append('code', code);
  params.append('redirect_uri', REDIRECT_URI);

  const response = await axios.post(TOKEN_URL, params.toString(), {
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  const { access_token, refresh_token } = response.data as { access_token: string; refresh_token: string };
  updateEnvFile(access_token, refresh_token);
  console.log('\nSuccess! Tokens saved to .env');
  console.log('YAHOO_ACCESS_TOKEN and YAHOO_REFRESH_TOKEN have been populated.');
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('language', 'en-us');

  console.log('\nOpening browser for Yahoo authorization...');
  console.log('If the browser does not open, visit this URL manually:\n');
  console.log(authUrl.toString());
  console.log('\nAfter authorizing, Yahoo will redirect to https://localhost:8080?code=...');
  console.log('The page will show a connection error — that is expected.');
  console.log('Copy the full URL from the browser address bar and paste it below.\n');

  exec(`open "${authUrl.toString()}"`);

  const input = await prompt('Paste the redirect URL here: ');

  let code: string;
  try {
    const redirectUrl = new URL(input);
    const extracted = redirectUrl.searchParams.get('code');
    if (!extracted) throw new Error('No code found in URL');
    code = extracted;
  } catch {
    // Maybe they pasted just the code itself
    code = input;
  }

  console.log('\nExchanging authorization code for tokens...');
  await exchangeCodeForToken(code);
}

main().catch(err => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
