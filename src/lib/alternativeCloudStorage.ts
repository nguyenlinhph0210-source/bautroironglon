/**
 * Alternative Cloud & Database Hub
 * Provides resilient, non-Firestore storage engines:
 * 1. Firebase Realtime Database (RTDB) - Unlimited daily writes, 0 Firestore quota impact, works on GitHub Pages
 * 2. GitHub Gist as a Database - 100% free, versioned, zero server, global CDN read
 * 3. Static Bundled Repo Data - Fetches directly from public/data/*.json on GitHub Pages
 */

import {
  getDatabase,
  ref as rtdbRef,
  set as rtdbSet,
  get as rtdbGet,
  onValue as rtdbOnValue,
  remove as rtdbRemove,
  type Database,
} from 'firebase/database';
import { initializeApp, getApps, getApp } from 'firebase/app';
import firebaseConfig from '../../firebase-applet-config.json';
import { Story, Chapter, Announcement } from '../types';

// ============================================================================
// 1. FIREBASE REALTIME DATABASE (RTDB) ADAPTER
// ============================================================================

const env = (typeof import.meta !== 'undefined' && (import.meta as any).env) || {};
const resolvedFirebaseConfig = {
  projectId: env.VITE_FIREBASE_PROJECT_ID || firebaseConfig?.projectId,
  appId: env.VITE_FIREBASE_APP_ID || firebaseConfig?.appId,
  apiKey: env.VITE_FIREBASE_API_KEY || firebaseConfig?.apiKey,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || firebaseConfig?.authDomain,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || firebaseConfig?.storageBucket,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || firebaseConfig?.messagingSenderId,
};

const app = !getApps().length ? initializeApp(resolvedFirebaseConfig) : getApp();

export const getCustomRtdbUrl = (): string => {
  if (typeof window === 'undefined') return '';
  try {
    const saved = localStorage.getItem('mel_rtdb_database_url');
    if (saved && saved.trim().startsWith('http')) {
      return saved.trim().replace(/\/+$/, '');
    }
  } catch {}
  const envUrl = env.VITE_FIREBASE_DATABASE_URL;
  if (envUrl && typeof envUrl === 'string' && envUrl.startsWith('http')) {
    return envUrl.trim().replace(/\/+$/, '');
  }
  if (resolvedFirebaseConfig.projectId) {
    // Default standard Southeast Asia or US RTDB domain pattern
    return `https://${resolvedFirebaseConfig.projectId}-default-rtdb.asia-southeast1.firebasedatabase.app`;
  }
  return '';
};

export const saveCustomRtdbUrl = (url: string) => {
  if (typeof window === 'undefined') return;
  if (url && url.trim().startsWith('http')) {
    localStorage.setItem('mel_rtdb_database_url', url.trim());
    localStorage.setItem('mel_rtdb_enabled', 'true');
  } else {
    localStorage.removeItem('mel_rtdb_database_url');
  }
  _rtdbCache = null;
  window.dispatchEvent(new CustomEvent('cloud_storage_changed'));
};

export const isRtdbEnabled = (): boolean => {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem('mel_rtdb_enabled') === 'true';
};

export const setRtdbEnabled = (enabled: boolean) => {
  if (typeof window === 'undefined') return;
  if (enabled) {
    localStorage.setItem('mel_rtdb_enabled', 'true');
  } else {
    localStorage.removeItem('mel_rtdb_enabled');
  }
  window.dispatchEvent(new CustomEvent('cloud_storage_changed'));
};

let _rtdbCache: Database | null = null;
export const getRtdbClient = (): Database | null => {
  if (_rtdbCache) return _rtdbCache;
  try {
    const url = getCustomRtdbUrl();
    if (url) {
      _rtdbCache = getDatabase(app, url);
    } else {
      _rtdbCache = getDatabase(app);
    }
    return _rtdbCache;
  } catch (err) {
    console.warn('Firebase RTDB client initialization note:', err);
    return null;
  }
};

export const testRtdbConnection = async (testUrl?: string): Promise<{ success: boolean; message: string }> => {
  try {
    const targetUrl = testUrl || getCustomRtdbUrl();
    if (!targetUrl) {
      return { success: false, message: 'Chưa cấu hình đường dẫn Realtime Database URL.' };
    }
    const dbInstance = getDatabase(app, targetUrl);
    const pingRef = rtdbRef(dbInstance, 'ping');
    await rtdbSet(pingRef, { timestamp: Date.now(), client: 'Mellifluous' });
    return { success: true, message: 'Kết nối Firebase Realtime Database thành công! Ghi nhận đọc/ghi hoạt động tốt.' };
  } catch (err: any) {
    return {
      success: false,
      message: `Lỗi kết nối Realtime Database: ${err?.message || 'Vui lòng kiểm tra lại URL hoặc Rules (cần đặt .read: true, .write: true)'}`,
    };
  }
};

// ============================================================================
// 2. GITHUB GIST DATABASE ADAPTER (100% Free, Git-backed)
// ============================================================================

export interface GitHubStorageConfig {
  enabled: boolean;
  token: string; // Personal Access Token with gist permission
  gistId: string; // The ID of the Gist (e.g. abc123def456)
  filename?: string;
}

export const getGitHubStorageConfig = (): GitHubStorageConfig => {
  if (typeof window === 'undefined') {
    return { enabled: false, token: '', gistId: '', filename: 'mellifluous_db.json' };
  }
  return {
    enabled: localStorage.getItem('mel_gh_enabled') === 'true',
    token: localStorage.getItem('mel_gh_token') || '',
    gistId: localStorage.getItem('mel_gh_gist_id') || '',
    filename: localStorage.getItem('mel_gh_filename') || 'mellifluous_db.json',
  };
};

export const saveGitHubStorageConfig = (config: Partial<GitHubStorageConfig>) => {
  if (typeof window === 'undefined') return;
  if (config.enabled !== undefined) {
    if (config.enabled) localStorage.setItem('mel_gh_enabled', 'true');
    else localStorage.removeItem('mel_gh_enabled');
  }
  if (config.token !== undefined) {
    localStorage.setItem('mel_gh_token', config.token.trim());
  }
  if (config.gistId !== undefined) {
    localStorage.setItem('mel_gh_gist_id', config.gistId.trim());
  }
  if (config.filename !== undefined) {
    localStorage.setItem('mel_gh_filename', config.filename.trim());
  }
  window.dispatchEvent(new CustomEvent('cloud_storage_changed'));
};

/**
 * Fetch authoritative database directly from GitHub Gist
 */
export const fetchFromGitHubGist = async (): Promise<any | null> => {
  const config = getGitHubStorageConfig();
  if (!config.gistId) return null;

  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
    };
    if (config.token) {
      headers['Authorization'] = `token ${config.token}`;
    }

    const res = await fetch(`https://api.github.com/gists/${encodeURIComponent(config.gistId)}`, {
      headers,
    });
    if (!res.ok) return null;

    const gist = await res.json();
    const filename = config.filename || 'mellifluous_db.json';
    const targetFile = gist.files?.[filename] || Object.values(gist.files || {})[0];
    if (targetFile && (targetFile as any).content) {
      return JSON.parse((targetFile as any).content);
    }
    return null;
  } catch (err) {
    console.warn('Fetch from GitHub Gist warning:', err);
    return null;
  }
};

/**
 * Save authoritative database directly to GitHub Gist
 */
export const saveToGitHubGist = async (data: any): Promise<boolean> => {
  const config = getGitHubStorageConfig();
  if (!config.token || !config.gistId) {
    return false;
  }

  try {
    const filename = config.filename || 'mellifluous_db.json';
    const body = {
      description: 'Mellifluous Database - Auto updated',
      files: {
        [filename]: {
          content: JSON.stringify(data, null, 2),
        },
      },
    };

    const res = await fetch(`https://api.github.com/gists/${encodeURIComponent(config.gistId)}`, {
      method: 'PATCH',
      headers: {
        Accept: 'application/vnd.github.v3+json',
        Authorization: `token ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    return res.ok;
  } catch (err) {
    console.error('Save to GitHub Gist error:', err);
    return false;
  }
};

/**
 * Create a new GitHub Gist for the database with one click
 */
export const createGitHubGistDatabase = async (token: string, initialData: any): Promise<{ success: boolean; gistId?: string; message: string }> => {
  if (!token) return { success: false, message: 'Cần có GitHub Personal Access Token.' };
  try {
    const filename = 'mellifluous_db.json';
    const body = {
      description: 'Mellifluous Story Database (Free Unlimited Cloud Storage)',
      public: true,
      files: {
        [filename]: {
          content: JSON.stringify(initialData || {}, null, 2),
        },
      },
    };

    const res = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github.v3+json',
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      return { success: false, message: errJson.message || `Lỗi GitHub API: ${res.status}` };
    }

    const created = await res.json();
    return { success: true, gistId: created.id, message: `Tạo GitHub Gist thành công! Mã Gist: ${created.id}` };
  } catch (err: any) {
    return { success: false, message: err?.message || 'Lỗi mạng khi gọi GitHub API.' };
  }
};

// ============================================================================
// 3. STATIC BUNDLED REPO DATA ADAPTER (Zero Config, 100% Reliable on GitHub Pages)
// ============================================================================

/**
 * Resolves static asset paths respecting Vite's base URL (e.g. /bautroironglon/)
 */
export const getBaseAssetUrl = (relativePath: string): string => {
  const base = (typeof import.meta !== 'undefined' && (import.meta as any).env?.BASE_URL) || '/';
  const cleanBase = base.endsWith('/') ? base : `${base}/`;
  const cleanRel = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
  return `${cleanBase}${cleanRel}`;
};

/**
 * Fetches static bundled stories from repository public/data/
 */
export const fetchStaticBundledStories = async (): Promise<Story[] | null> => {
  try {
    const url = getBaseAssetUrl('data/stories.json');
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        return data;
      }
    }
  } catch (err) {
    console.debug('Static bundled stories fetch note:', err);
  }
  return null;
};

/**
 * Fetches static bundled chapters from repository public/data/
 */
export const fetchStaticBundledChapters = async (): Promise<Record<string, Chapter[]> | null> => {
  try {
    const url = getBaseAssetUrl('data/chapters.json');
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        return data;
      }
    }
  } catch (err) {
    console.debug('Static bundled chapters fetch note:', err);
  }
  return null;
};

/**
 * Fetches static bundled announcements from repository public/data/
 */
export const fetchStaticBundledAnnouncements = async (): Promise<Announcement[] | null> => {
  try {
    const url = getBaseAssetUrl('data/announcements.json');
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        return data;
      }
    }
  } catch (err) {
    console.debug('Static bundled announcements fetch note:', err);
  }
  return null;
};
