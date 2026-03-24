#!/usr/bin/env node
import axios from 'axios';
import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';

config();

const CLIENT_ID = process.env.YAHOO_CLIENT_ID || '';
const CLIENT_SECRET = process.env.YAHOO_CLIENT_SECRET || '';
const REFRESH_TOKEN = process.env.YAHOO_REFRESH_TOKEN || '';

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error('YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET, and YAHOO_REFRESH_TOKEN must be set in .env');
  process.exit(1);
}

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

async function main() {
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', REFRESH_TOKEN);

  const response = await axios.post(TOKEN_URL, params.toString(), {
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  const { access_token, refresh_token } = response.data as { access_token: string; refresh_token: string };
  updateEnvFile(access_token, refresh_token);
  console.log('Token refreshed and saved to .env');
}

main().catch(err => {
  console.error('Refresh failed:', (err as Error).message);
  process.exit(1);
});
