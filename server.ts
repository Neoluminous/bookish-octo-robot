import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION, validateDraft } from './assessment-schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data-dev'));
const PAYMENTS_DIR = path.join(DATA_DIR, 'payments');
const ACCESS_DIR = path.join(DATA_DIR, 'access');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const ADMIN_SESSIONS_DIR = path.join(DATA_DIR, 'admin_sessions');
const ORDERS_DIR = path.join(DATA_DIR, 'orders');
const SETTINGS_FILE = path.join(DATA_DIR, 'payment-settings.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const SITE_DIR = path.join(__dirname, 'site');

// Ensure storage directories exist
for (const dir of [DATA_DIR, PAYMENTS_DIR, ACCESS_DIR, SESSIONS_DIR, ADMIN_SESSIONS_DIR, ORDERS_DIR, UPLOADS_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

// Helpers
function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function jsonRead<T = any>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function jsonWriteAtomic(filePath: string, record: any): boolean {
  const tempFile = path.join(path.dirname(filePath), `.write-${crypto.randomBytes(6).toString('hex')}`);
  try {
    fs.writeFileSync(tempFile, JSON.stringify(record, null, 2), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tempFile, filePath);
    return true;
  } catch (err) {
    try { fs.unlinkSync(tempFile); } catch {}
    console.error('Failed to write application data.');
    return false;
  }
}

function cleanText(value: any, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function validId(value: any): string {
  return typeof value === 'string' && /^[a-f0-9]{32,40}$/.test(value) ? value : '';
}

function safeEqual(a: string, b: string): boolean {
  const first = Buffer.from(hashToken(a));
  const second = Buffer.from(hashToken(b));
  return crypto.timingSafeEqual(first, second);
}

function csrfOk(req: Request): boolean {
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) return false;
    } catch { return false; }
  }
  const cookie = cleanText(req.cookies['ngo_compass_csrf'], 128);
  const provided = cleanText(req.get('x-csrf-token') || req.body?.csrf, 128);
  return Boolean(cookie && provided && safeEqual(cookie, provided));
}

function adminCsrfOk(req: Request): boolean {
  const origin = req.get('origin');
  if (origin) {
    try { if (new URL(origin).host !== req.get('host')) return false; }
    catch { return false; }
  }
  const cookie = cleanText(req.cookies['ngo_compass_admin_csrf'], 128);
  const provided = cleanText(req.get('x-csrf-token') || req.body?.csrf, 128);
  return Boolean(cookie && provided && safeEqual(cookie, provided));
}

function proofFromData(value: any): { file: string; type: string; size: number } | null {
  if (!value || typeof value !== 'object' || typeof value.data !== 'string') return null;
  const match = /^data:(application\/pdf|image\/jpeg|image\/png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value.data);
  if (!match || match[2].length > 7_000_000) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 5_000_000) return null;
  const type = match[1];
  const valid = type === 'application/pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' :
    type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  if (!valid) return null;
  const extension = type === 'application/pdf' ? 'pdf' : type === 'image/png' ? 'png' : 'jpg';
  const file = `${crypto.randomBytes(20).toString('hex')}.${extension}`;
  try { fs.writeFileSync(path.join(UPLOADS_DIR, file), bytes, { flag: 'wx', mode: 0o600 }); }
  catch { return null; }
  return { file, type, size: bytes.length };
}

function sendProtectedFile(res: Response, record: any): Response {
  if (!record || typeof record.file !== 'string' || !/^[a-f0-9]{40}\.(pdf|png|jpg)$/.test(record.file)) return res.status(404).send('File unavailable.');
  const file = path.join(UPLOADS_DIR, record.file);
  if (!fs.existsSync(file)) return res.status(404).send('File unavailable.');
  res.setHeader('Content-Type', record.type);
  res.setHeader('Content-Disposition', `attachment; filename="${record.file}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(file);
  return res;
}

function paymentSettings(): {
  payeeName: string;
  upiId: string;
  upiPhone: string;
  qrDataUrl: string;
  upiUri: string;
  available: boolean;
  orderReference?: string;
} {
  const record = jsonRead<any>(SETTINGS_FILE) || {};
  const payeeName = cleanText(record.payeeName, 160);
  const upiId = cleanText(record.upiId, 160);
  const upiPhone = cleanText(record.upiPhone, 40);
  const qrDataUrl = cleanText(record.qrDataUrl, 2000000);
  return {
    payeeName,
    upiId,
    upiPhone,
    qrDataUrl,
    upiUri: payeeName && upiId ? `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName)}&am=1999&cu=INR` : '',
    available: payeeName !== '' && (upiId !== '' || qrDataUrl !== ''),
  };
}

// Read questions
let questionsData: any[] = [];
try {
  const qPath = path.join(SITE_DIR, 'questions.json');
  if (fs.existsSync(qPath)) {
    questionsData = JSON.parse(fs.readFileSync(qPath, 'utf-8'));
  }
} catch (err) {
  console.error('Failed to load questions.json', err);
}

function setAppCookie(res: Response, req: Request, name: string, value: string, maxAgeMs: number, httpOnly = true) {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https' || req.headers['x-forwarded-ssl'] === 'on';
  res.cookie(name, value, {
    maxAge: maxAgeMs,
    path: '/',
    httpOnly,
    sameSite: 'lax',
    secure: isHttps,
  } as any);
}

function sessionPaymentId(req: Request): string {
  const token = cleanText(req.cookies['ngo_compass_access'], 128);

  if (!token || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) return '';
  const sessionFile = path.join(SESSIONS_DIR, `session-${hashToken(token)}.json`);
  const record = jsonRead<any>(sessionFile);
  if (!record || record.version !== 2 || !record.expiresAt || new Date(record.expiresAt).getTime() <= Date.now()) {
    return '';
  }
  return cleanText(record.paymentId, 64);
}

function isAdminLoggedIn(req: Request): boolean {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return false;
  const sessionToken = cleanText(req.cookies['ngo_compass_admin_session'], 128);

  if (!sessionToken || !/^[A-Za-z0-9_-]{16,128}$/.test(sessionToken)) {
    return false;
  }
  const sessionFile = path.join(ADMIN_SESSIONS_DIR, `admin-session-${hashToken(sessionToken)}.json`);
  const record = jsonRead<any>(sessionFile);
  if (!record || record.version !== 2 || !record.expiresAt || new Date(record.expiresAt).getTime() <= Date.now()) {
    return false;
  }
  return true;
}

function createAdminSession(res: Response, req: Request): string {
  const session = randomToken(32);
  const now = Date.now();
  const sessionRecord = {
    version: 2,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 8 * 3600 * 1000).toISOString(),
  };
  jsonWriteAtomic(path.join(ADMIN_SESSIONS_DIR, `admin-session-${hashToken(session)}.json`), sessionRecord);
  setAppCookie(res, req, 'ngo_compass_admin_session', session, 8 * 3600 * 1000, true);
  return session;
}

function destroyAdminSession(req: Request, res: Response): void {
  const sessionToken = req.cookies['ngo_compass_admin_session'];
  if (sessionToken) {
    const sessionFile = path.join(ADMIN_SESSIONS_DIR, `admin-session-${hashToken(sessionToken)}.json`);
    try {
      if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
    } catch {}
  }
  res.clearCookie('ngo_compass_admin_session', { path: '/' });
}

function readPayments(): any[] {
  const records: any[] = [];
  try {
    const files = fs.readdirSync(PAYMENTS_DIR);
    for (const file of files) {
      if (file.startsWith('payment-') && file.endsWith('.json')) {
        const item = jsonRead(path.join(PAYMENTS_DIR, file));
        if (item) records.push(item);
      }
    }
  } catch {}
  return records.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

function readAssessments(): any[] {
  const records: any[] = [];
  try {
    const files = fs.readdirSync(DATA_DIR);
    for (const file of files) {
      if (file.startsWith('assessment-') && file.endsWith('.json')) {
        const item = jsonRead(path.join(DATA_DIR, file));
        if (item && item.profile && item.answers) records.push(item);
      }
    }
  } catch {}
  return records.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

function escapeHtml(value: any): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return c;
    }
  });
}

function answerLabel(answer: any): string {
  switch (answer) {
    case 'yes': return 'Yes';
    case 'no': return 'No';
    case 'not_sure': return 'Unsure';
    case 'not_applicable': return 'Not applicable';
    default: return 'Not answered';
  }
}

function getBaseUrl(req: Request): string {
  const proto = req.secure ? 'https' : 'http';
  const host = String(req.headers.host || `localhost:${PORT}`);
  return `${proto}://${host}`;
}

function redeemAccess(req: Request, res: Response, token: string) {
  if (!/^[A-Za-z0-9_-]{30,128}$/.test(token)) return res.redirect('/FundingReady/payment/?access=invalid');
  const tokenPath = path.join(ACCESS_DIR, `token-${hashToken(token)}.json`);
  const record = jsonRead<any>(tokenPath);
  const paymentId = validId(record?.paymentId);
  const payment = paymentId && jsonRead<any>(path.join(PAYMENTS_DIR, `payment-${paymentId}.json`));
  if (!record || record.version !== 2 || record.usedAt || record.revokedAt || !payment || payment.status !== 'verified' || new Date(record.expiresAt).getTime() <= Date.now()) {
    return res.redirect('/FundingReady/payment/?access=invalid');
  }
  // Renaming the source is atomic: only one simultaneous redemption can remove it.
  try { fs.renameSync(tokenPath, `${tokenPath}.used`); }
  catch { return res.redirect('/FundingReady/payment/?access=invalid'); }
  const session = randomToken(32);
  const now = Date.now();
  const sessionRecord = { version: 2, paymentId, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 86400_000).toISOString() };
  if (!jsonWriteAtomic(path.join(SESSIONS_DIR, `session-${hashToken(session)}.json`), sessionRecord)) return res.status(500).send('Access could not be activated. Contact support.');
  setAppCookie(res, req, 'ngo_compass_access', session, 30 * 86400_000);
  setAppCookie(res, req, 'ngo_compass_csrf', randomToken(24), 86400_000, false);
  return res.redirect('/FundingReady/assessment/');
}

function revokeAccessLinks(paymentId: string) {
  for (const file of fs.readdirSync(ACCESS_DIR)) {
    if (!/^token-[a-f0-9]{64}\.json$/.test(file)) continue;
    const filename = path.join(ACCESS_DIR, file);
    const record = jsonRead<any>(filename);
    if (record?.paymentId === paymentId && !record.usedAt) {
      record.revokedAt = new Date().toISOString();
      jsonWriteAtomic(filename, record);
    }
  }
}

const app = express();
const loginFailures = new Map<string, { count: number; until: number }>();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); next(); });
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Handle API requests
function handleApiGet(req: Request, res: Response) {
  const action = req.path.endsWith('/assessments/bootstrap') || req.path.endsWith('/payments') ? 'bootstrap' : req.path.endsWith('/assessments/access') ? 'access' : /^\/(?:FundingReady\/)?api\/assessments\/[a-f0-9]{32,40}$/.test(req.path) ? 'load' : cleanText(req.query.action, 40);

  if (action === 'bootstrap') {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randPart = crypto.randomBytes(6).toString('hex').slice(0, 10).toUpperCase();
    const reference = `NGR-${dateStr}-${randPart}`;
    const orderRecord = {
      reference,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400 * 1000).toISOString(),
      paymentId: '',
    };
    jsonWriteAtomic(path.join(ORDERS_DIR, `order-${reference}.json`), orderRecord);

    let csrf = req.cookies['ngo_compass_csrf'];
    if (!csrf || typeof csrf !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(csrf)) {
      csrf = randomToken(24);
      setAppCookie(res, req, 'ngo_compass_csrf', csrf, 86400 * 1000, false);
    }

    const settings = paymentSettings();
    const paymentId = sessionPaymentId(req);
    return res.json({
      status: 'ok',
      ok: true,
      settings: { ...settings, orderReference: reference },
      csrfToken: csrf,
      csrf: csrf,
      hasAccess: Boolean(paymentId),
      access: Boolean(paymentId),
      paymentId: paymentId || '',
      orderReference: reference,
      reviewerEmail: cleanText(process.env.REVIEWER_EMAIL, 160),
    });
  }

  if (action === 'access') {
    const paymentId = sessionPaymentId(req);
    if (paymentId) {
      let csrf = req.cookies['ngo_compass_csrf'];
      if (!csrf || typeof csrf !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(csrf)) {
        csrf = randomToken(24);
        setAppCookie(res, req, 'ngo_compass_csrf', csrf, 86400 * 1000, false);
      }
      return res.json({ ok: true, access: true, paymentId, csrfToken: csrf, csrf });
    }
    return res.status(403).json({ error: 'Assessment access is not active.' });
  }

  if (action === 'exchange') {
    return redeemAccess(req, res, cleanText(req.query.token, 128));
  }

  if (action === 'load') {
    const id = validId(req.params.id || req.query.id);
    const filePath = path.join(DATA_DIR, `assessment-${id}.json`);
    const record = jsonRead<any>(filePath);
    if (
      !record || record.paymentId !== sessionPaymentId(req)
    ) {
      return res.status(404).json({ error: 'Assessment not found.' });
    }
    const { keyHash, respondentKey, paymentId: _, ...safeAssessment } = record;
    const payment = jsonRead<any>(path.join(PAYMENTS_DIR, `payment-${record.paymentId}.json`));
    return res.json({ assessment: safeAssessment, receipt: record.completed ? { reference: payment?.orderReference || '', submittedAt: payment?.submittedAt || record.updatedAt, reviewStatus: payment?.reviewStatus || 'submitted', reportReady: Boolean(payment?.report?.file), reviewerScore: payment?.reviewerScore ?? null } : null });
  }

  return res.status(400).json({ error: 'Invalid action.' });
}

function handleApiPost(req: Request, res: Response) {
  const payload = req.body || {};
  const action = cleanText(payload.action, 40);
  if (!csrfOk(req)) return res.status(403).json({ error: 'Invalid or missing CSRF token.' });

  if (action === 'payment') {
    if (!paymentSettings().available) return res.status(503).json({ error: 'Payments are not configured. Please contact support.' });
    const profile = {
      respondentName: cleanText(payload.respondentName, 120),
      ngoName: cleanText(payload.ngoName, 160),
      email: cleanText(payload.email, 160).toLowerCase(),
      phoneNumber: cleanText(payload.phoneNumber, 40),
    };
    const utr = cleanText(payload.utr, 64);
    const proof = payload.proof || null;
    let reference = cleanText(payload.orderReference, 64);
    const consent = payload.consent === true || payload.consent === 'true' || payload.consent === 1 || payload.consent === '1';

    if (
      profile.respondentName.length < 2 ||
      profile.ngoName.length < 2 ||
      !profile.email.includes('@') ||
      !/^[+()\-\s\d]{7,24}$/.test(profile.phoneNumber) ||
      !/^[A-Za-z0-9][A-Za-z0-9 .\/_-]{5,63}$/.test(utr) ||
      !consent
    ) {
      return res.status(400).json({ error: 'Please complete all required fields with valid details.' });
    }

    if (!reference) {
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const randPart = crypto.randomBytes(6).toString('hex').slice(0, 10).toUpperCase();
      reference = `NGR-${dateStr}-${randPart}`;
    }
    if (!/^NGR-\d{8}-[A-F0-9]{10}$/.test(reference)) return res.status(400).json({ error: 'Invalid payment reference.' });

    const orderFile = path.join(ORDERS_DIR, `order-${reference}.json`);
    let order = jsonRead<any>(orderFile);

    // If order is already submitted for this same reference, return existing payment idempotently
    if (order && order.paymentId) {
      const existingPayment = jsonRead<any>(path.join(PAYMENTS_DIR, `payment-${order.paymentId}.json`));
      if (existingPayment) {
        return res.status(200).json({ ok: true, paymentId: order.paymentId, orderReference: reference });
      }
    }

    // Auto-create or refresh order record so paying users are never blocked
    if (!order || new Date(order.expiresAt).getTime() <= Date.now()) {
      order = {
        reference,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400 * 1000).toISOString(),
        paymentId: '',
      };
      jsonWriteAtomic(orderFile, order);
    }

    // Check duplicate UTR across different orders
    const payments = readPayments();
    for (const p of payments) {
      if (p.utr && p.utr.toLowerCase() === utr.toLowerCase() && p.orderReference !== reference) {
        return res.status(409).json({ error: 'This UPI transaction reference has already been submitted.' });
      }
    }

    const id = crypto.randomBytes(18).toString('hex');
    const now = new Date().toISOString();
    const record = {
      id,
      orderReference: reference,
      profile,
      utr,
      proof: null as any,
      consent: true,
      status: 'pending',
      reviewer: '',
      reportDueAt: '',
      reportSentAt: '',
      assessmentId: '',
      createdAt: now,
      updatedAt: now,
      verifiedAt: '',
    };

    if (proof) {
      record.proof = proofFromData(proof);
      if (!record.proof) return res.status(400).json({ error: 'Proof must be a PDF, JPEG, or PNG under 5 MB.' });
    }
    if (!jsonWriteAtomic(path.join(PAYMENTS_DIR, `payment-${id}.json`), record)) {
      if (record.proof) try { fs.unlinkSync(path.join(UPLOADS_DIR, record.proof.file)); } catch {}
      return res.status(500).json({ error: 'We could not record your payment details. Please try again.' });
    }

    order.paymentId = id;
    if (!jsonWriteAtomic(orderFile, order)) {
      try { fs.unlinkSync(path.join(PAYMENTS_DIR, `payment-${id}.json`)); } catch {}
      if (record.proof) try { fs.unlinkSync(path.join(UPLOADS_DIR, record.proof.file)); } catch {}
      return res.status(500).json({ error: 'We could not finish recording the payment. Please try again.' });
    }

    return res.status(201).json({ ok: true, paymentId: id, orderReference: reference });
  }

  if (action === 'start') {
    const paymentId = sessionPaymentId(req);
    const profile = payload.profile || {};
    const paymentFile = paymentId ? path.join(PAYMENTS_DIR, `payment-${paymentId}.json`) : '';
    const payment = paymentFile ? jsonRead<any>(paymentFile) : null;
    if (!payment || payment.status !== 'verified') return res.status(403).json({ error: 'Verified assessment access is required.' });

    // If an assessment has already been started for this payment, return existing id & key
    if (payment.assessmentId) {
      const existing = jsonRead<any>(path.join(DATA_DIR, `assessment-${payment.assessmentId}.json`));
      if (existing) {
        return res.json({ id: existing.id, revision: existing.revision || 0 });
      }
    }

    const id = crypto.randomBytes(16).toString('hex');
    const now = new Date().toISOString();
    const defaultProfile = payment?.profile || {};

    const record = {
      id,
      paymentId,
      profile: {
        respondentName: cleanText(profile.respondentName || defaultProfile.respondentName, 120),
        ngoName: cleanText(profile.ngoName || defaultProfile.ngoName, 160),
        email: cleanText(profile.email || defaultProfile.email, 160).toLowerCase(),
        phoneNumber: cleanText(profile.phoneNumber || defaultProfile.phoneNumber, 40),
        position: cleanText(profile.position || defaultProfile.position, 120),
      },
      answers: {},
      naReasons: {},
      currentStep: 0,
      completed: false,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      schemaVersion: SCHEMA_VERSION,
    };

    if (!jsonWriteAtomic(path.join(DATA_DIR, `assessment-${id}.json`), record)) {
      return res.status(500).json({ error: 'Unable to start the assessment.' });
    }

    payment.assessmentId = id;
    payment.updatedAt = now;
    if (!jsonWriteAtomic(paymentFile, payment)) {
      try { fs.unlinkSync(path.join(DATA_DIR, `assessment-${id}.json`)); } catch {}
      return res.status(500).json({ error: 'Unable to start the assessment.' });
    }

    return res.json({ id, revision: 0 });
  }

  if (action === 'save') {
    const id = validId(payload.id);
    const draft = payload.draft;
    const filePath = path.join(DATA_DIR, `assessment-${id}.json`);
    const record = jsonRead<any>(filePath);

    if (
      !draft ||
      !draft.profile ||
      !draft.answers ||
      !record ||
      record.paymentId !== sessionPaymentId(req)
    ) {
      return res.status(400).json({ error: 'Invalid assessment data.' });
    }

    if (record.completed) return res.status(409).json({ error: 'Submitted assessments cannot be edited.' });
    if (!Number.isInteger(payload.revision) || payload.revision !== (record.revision || 0)) return res.status(409).json({ error: 'This draft changed in another tab. Reload and reconcile your answers.', revision: record.revision || 0 });
    const validated = validateDraft(draft, draft.completed === true);
    if (Object.keys(validated.errors).length) return res.status(422).json({ error: 'Please correct the highlighted fields.', fields: validated.errors });
    record.profile = validated.draft!.profile;
    record.answers = validated.draft!.answers;
    record.naReasons = validated.draft!.naReasons;
    record.currentStep = Math.max(0, Math.min(120, Number(draft.currentStep) || 0));
    record.currentStepId = cleanText(draft.currentStepId, 40);
    record.completed = draft.completed === true;
    record.revision = (record.revision || 0) + 1;
    record.schemaVersion = SCHEMA_VERSION;
    record.updatedAt = new Date().toISOString();

    if (!jsonWriteAtomic(filePath, record)) {
      return res.status(500).json({ error: 'Unable to save your progress.' });
    }

    if (record.paymentId) {
      const paymentFile = path.join(PAYMENTS_DIR, `payment-${record.paymentId}.json`);
      const payment = jsonRead<any>(paymentFile);
      if (payment) {
        let changed = false;
        if (!payment.assessmentId) {
          payment.assessmentId = id;
          changed = true;
        }
        if (record.completed && !payment.submittedAt) {
          payment.submittedAt = new Date().toISOString();
          payment.reviewStatus = 'submitted';
          payment.reviewHistory = [...(payment.reviewHistory || []), { status: 'submitted', by: 'applicant', at: payment.submittedAt }];
          changed = true;
        }
        if (changed) {
          payment.updatedAt = new Date().toISOString();
          jsonWriteAtomic(paymentFile, payment);
        }
      }
    }

    const currentPayment = record.completed ? jsonRead<any>(path.join(PAYMENTS_DIR, `payment-${record.paymentId}.json`)) : null;
    return res.json({ ok: true, revision: record.revision, submittedAt: record.completed ? record.updatedAt : '', reference: currentPayment?.orderReference || '' });
  }

  return res.status(400).json({ error: 'Invalid request.' });
}

// API Routes
app.get(['/FundingReady/api.php', '/api.php', '/FundingReady/api', '/api'], handleApiGet);
app.post(['/FundingReady/api.php', '/api.php', '/FundingReady/api', '/api'], handleApiPost);
app.get(['/api/payments', '/FundingReady/api/payments'], (req, res) => { req.query.action = 'bootstrap'; return handleApiGet(req, res); });
app.get(['/api/payments/status', '/FundingReady/api/payments/status'], (req, res) => {
  const reference = cleanText(req.query.reference, 64);
  if (!/^NGR-\d{8}-[A-F0-9]{10}$/.test(reference)) return res.status(400).json({ error: 'Invalid reference.' });
  const order = jsonRead<any>(path.join(ORDERS_DIR, `order-${reference}.json`));
  const payment = order?.paymentId && jsonRead<any>(path.join(PAYMENTS_DIR, `payment-${validId(order.paymentId)}.json`));
  if (!payment || payment.orderReference !== reference) return res.status(404).json({ error: 'Reference not found.' });
  return res.json({ reference, status: payment.status, submittedAt: payment.createdAt });
});
app.post(['/api/payments', '/FundingReady/api/payments'], (req, res) => { req.body.action = 'payment'; return handleApiPost(req, res); });
app.get(['/api/assessments/bootstrap', '/FundingReady/api/assessments/bootstrap'], (req, res) => { req.query.action = 'bootstrap'; return handleApiGet(req, res); });
app.get(['/api/assessments/access', '/FundingReady/api/assessments/access'], (req, res) => { req.query.action = 'access'; return handleApiGet(req, res); });
app.post(['/api/assessments', '/FundingReady/api/assessments'], (req, res) => { req.body.action = 'start'; req.body.profile = req.body.profile || req.body; return handleApiPost(req, res); });
app.get(['/api/assessments/:id', '/FundingReady/api/assessments/:id'], (req, res) => { req.query.action = 'load'; req.query.id = req.params.id; return handleApiGet(req, res); });
app.patch(['/api/assessments/:id', '/FundingReady/api/assessments/:id'], (req, res) => { req.body.action = 'save'; req.body.id = req.params.id; return handleApiPost(req, res); });
app.delete(['/api/assessments/:id', '/FundingReady/api/assessments/:id'], (req, res) => {
  if (!csrfOk(req)) return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
  const id = validId(req.params.id);
  const file = path.join(DATA_DIR, `assessment-${id}.json`);
  const record = jsonRead<any>(file);
  if (!record || record.paymentId !== sessionPaymentId(req)) return res.status(403).json({ error: 'Access denied.' });
  if (record.completed) return res.status(409).json({ error: 'Submitted assessments cannot be cleared.' });
  record.answers = {}; record.currentStep = 0; record.revision = (record.revision || 0) + 1; record.updatedAt = new Date().toISOString();
  if (!jsonWriteAtomic(file, record)) return res.status(500).json({ error: 'Unable to clear draft.' });
  return res.json({ ok: true, revision: record.revision, assessment: record });
});

// Access Token Direct URL
app.get(['/FundingReady/access/:token', '/access/:token'], (req: Request, res: Response) => {
  return redeemAccess(req, res, cleanText(req.params.token, 128));
});

// Admin Proof View
app.get(['/FundingReady/admin/proof/:id', '/admin/proof/:id'], (req: Request, res: Response) => {
  if (!isAdminLoggedIn(req)) {
    return res.status(403).send('Unauthorized. Sign in to admin first.');
  }
  const id = validId(req.params.id);
  const payment = jsonRead<any>(path.join(PAYMENTS_DIR, `payment-${id}.json`));
  return sendProtectedFile(res, payment?.proof);
});

// Admin Panel Render
function renderAdminHtml(options: {
  isLoggedIn: boolean;
  error?: string;
  notice?: string;
  oneTimeLink?: string;
  query?: string;
  filter?: string;
  req: Request;
}) {
  const { isLoggedIn, error, notice, oneTimeLink, query = '', filter = 'all', req } = options;
  const settings = paymentSettings();
  const records = readPayments();
  const assessments = readAssessments();

  const filteredRecords = records.filter((r) => {
    const prof = r.profile || {};
    const text = [prof.ngoName, prof.respondentName, prof.email, r.utr, r.orderReference]
      .join(' ')
      .toLowerCase();
    const matchesQuery = !query || text.includes(query.toLowerCase());
    const status = r.status || 'pending';
    const notSent = !r.reportSentAt;
    const matchesFilter =
      filter === 'all' ||
      filter === status ||
      (filter === 'report_pending' && notSent);
    return matchesQuery && matchesFilter;
  });

  const csrfToken = req.cookies['ngo_compass_admin_csrf'] || randomToken(16);

  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NGO Compass Admin</title><script src="/FundingReady/qrcode.js" defer></script><style>
:root{--ink:#102018;--muted:#526158;--green:#0b5132;--green2:#126b42;--soft:#eaf3ed;--line:#d7e2da}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(circle at 5% 0,#dff2e4,transparent 28%),#f5f8f5;color:var(--ink);font:16px Arial,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:42px 22px}
.card{background:#fff;border:1px solid var(--line);border-radius:22px;padding:30px;box-shadow:0 20px 60px rgba(6,44,28,.1)}
h1{font-size:clamp(30px,5vw,52px);line-height:1;margin:18px 0 12px;letter-spacing:-.05em}
h2{font-size:21px;margin:28px 0 10px}
p{line-height:1.55}
.muted,.help{color:var(--muted)}
.eyebrow{color:var(--green2);font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
.header{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;margin-bottom:30px}
.header img,.login img{display:block;width:180px;height:auto}
.button,button{border:0;border-radius:10px;padding:13px 18px;background:var(--green);color:#fff;font:inherit;font-weight:700;cursor:pointer}
.button.secondary,button.secondary{background:#fff;color:var(--green);border:1px solid #b7cfc0}
.button.warn,button.warn{background:#805d08}
.login{max-width:480px;margin:8vh auto}
.login h1{font-size:40px}
label{display:block;margin:16px 0 7px;font-weight:700}
input,select,textarea{box-sizing:border-box;width:100%;padding:13px;border:1px solid #b7cfc0;border-radius:10px;font:inherit;color:var(--ink);background:#fff}
textarea{resize:vertical}
.error{padding:12px 14px;border-radius:10px;color:#8a2824;background:#fff0ed;font-weight:700}
.notice{padding:16px;border-radius:12px;color:#14552f;background:#e6f6ea;border:1px solid #b7d9c1}
.access-link{margin:20px 0;padding:18px;border-radius:13px;background:#ecf8ef;border:1px solid #b7d9c1}
.access-link input{margin:10px 0;font-size:13px;font-weight:600}
.settings{display:grid;grid-template-columns:.9fr 1.1fr;gap:28px;margin:24px 0 44px;padding:24px;border-radius:18px;background:linear-gradient(145deg,var(--soft),#fff);border:1px solid var(--line)}
.toolbar{display:flex;justify-content:space-between;align-items:end;gap:20px;margin:34px 0 16px}
.toolbar form{display:flex;gap:8px}
.toolbar form input,.toolbar form select{width:auto;min-width:170px}
.row{border-top:1px solid #e1ebe4;padding:18px 0}
.row summary{cursor:pointer;display:flex;justify-content:space-between;gap:20px;align-items:flex-start}
.row summary strong,.row summary span{display:block}
.row summary span{margin-top:5px;font-size:13px;color:var(--muted)}
.manual-badge{display:inline-block;margin-left:8px;padding:3px 7px;border-radius:999px;color:#805d08;background:#fbefd0;font-size:11px;font-weight:700;vertical-align:middle}
.status{padding:5px 9px;border-radius:8px;font-size:12px;font-weight:700;white-space:nowrap}
.pending{color:#755507;background:#fbefd0}
.verified{color:#056037;background:#dff2e5}
.details{padding:18px 0 2px}
.meta{color:var(--muted);font-size:13px}
.payment-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:13px;margin:18px 0}
.payment-grid>div{padding:13px;border-radius:11px;background:var(--soft)}
.payment-grid span,.payment-grid strong{display:block}
.payment-grid span{margin-bottom:6px;color:var(--muted);font-size:12px}
.payment-grid strong{overflow-wrap:anywhere}
.actions{display:flex;align-items:end;flex-wrap:wrap;gap:12px}
.actions>div{min-width:180px;flex:1}
.actions button{align-self:end}
.answer{display:grid;grid-template-columns:1fr auto;gap:20px;padding:10px 0;border-top:1px solid #edf3ef}
.answer strong{font-size:13px}
.yes{color:#087241}
.no{color:#a2322a}
.not{color:#75641c}
.empty{color:#84928a;font-weight:500}
.report-sent{display:inline-flex;gap:8px;align-items:center;margin-top:17px;color:var(--muted);font-size:13px}
.report-sent input{width:17px;height:17px;accent-color:var(--green)}
.section-title{margin-top:52px;padding-top:30px;border-top:1px solid var(--line)}
.qr-preview{max-width:180px;margin-top:10px}
.qr-preview img{width:180px;height:180px;object-fit:contain;border:1px solid var(--line);border-radius:8px}
@media(max-width:760px){
  .wrap{padding:20px 12px}
  .card{padding:22px 18px;border-radius:18px}
  .header,.toolbar,.toolbar form,.row summary{display:block}
  .header form,.toolbar form>*{width:100%;margin-top:10px}
  .settings{grid-template-columns:1fr;padding:18px}
  .payment-grid{grid-template-columns:1fr 1fr}
  .answer{display:block}
  .answer strong{display:block;margin-top:5px}
  .actions>div{min-width:100%}
}
</style></head><body>`;

  if (!isLoggedIn) {
    return `${head}<main class="wrap"><section class="card login"><img src="/FundingReady/ngo-compass-logo.png" alt="NGO Compass"><p class="eyebrow">Private workspace</p><h1>Admin sign in</h1><p class="muted">Review payments, issue assessment access and track reports.</p>${
      error ? `<p class="error">${escapeHtml(error)}</p>` : ''
    }<form method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><label for="email">Email</label><input id="email" type="email" name="email" autocomplete="username" required><label for="password">Password</label><input id="password" type="password" name="password" autocomplete="current-password" required><p><button name="login" value="1">Sign in</button></p></form></section></main></body></html>`;
  }

  let body = `${head}<main class="wrap"><section class="card"><header class="header"><div><img src="/FundingReady/ngo-compass-logo.png" alt="NGO Compass"><p class="eyebrow">Private workspace</p><h1>Funding readiness operations</h1><p class="muted">${records.length} payment submission(s) · ${assessments.length} assessment response(s)</p></div><form method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><button class="secondary" name="logout" value="1">Log out</button></form></header>`;

  if (error) body += `<p class="error">${escapeHtml(error)}</p>`;
  if (notice) body += `<p class="notice">${escapeHtml(notice)}</p>`;
  if (oneTimeLink) {
    body += `<div class="access-link"><strong>One-time assessment access link — copy it now</strong><input id="access-link" readonly value="${escapeHtml(oneTimeLink)}" onclick="this.select()"><button type="button" onclick="navigator.clipboard&&navigator.clipboard.writeText(document.getElementById('access-link').value)">Copy link</button><p class="help">This link is shown once and is exchanged for a secure session when opened.</p></div>`;
  }

  body += `<section class="settings"><div><p class="eyebrow">Manual access</p><h2>Create assessment link without payment</h2><p class="help">Use for approved complimentary or offline cases. This creates a verified access record without a fake UTR or payment proof.</p></div><form method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><label for="manualNgoName">NGO name</label><input id="manualNgoName" name="manualNgoName" required placeholder="Organisation name"><label for="manualRespondentName">Respondent name <span>(optional)</span></label><input id="manualRespondentName" name="manualRespondentName"><label for="manualEmail">Email <span>(optional)</span></label><input id="manualEmail" name="manualEmail" type="email"><label for="manualPhoneNumber">Phone <span>(optional)</span></label><input id="manualPhoneNumber" name="manualPhoneNumber" type="tel"><p><button name="create_manual" value="1">Create manual assessment link</button></p></form></section>`;

  body += `<section class="settings"><div><p class="eyebrow">Payment settings</p><h2>UPI details shown to applicants</h2><p class="help">Configure a payee name and at least one UPI ID, phone number or QR image. Until then, the public payment page remains safely unavailable.</p></div><form method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><label for="payeeName">Payee name</label><input id="payeeName" name="payeeName" value="${escapeHtml(settings.payeeName)}"><label for="upiId">UPI ID</label><input id="upiId" name="upiId" value="${escapeHtml(settings.upiId)}" placeholder="name@bank"><label for="upiPhone">UPI-linked phone number</label><input id="upiPhone" name="upiPhone" value="${escapeHtml(settings.upiPhone)}"><label for="qrDataUrlInput">QR Data URL (optional)</label><input id="qrDataUrlInput" name="qrDataUrl" value="${escapeHtml(settings.qrDataUrl)}" placeholder="data:image/png;base64,..."><p class="help">A payment QR can also be generated from the UPI ID below.</p><div class="actions"><button type="button" class="secondary" id="generate-qr">Generate QR from UPI ID</button><button name="save_settings" value="1">Save payment settings</button></div><div class="qr-preview" id="qr-preview">${settings.qrDataUrl ? `<img src="${escapeHtml(settings.qrDataUrl)}" alt="Configured payment QR">` : ''}</div></form></section>`;

  body += `<div class="toolbar"><div><p class="eyebrow">Payment queue</p><h2>Payment submissions</h2></div><form method="get"><input name="q" value="${escapeHtml(query)}" placeholder="Search NGO, name or UTR"><select name="status"><option value="all"${filter === 'all' ? ' selected' : ''}>All statuses</option><option value="pending"${filter === 'pending' ? ' selected' : ''}>Pending verification</option><option value="verified"${filter === 'verified' ? ' selected' : ''}>Verified</option><option value="report_pending"${filter === 'report_pending' ? ' selected' : ''}>Report not sent</option></select><button>Filter</button></form></div>`;

  if (filteredRecords.length === 0) {
    body += `<p class="muted">No matching payment submissions.</p>`;
  }

  for (const record of filteredRecords) {
    const prof = record.profile || {};
    const id = record.id || '';
    const status = record.status || 'pending';
    const manual = Boolean(record.manual) || String(record.orderReference || '').startsWith('MANUAL-');
    const proof = record.proof || {};

    body += `<details class="row"><summary><div><strong>${escapeHtml(prof.ngoName || 'Unnamed NGO')}${manual ? ' <span class="manual-badge">Manual access</span>' : ''}</strong><span>${escapeHtml(prof.respondentName || '')} · ${escapeHtml(prof.email || '')} · Ref ${escapeHtml(record.orderReference || '')} · ${manual ? 'No payment recorded' : `UTR ${escapeHtml(record.utr || '')}`}</span></div><span class="status ${status === 'verified' ? 'verified' : 'pending'}">${manual ? 'Manual · Verified' : status === 'verified' ? 'Verified' : 'Pending'}</span></summary><div class="details"><p class="meta">Created ${escapeHtml(record.createdAt || '')} · Updated ${escapeHtml(record.updatedAt || '')}</p><div class="payment-grid"><div><span>Mobile</span><strong>${escapeHtml(prof.phoneNumber || '')}</strong></div><div><span>${manual ? 'Payment' : 'Proof'}</span>${manual ? '<strong>Manual access — no payment recorded</strong>' : proof.file ? `<a href="/FundingReady/admin/proof/${escapeHtml(id)}">Download proof</a>` : '<strong>Not provided</strong>'}</div><div><span>Verified at</span><strong>${escapeHtml(record.verifiedAt || '—')}</strong></div><div><span>Payment ID</span><strong>${escapeHtml(id)}</strong></div></div>`;

    if (status === 'pending') {
      body += `<form method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="payment_id" value="${escapeHtml(id)}"><button name="verify_payment" value="1">Verify payment and create access link</button></form>`;
      if (status === 'pending') body += `<form method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="payment_id" value="${escapeHtml(id)}"><button class="secondary" name="reject_payment" value="1">Reject payment submission</button></form>`;
    } else if (status === 'verified') {
      body += `<form method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="payment_id" value="${escapeHtml(id)}"><button class="secondary" name="reissue_access" value="1">Re-issue access link</button></form>`;
    }

    body += `<form method="post" class="actions" style="margin-top:18px"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="payment_id" value="${escapeHtml(id)}"><div><label>Reviewer</label><input name="reviewer" value="${escapeHtml(record.reviewer || '')}" placeholder="Assign reviewer"></div><div><label>Evidence review</label><select name="evidenceStatus"><option value="not_started">Not started</option><option value="in_progress"${record.evidenceStatus === 'in_progress' ? ' selected' : ''}>In progress</option><option value="complete"${record.evidenceStatus === 'complete' ? ' selected' : ''}>Complete</option></select></div><div><label>Review state</label><select name="reviewStatus"><option value="submitted">Submitted</option><option value="in_review"${record.reviewStatus === 'in_review' ? ' selected' : ''}>In review</option><option value="report_ready"${record.reviewStatus === 'report_ready' ? ' selected' : ''}>Report ready</option><option value="delivered"${record.reviewStatus === 'delivered' ? ' selected' : ''}>Delivered</option></select></div><div><label>Reviewer score (optional)</label><input type="number" min="0" max="100" name="reviewerScore" value="${escapeHtml(record.reviewerScore ?? '')}"></div><div><label>Internal notes</label><textarea name="internalNotes" maxlength="4000">${escapeHtml(record.internalNotes || '')}</textarea></div><button name="update_payment" value="1">Save review</button></form><div><label for="report-${escapeHtml(id)}">Reviewed PDF report</label><input id="report-${escapeHtml(id)}" type="file" accept="application/pdf" data-report="${escapeHtml(id)}"><button type="button" class="upload-report" data-payment="${escapeHtml(id)}">Upload PDF</button>${record.report?.file ? `<a href="/FundingReady/admin/report/${escapeHtml(id)}">Download current report</a>` : ''}</div><p class="meta">${escapeHtml(record.reviewStatus || 'Awaiting submission')} · ${escapeHtml(record.report?.uploadedAt || '')}</p></div></details>`;
  }

  body += `<section class="section-title"><p class="eyebrow">Assessment responses</p><h2>${assessments.length} saved assessment${assessments.length === 1 ? '' : 's'}</h2></section>`;

  if (assessments.length === 0) {
    body += `<p class="muted">No assessment responses yet.</p>`;
  }

  for (const record of assessments) {
    const prof = record.profile || {};
    const answers = record.answers || {};
    const complete = Boolean(record.completed);

    const websiteUrl = record.websiteUrl || answers.q65a || '';
    const driveLink = record.driveLink || answers.driveLink || '';
    const evidenceUrl = /^https:\/\/[A-Za-z0-9.-]+(?:\/|$)/.test(prof.evidenceUrl || '') ? prof.evidenceUrl : '';

    body += `<details class="row"><summary><div><strong>${escapeHtml(prof.ngoName || 'Unnamed NGO')}</strong><span>${escapeHtml(prof.respondentName || '')} · ${escapeHtml(prof.position || '')} · ${escapeHtml(prof.email || '')}</span></div><span class="status ${complete ? 'verified' : 'pending'}">${complete ? 'Complete' : 'In progress'}</span></summary><div class="details"><p class="meta">Last saved ${escapeHtml(record.updatedAt || '')} · ${Object.keys(answers).filter(k => k.startsWith('q') && !k.endsWith('a')).length}/89 compliance checks answered</p>`;

    if (websiteUrl || driveLink || evidenceUrl) {
      body += `<div class="payment-grid" style="margin-bottom:16px">`;
      if (/^https:\/\/[A-Za-z0-9.-]+(?:\/|$)/.test(websiteUrl)) {
        body += `<div><span>Website URL</span><strong><a href="${escapeHtml(websiteUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(websiteUrl)} ↗</a></strong></div>`;
      }
      if (driveLink) {
        body += `<div><span>Legacy evidence link</span><strong>Ask applicant to confirm restricted access</strong></div>`;
      }
      if (evidenceUrl) body += `<div><span>Restricted evidence link</span><strong><a href="${escapeHtml(evidenceUrl)}" target="_blank" rel="noopener noreferrer">Open evidence ↗</a></strong></div>`;
      body += `</div>`;
    }

    for (const group of questionsData) {
      body += `<h2>${escapeHtml(group.title || '')}</h2>`;
      for (const question of group.questions || []) {
        const answer = answers[question.id] || '';
        const cls = answer === 'yes' ? 'yes' : answer === 'no' ? 'no' : answer ? 'not' : 'empty';
        body += `<div class="answer"><span>${escapeHtml(question.label || '')}</span><strong class="${cls}">${escapeHtml(answerLabel(answer))}</strong></div>`;
      }
    }

    body += `</div></details>`;
  }

  body += `</section></main><script>
document.getElementById("generate-qr")?.addEventListener("click", () => {
  const id = document.getElementById("upiId")?.value.trim();
  const pn = document.getElementById("payeeName")?.value.trim();
  const out = document.getElementById("qr-preview");
  const field = document.getElementById("qrDataUrlInput");
  if (!id || !window.QRCode?.toDataURL) {
    if (out) out.textContent = "Enter a UPI ID and ensure QR generation is available.";
    return;
  }
  window.QRCode.toDataURL(\`upi://pay?pa=\${encodeURIComponent(id)}&pn=\${encodeURIComponent(pn || "NGO Compass")}&am=1999&cu=INR\`, {
    width: 180,
    margin: 2,
    color: { dark: "#063d25", light: "#ffffff" }
  }).then((src) => {
    if (field) field.value = src;
    if (out) out.innerHTML = \`<img src="\${src}" alt="Generated payment QR">\`;
  });
});
document.querySelectorAll(".upload-report").forEach(button => button.addEventListener("click", async () => {
  const id = button.dataset.payment;
  const file = document.getElementById("report-" + id)?.files?.[0];
  if (!file || file.type !== "application/pdf" || file.size > 10000000) { alert("Choose a PDF under 10 MB."); return; }
  button.disabled = true;
  try {
    const response = await fetch("/FundingReady/admin/report/" + id, {method: "POST", credentials: "same-origin", headers: {"content-type": "application/pdf", "x-csrf-token": "${escapeHtml(csrfToken)}"}, body: file});
    if (!response.ok) throw Error(await response.text());
    location.reload();
  } catch (error) { alert(error.message || "Upload failed."); button.disabled = false; }
}));
</script></body></html>`;

  return body;
}

// Admin Route Handlers
function handleAdminGet(req: Request, res: Response) {
  const isLoggedIn = isAdminLoggedIn(req);

  const csrf = randomToken(24);
  setAppCookie(res, req, 'ngo_compass_admin_csrf', csrf, 7200 * 1000, true);
  req.cookies['ngo_compass_admin_csrf'] = csrf;

  const query = cleanText(req.query.q, 120);
  const filter = cleanText(req.query.status, 30) || 'all';

  const html = renderAdminHtml({
    isLoggedIn,
    error: !isLoggedIn && (!ADMIN_EMAIL || !ADMIN_PASSWORD) ? 'Admin login is unavailable: configure ADMIN_EMAIL and ADMIN_PASSWORD.' : '',
    query,
    filter,
    req,
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(html);
}

function handleAdminPost(req: Request, res: Response) {
  if (!adminCsrfOk(req)) return res.status(403).send('Invalid or missing CSRF token. Reload the admin page.');
  let error = '';
  let notice = '';
  let oneTimeLink = '';

  const body = req.body || {};

  if ('login' in body || body.action === 'login') {
    const email = cleanText(body.email, 160).toLowerCase();
    const password = String(body.password || '');
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return res.status(503).send('Admin login is unavailable: configure ADMIN_EMAIL and ADMIN_PASSWORD.');
    const address = req.ip || 'unknown';
    const attempt = loginFailures.get(address) || { count: 0, until: 0 };
    if (attempt.until > Date.now()) return res.status(429).send('Too many login attempts. Try again later.');
    if (email === ADMIN_EMAIL && safeEqual(password, ADMIN_PASSWORD)) {
      destroyAdminSession(req, res);
      loginFailures.delete(address);
      createAdminSession(res, req);
      return res.redirect('/FundingReady/admin');
    } else {
      attempt.count++;
      if (attempt.count >= 5) { attempt.count = 0; attempt.until = Date.now() + 15 * 60_000; }
      loginFailures.set(address, attempt);
      error = 'Incorrect email or password.';
      const html = renderAdminHtml({ isLoggedIn: false, error, req });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(401).send(html);
    }
  }

  if ('logout' in body || body.action === 'logout') {
    destroyAdminSession(req, res);
    return res.redirect('/FundingReady/admin');
  }

  if (!isAdminLoggedIn(req)) {
    return res.redirect('/FundingReady/admin');
  }

  if ('save_settings' in body || body.action === 'save_settings') {
    const current = paymentSettings();
    const nextSettings = {
      payeeName: cleanText(body.payeeName, 160),
      upiId: cleanText(body.upiId, 160),
      upiPhone: cleanText(body.upiPhone, 40),
      qrDataUrl: cleanText(body.qrDataUrl, 2000000),
      updatedAt: new Date().toISOString(),
    };
    if (jsonWriteAtomic(SETTINGS_FILE, nextSettings)) {
      notice = 'Payment settings saved.';
    } else {
      error = 'Unable to save payment settings.';
    }
  }

  if ('create_manual' in body || body.action === 'create_manual') {
    const ngoName = cleanText(body.manualNgoName, 160);
    const respondentName = cleanText(body.manualRespondentName, 120);
    const email = cleanText(body.manualEmail, 160).toLowerCase();
    const phoneNumber = cleanText(body.manualPhoneNumber, 40);

    if (ngoName.length < 2) {
      error = 'Please enter an NGO name.';
    } else {
      const id = crypto.randomBytes(18).toString('hex');
      const reference = `MANUAL-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
      const token = randomToken(32);
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 2592000 * 1000).toISOString();

      const paymentRecord = {
        id,
        orderReference: reference,
        profile: { respondentName, ngoName, email, phoneNumber },
        utr: '',
        proof: { name: '', type: '', size: 0, data: '' },
        consent: false,
        status: 'verified',
        reviewer: '',
        reportDueAt: '',
        reportSentAt: '',
        assessmentId: '',
        createdAt: now,
        updatedAt: now,
        verifiedAt: now,
        manual: true,
      };

      const accessRecord = {
        version: 2,
        paymentId: id,
        tokenHash: hashToken(token),
        createdAt: now,
        expiresAt,
        usedAt: '',
      };

      jsonWriteAtomic(path.join(ACCESS_DIR, `token-${hashToken(token)}.json`), accessRecord);
      jsonWriteAtomic(path.join(PAYMENTS_DIR, `payment-${id}.json`), paymentRecord);

      oneTimeLink = `${getBaseUrl(req)}/FundingReady/access/${token}`;
      notice = 'Manual assessment link created. No payment or UTR was recorded.';
    }
  }

  if ('verify_payment' in body || body.action === 'verify_payment' || 'reissue_access' in body || body.action === 'reissue_access') {
    const id = validId(body.payment_id);
    const paymentFile = path.join(PAYMENTS_DIR, `payment-${id}.json`);
    const record = jsonRead<any>(paymentFile);

    if (!record) {
      error = 'Payment record not found.';
    } else if ('verify_payment' in body && record.status !== 'pending') {
      error = 'Only pending payments may be verified.';
    } else if ('reissue_access' in body && record.status !== 'verified') {
      error = 'Verify the payment before issuing access.';
    } else {
      const token = randomToken(32);
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 2592000 * 1000).toISOString();

      const accessRecord = {
        version: 2,
        paymentId: id,
        tokenHash: hashToken(token),
        createdAt: now,
        expiresAt,
        usedAt: '',
      };

      revokeAccessLinks(id);
      jsonWriteAtomic(path.join(ACCESS_DIR, `token-${hashToken(token)}.json`), accessRecord);

      record.status = 'verified';
      if (!record.verifiedAt) record.verifiedAt = now;
      record.updatedAt = now;
      jsonWriteAtomic(paymentFile, record);

      oneTimeLink = `${getBaseUrl(req)}/FundingReady/access/${token}`;
      notice = 'Access link generated. Copy the one-time link below and send it to the applicant.';
    }
  }

  if ('reject_payment' in body || body.action === 'reject_payment') {
    const id = validId(body.payment_id);
    const file = path.join(PAYMENTS_DIR, `payment-${id}.json`);
    const record = jsonRead<any>(file);
    if (!record || record.status !== 'pending') error = 'Only pending payments may be rejected.';
    else { record.status = 'rejected'; record.updatedAt = new Date().toISOString(); if (jsonWriteAtomic(file, record)) notice = 'Submission rejected.'; else error = 'Unable to update payment.'; }
  }

  if ('update_payment' in body || body.action === 'update_payment') {
    const id = validId(body.payment_id);
    const paymentFile = path.join(PAYMENTS_DIR, `payment-${id}.json`);
    const record = jsonRead<any>(paymentFile);

    if (!record) {
      error = 'Payment record not found.';
    } else {
      record.reviewer = cleanText(body.reviewer, 120);
      record.evidenceStatus = ['not_started','in_progress','complete'].includes(body.evidenceStatus) ? body.evidenceStatus : 'not_started';
      record.internalNotes = cleanText(body.internalNotes, 4000);
      const score = body.reviewerScore === '' ? null : Number(body.reviewerScore);
      if (score !== null && (!Number.isInteger(score) || score < 0 || score > 100)) error = 'Score must be between 0 and 100.';
      else record.reviewerScore = score;
      const nextStatus = cleanText(body.reviewStatus, 32);
      const allowedStatus = ['submitted', 'in_review', 'report_ready', 'delivered'];
      if (!allowedStatus.includes(nextStatus)) error = 'Invalid review state.';
      else if (!record.submittedAt && nextStatus !== 'submitted') error = 'Wait for assessment submission.';
      else if (['report_ready', 'delivered'].includes(nextStatus) && !record.report?.file) error = 'Upload the reviewed PDF first.';
      else if (nextStatus === 'delivered' && !(record.downloadHistory || []).length) error = 'Delivered is recorded after applicant download.';
      else if (record.reviewStatus !== nextStatus) {
        record.reviewStatus = nextStatus;
        record.reviewHistory = [...(record.reviewHistory || []), { status: nextStatus, by: ADMIN_EMAIL, at: new Date().toISOString() }];
      }
      record.updatedAt = new Date().toISOString();
      if (!error && jsonWriteAtomic(paymentFile, record)) notice = 'Review updated.';
      else if (!error) error = 'Unable to save review.';
    }
  }

  const html = renderAdminHtml({
    isLoggedIn: true,
    error,
    notice,
    oneTimeLink,
    req,
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(html);
}

app.get(['/FundingReady/admin', '/FundingReady/admin/', '/admin', '/admin/'], handleAdminGet);
app.post(['/FundingReady/admin', '/FundingReady/admin/', '/admin', '/admin/'], handleAdminPost);
app.post(['/FundingReady/admin/report/:id', '/admin/report/:id'], express.raw({ type: 'application/pdf', limit: '10mb' }), (req, res) => {
  if (!isAdminLoggedIn(req) || !adminCsrfOk(req)) return res.status(403).send('Access denied.');
  const id = validId(req.params.id);
  const paymentFile = path.join(PAYMENTS_DIR, `payment-${id}.json`);
  const payment = jsonRead<any>(paymentFile);
  if (!payment || !payment.submittedAt) return res.status(404).send('Submitted assessment not found.');
  const bytes = req.body;
  if (!Buffer.isBuffer(bytes) || bytes.length < 5 || bytes.length > 10_000_000 || bytes.subarray(0,5).toString() !== '%PDF-') return res.status(400).send('Only PDF reports under 10 MB are accepted.');
  const file = `${crypto.randomBytes(20).toString('hex')}.pdf`;
  try { fs.writeFileSync(path.join(UPLOADS_DIR, file), bytes, { flag: 'wx', mode: 0o600 }); }
  catch { return res.status(500).send('Upload failed.'); }
  const prior = payment.report?.file;
  payment.report = { file, type: 'application/pdf', size: bytes.length, uploadedAt: new Date().toISOString(), uploadedBy: ADMIN_EMAIL };
  payment.reviewStatus = 'report_ready';
  payment.reviewHistory = [...(payment.reviewHistory || []), { status: 'report_ready', by: ADMIN_EMAIL, at: payment.report.uploadedAt }];
  if (!jsonWriteAtomic(paymentFile, payment)) { fs.unlinkSync(path.join(UPLOADS_DIR, file)); return res.status(500).send('Upload failed.'); }
  if (prior && /^[a-f0-9]{40}\.pdf$/.test(prior)) try { fs.unlinkSync(path.join(UPLOADS_DIR, prior)); } catch {}
  return res.json({ ok: true });
});
app.get(['/FundingReady/admin/report/:id', '/admin/report/:id'], (req, res) => {
  if (!isAdminLoggedIn(req)) return res.status(403).send('Access denied.');
  const payment = jsonRead<any>(path.join(PAYMENTS_DIR, `payment-${validId(req.params.id)}.json`));
  return sendProtectedFile(res, payment?.report);
});
app.get(['/api/assessments/:id/report', '/FundingReady/api/assessments/:id/report'], (req, res) => {
  const assessment = jsonRead<any>(path.join(DATA_DIR, `assessment-${validId(req.params.id)}.json`));
  if (!assessment || assessment.paymentId !== sessionPaymentId(req) || !assessment.completed) return res.status(403).send('Access denied.');
  const paymentFile = path.join(PAYMENTS_DIR, `payment-${assessment.paymentId}.json`);
  const payment = jsonRead<any>(paymentFile);
  if (!payment?.report?.file || !/^[a-f0-9]{40}\.pdf$/.test(payment.report.file)) return res.status(404).send('Report is not ready.');
  const file = path.join(UPLOADS_DIR, payment.report.file);
  if (!fs.existsSync(file)) return res.status(404).send('Report is not ready.');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${payment.report.file}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(file, error => {
    if (error) { if (!res.headersSent) res.status(500).end(); return; }
    payment.downloadHistory = [...(payment.downloadHistory || []), { at: new Date().toISOString(), by: 'applicant' }];
    if (payment.reviewStatus !== 'delivered') {
      payment.reviewStatus = 'delivered';
      payment.reviewHistory = [...(payment.reviewHistory || []), { status: 'delivered', by: 'applicant download', at: new Date().toISOString() }];
    }
    jsonWriteAtomic(paymentFile, payment);
  });
});

// Static assets
app.use('/FundingReady/assets', express.static(path.join(SITE_DIR, 'assets')));
app.use('/assets', express.static(path.join(SITE_DIR, 'assets')));

// Static files in site
app.use('/FundingReady', express.static(SITE_DIR, { index: false }));
app.use(express.static(SITE_DIR, { index: false }));

// HTML entry points for SPA and landing page
function sendIndexHtml(req: Request, res: Response) {
  let csrf = req.cookies['ngo_compass_csrf'];
  if (!csrf || typeof csrf !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(csrf)) {
    csrf = randomToken(24);
    setAppCookie(res, req, 'ngo_compass_csrf', csrf, 86400 * 1000, false);
  }
  const indexPath = path.join(SITE_DIR, 'index.html');
  res.sendFile(indexPath);
}

// Support both with and without trailing slashes without redirect loops
app.get([
  '/',
  '/FundingReady',
  '/FundingReady/',
  '/FundingReady/payment',
  '/FundingReady/payment/',
  '/FundingReady/assessment',
  '/FundingReady/assessment/',
  '/FundingReady/privacy',
  '/FundingReady/privacy/',
  '/payment',
  '/payment/',
  '/assessment',
  '/assessment/',
  '/privacy',
  '/privacy/',
], sendIndexHtml);

// SPA routing fallback
app.use((req: Request, res: Response) => {
  if (req.path.startsWith('/FundingReady')) {
    return sendIndexHtml(req, res);
  }
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(`/FundingReady${req.path}${query}`);
});

app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  const status = error?.status === 413 ? 413 : 500;
  res.status(status).json({ error: status === 413 ? 'Upload or request is too large.' : 'Request could not be processed.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Funding Ready server listening on port ${PORT}`);
});
