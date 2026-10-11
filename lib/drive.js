/**
 * @fileoverview Long-term memories in a Google Drive folder, through the
 * Drive API (v3) with the user's Google credentials (which need the Drive
 * scope).
 *
 * Reading: at the start of a conversation, the text of the folder's files
 * (Google Docs, Sheets, and Slides exported as text; plain text, Markdown,
 * JSON, CSV, YAML) becomes the model's memories: the memory file first, then
 * the newest files, within a size budget.
 * Writing: the save_memory tool appends a dated line to MEMORY_FILE_NAME in
 * the folder, creating the file on the first save.
 */

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
export const MEMORY_FILE_NAME = 'Gemini memories.md';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
/** Google Workspace files and the text format each is read as. */
const EXPORTS = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};
const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|x-ndjson|markdown))/;
const TEXT_NAME = /\.(md|markdown|txt|json|csv|tsv|ya?ml|xml)$/i;
const MAX_FILES = 40;
const MAX_FILE_CHARS = 8000;
const DEFAULT_BUDGET_CHARS = 30000;
const READ_CONCURRENCY = 6;
const TIMEOUT_MS = 15000;

/**
 * How to get credentials that include Drive access. `gcloud auth
 * application-default login` can't grant the Drive scope anymore ("This app
 * is blocked"); gcloud's own sign-in still can, and --update-adc also writes
 * it to the ADC file.
 */
export const DRIVE_LOGIN_HINT =
  'Run: gcloud auth login --update-adc --enable-gdrive-access, then paste ' +
  '~/.config/gcloud/application_default_credentials.json in Options.';

export class DriveError extends Error {}

/**
 * @param {string} input A Drive folder link or a bare folder ID.
 * @return {?string} The folder ID.
 */
export function parseFolderId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const match = /\/folders\/([\w-]{10,})/.exec(raw) || /[?&]id=([\w-]{10,})/.exec(raw);
  if (match) return match[1];
  return /^[\w-]{10,}$/.test(raw) ? raw : null;
}

export class DriveMemory {
  /**
   * @param {{token: string, folderId: string, quotaProject: (string|undefined)}} options
   *     `quotaProject`: billed for the Drive API calls (needs it enabled);
   *     needed with gcloud credentials.
   */
  constructor({token, folderId, quotaProject}) {
    this.token = token;
    this.folderId = folderId;
    this.quotaProject = quotaProject || '';
  }

  /** @return {!Promise<{id: string, name: string, canWrite: boolean}>} */
  async folder() {
    const file = await this.request(
      `${API}/files/${this.folderId}?fields=id,name,mimeType,capabilities(canAddChildren)&supportsAllDrives=true`,
    );
    if (file.mimeType !== FOLDER_MIME) throw new DriveError(`"${file.name}" is not a folder.`);
    return {id: file.id, name: file.name, canWrite: Boolean(file.capabilities?.canAddChildren)};
  }

  /**
   * @param {number=} budgetChars
   * @return {!Promise<{folder: !Object, text: string, files: !Array<string>}>}
   *     The memories as text, with a "### name" heading per file.
   */
  async load(budgetChars = DEFAULT_BUDGET_CHARS) {
    const folder = await this.folder();
    const files = (await this.list(`'${this.folderId}' in parents and trashed = false`))
      .filter((file) => EXPORTS[file.mimeType] || isText(file));
    // The memory file first; the rest are already newest first.
    files.sort((a, b) => Number(b.name === MEMORY_FILE_NAME) - Number(a.name === MEMORY_FILE_NAME));
    const texts = await mapLimit(files, READ_CONCURRENCY, (file) => this.read(file).catch(() => ''));

    let remaining = budgetChars;
    const sections = [];
    const used = [];
    files.forEach((file, i) => {
      const text = String(texts[i] || '').trim();
      if (!text || remaining <= 0) return;
      // The memory file keeps its newest (last) lines; others their start.
      const clipped = clip(text, Math.min(MAX_FILE_CHARS, remaining), file.name === MEMORY_FILE_NAME);
      remaining -= clipped.length;
      sections.push(`### ${file.name} (updated ${String(file.modifiedTime).slice(0, 10)})\n${clipped}`);
      used.push(file.name);
    });
    return {folder, text: sections.join('\n\n'), files: used};
  }

  /**
   * Appends a dated memory to the memory file, creating it if needed.
   * @param {string} memory
   * @param {!Date=} now
   * @return {!Promise<string>} The memory file's ID.
   */
  async append(memory, now = new Date()) {
    const line = `- ${formatDate(now)}: ${String(memory).replace(/\s+/g, ' ').trim()}\n`;
    const [existing] = await this.list(
      `name = '${MEMORY_FILE_NAME}' and '${this.folderId}' in parents and trashed = false`,
    );
    if (!existing) {
      return this.create(
        '# Gemini memories\n\nNotes Gemini saved from your conversations. Edit or delete them freely.\n\n' +
          line,
      );
    }
    const current = await this.request(`${API}/files/${existing.id}?alt=media&supportsAllDrives=true`, {
      text: true,
    });
    const separator = !current || current.endsWith('\n') ? '' : '\n';
    await this.request(`${UPLOAD_API}/files/${existing.id}?uploadType=media&supportsAllDrives=true`, {
      method: 'PATCH',
      headers: {'Content-Type': 'text/markdown; charset=UTF-8'},
      body: current + separator + line,
    });
    return existing.id;
  }

  async create(content) {
    const boundary = `gla-${crypto.randomUUID()}`;
    const metadata = {name: MEMORY_FILE_NAME, parents: [this.folderId], mimeType: 'text/markdown'};
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${content}\r\n` +
      `--${boundary}--`;
    const file = await this.request(`${UPLOAD_API}/files?uploadType=multipart&supportsAllDrives=true&fields=id`, {
      method: 'POST',
      headers: {'Content-Type': `multipart/related; boundary=${boundary}`},
      body,
    });
    return file.id;
  }

  async list(q) {
    const params = new URLSearchParams({
      q,
      orderBy: 'modifiedTime desc',
      pageSize: String(MAX_FILES),
      fields: 'files(id,name,mimeType,modifiedTime)',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    return (await this.request(`${API}/files?${params}`)).files || [];
  }

  async read(file) {
    const exportType = EXPORTS[file.mimeType];
    const url = exportType
      ? `${API}/files/${file.id}/export?mimeType=${encodeURIComponent(exportType)}`
      : `${API}/files/${file.id}?alt=media&supportsAllDrives=true`;
    return this.request(url, {text: true});
  }

  async request(url, {method = 'GET', headers = {}, body, text = false} = {}) {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(this.quotaProject ? {'x-goog-user-project': this.quotaProject} : {}),
          ...headers,
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new DriveError(`Could not reach Google Drive: ${err.message}`);
    }
    if (!response.ok) throw await toDriveError(response, this.quotaProject);
    return text ? response.text() : response.json();
  }
}

/** Turns a failed Drive API response into an actionable error. */
async function toDriveError(response, quotaProject) {
  const body = await response.json().catch(() => ({}));
  const error = body.error || {};
  const details = `${error.message || ''} ${JSON.stringify(error.errors || error.details || [])}`;
  if (response.status === 401) {
    return new DriveError('Google Drive rejected your Google credentials (expired or revoked). Update them in Options.');
  }
  if (response.status === 403 && /insufficient|SCOPE/i.test(details)) {
    return new DriveError(`Your Google credentials don't include Google Drive access. ${DRIVE_LOGIN_HINT}`);
  }
  if (response.status === 403 && /has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(details)) {
    if (!quotaProject) {
      // Billed to the OAuth client's own project (e.g. gcloud's), where Drive is off.
      return new DriveError(
        'Your Google credentials need a quota project with the Drive API on: run ' +
          'gcloud auth application-default set-quota-project YOUR_PROJECT and ' +
          'gcloud services enable drive.googleapis.com --project YOUR_PROJECT, then paste the ADC JSON again.',
      );
    }
    return new DriveError(
      `Turn on the Google Drive API for the quota project: gcloud services enable drive.googleapis.com --project ${quotaProject}`,
    );
  }
  if (response.status === 404) {
    return new DriveError("The memory folder wasn't found, or your account can't open it. Check the link and its sharing.");
  }
  return new DriveError(`Google Drive error: ${error.message || `HTTP ${response.status}`}`);
}

function isText(file) {
  return TEXT_MIME.test(file.mimeType || '') || TEXT_NAME.test(file.name || '');
}

function clip(text, maxChars, keepEnd) {
  if (text.length <= maxChars) return text;
  return keepEnd ? `…${text.slice(-(maxChars - 1))}` : `${text.slice(0, maxChars - 1)}…`;
}

function formatDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return results;
}
