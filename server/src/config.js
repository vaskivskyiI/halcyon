import path from 'node:path';
import fs from 'node:fs';

const env = process.env;
const dataDir = path.resolve(env.HALCYON_DATA_DIR || path.join(process.cwd(), 'data'));
fs.mkdirSync(dataDir, { recursive: true });

export const config = {
  host: env.HALCYON_HOST || '0.0.0.0',
  port: Number(env.HALCYON_PORT || 8080),
  dataDir,
  dbPath: path.join(dataDir, 'halcyon.db'),
  mailStoreDir: path.join(dataDir, 'mail'),
  webDir: path.resolve(env.HALCYON_WEB_DIR || path.join(import.meta.dirname, '../../web/dist')),
  publicUrl: (env.HALCYON_PUBLIC_URL || '').replace(/\/$/, ''),
  // Single-user mode is used by the desktop app: requests from loopback are auto-authenticated.
  singleUser: env.HALCYON_SINGLE_USER === '1',
  // When set (desktop app), single-user requests must also present this secret cookie/header.
  desktopToken: env.HALCYON_DESKTOP_TOKEN || '',
  secureCookies: env.HALCYON_SECURE_COOKIES === '1',
  // Only honour X-Forwarded-* from these proxy addresses (nginx on the same host by default).
  trustProxy: env.HALCYON_TRUST_PROXY ? (env.HALCYON_TRUST_PROXY === 'true' ? true : env.HALCYON_TRUST_PROXY.split(',')) : ['127.0.0.1', '::1'],
  allowSignup: env.HALCYON_ALLOW_SIGNUP === '1',
  // Initial sync window: how far back to download mail on first sync of a folder.
  initialSyncDays: Number(env.HALCYON_INITIAL_SYNC_DAYS || 90),
  maxMessagesPerFolderInitial: Number(env.HALCYON_MAX_INITIAL || 2000),
  pollIntervalSec: Number(env.HALCYON_POLL_INTERVAL || 120),
  undoSendSeconds: Number(env.HALCYON_UNDO_SEND || 10),
  oauth: {
    google: { clientId: env.GOOGLE_CLIENT_ID || '', clientSecret: env.GOOGLE_CLIENT_SECRET || '' },
    microsoft: { clientId: env.MICROSOFT_CLIENT_ID || '', clientSecret: env.MICROSOFT_CLIENT_SECRET || '', tenant: env.MICROSOFT_TENANT || 'common' },
  },
  // The Android app (android/README.md): its package and signing-key fingerprint(s), published in assetlinks.json so
  // Android opens the app without a browser bar.
  android: { package: env.HALCYON_ANDROID_PACKAGE || '', sha256: (env.HALCYON_ANDROID_SHA256 || '').split(/[\s,]+/).filter(Boolean) },
  logLevel: env.HALCYON_LOG_LEVEL || 'info',
};
fs.mkdirSync(config.mailStoreDir, { recursive: true });
