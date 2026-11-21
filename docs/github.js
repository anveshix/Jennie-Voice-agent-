/**
 * Read public GitHub repositories from the phone — no clone, no npm, no terminal.
 *
 * This is the honest version of "install git repositories": a browser cannot
 * clone, build or install anything, but it *can* read the public GitHub API.
 * That is enough to inspect how another project solved a problem, pull a single
 * file, or answer "is this library still maintained?".
 *
 * Everything goes through api.github.com (unauthenticated, ~60 requests/hour).
 * Only public data is requested; nothing from the user's GitHub account is used.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JENNI_GITHUB = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const API = 'https://api.github.com';
  const MAX_FILE_CHARS = 6000;

  /** "anveshix/Jenni-Voice-agent-" or a URL → { owner, repo } */
  function parseRepo(text) {
    const value = String(text || '').trim();
    const url = value.match(/(?:https?:\/\/)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i);
    if (url) return { owner: url[1], repo: url[2].replace(/\.git$/, '') };
    const pair = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (pair) return { owner: pair[1], repo: pair[2] };
    return null;
  }

  /** Does this message want repository code read? */
  function looksLikeRepoRequest(text) {
    const value = String(text || '');
    if (!value || value.length > 400) return false;
    const mentionsRepo = /github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/i.test(value)
      || /\b[a-z0-9][a-z0-9-]{1,30}\/[a-z0-9][a-z0-9._-]{1,40}\b/i.test(value);
    const wantsCode = /\b(repo|repository|github|source code|code dekho|code padho|install|clone|khol ke dekho|kitne stars|maintained|library|package)\b/i.test(value);
    return mentionsRepo && wantsCode;
  }

  async function getJson(url, fetchImpl) {
    const response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json' } });
    if (response.status === 403 || response.status === 429) {
      throw new Error('GitHub ki free limit lag gayi (60 requests/hour). Thodi der baad try karo.');
    }
    if (response.status === 404) throw new Error('Ye repo public nahi mila — naam check karo.');
    if (!response.ok) throw new Error(`GitHub ne HTTP ${response.status} diya.`);
    return response.json();
  }

  /**
   * Read a repo: metadata, the README, and the top-level files.
   * Returns a compact text block safe to put in a prompt (no huge payloads).
   */
  async function readRepo(slug, options = {}) {
    const fetchImpl = options.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    if (!fetchImpl) throw new Error('Is browser me fetch nahi hai.');
    const parsed = parseRepo(slug);
    if (!parsed) throw new Error('Repo ka naam "owner/repo" jaisa do.');
    const { owner, repo } = parsed;
    const base = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

    const meta = await getJson(base, fetchImpl);
    let readme = '';
    try {
      const file = await getJson(`${base}/readme`, fetchImpl);
      if (file && file.content) readme = decodeBase64(file.content).slice(0, MAX_FILE_CHARS);
    } catch (error) { /* a repo can have no README */ }

    let tree = [];
    try {
      const listing = await getJson(`${base}/contents/`, fetchImpl);
      tree = (Array.isArray(listing) ? listing : [])
        .slice(0, 40)
        .map((entry) => `${entry.type === 'dir' ? 'dir ' : 'file'} ${entry.name}`);
    } catch (error) { /* empty repo */ }

    return {
      owner, repo,
      fullName: meta.full_name,
      description: meta.description || '',
      stars: meta.stargazers_count,
      language: meta.language,
      archived: Boolean(meta.archived),
      pushedAt: meta.pushed_at,
      license: meta.license && meta.license.spdx_id,
      openIssues: meta.open_issues_count,
      defaultBranch: meta.default_branch,
      readme,
      tree,
      apiBlock: [
        `Repo: ${meta.full_name}`,
        meta.description ? `About: ${meta.description}` : '',
        `Stars: ${meta.stargazers_count} · Language: ${meta.language || 'n/a'} · License: ${(meta.license && meta.license.spdx_id) || 'n/a'}`,
        `Last push: ${meta.pushed_at}${meta.archived ? ' · ARCHIVED' : ''}`,
        tree.length ? `Top level:\n${tree.join('\n')}` : '',
        readme ? `README (trimmed):\n${readme}` : 'README: none'
      ].filter(Boolean).join('\n')
    };
  }

  function decodeBase64(text) {
    const clean = String(text).replace(/\s/g, '');
    if (typeof atob === 'function') {
      const binary = atob(clean);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }
    return Buffer.from(clean, 'base64').toString('utf8');
  }

  return { parseRepo, looksLikeRepoRequest, readRepo, decodeBase64, API };
});
