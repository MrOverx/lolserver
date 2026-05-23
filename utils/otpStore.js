const crypto = require('crypto');
const { Logger } = require('./logger');

const OTP_TTL_MS = Number(process.env.OTP_EXPIRE_SECONDS ? parseInt(process.env.OTP_EXPIRE_SECONDS, 10) * 1000 : 300000);
const OTP_RESEND_INTERVAL_MS = 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;
const OTP_SECRET = process.env.OTP_SECRET || 'omeglelol-default-otp-secret';

const otpStore = new Map();

function normalizeEmail(email) {
  return String(email || '').toLowerCase().trim();
}

function createOtpCode() {
  return String(100000 + Math.floor(Math.random() * 900000));
}

function hashOtp(otp) {
  return crypto
    .createHmac('sha256', OTP_SECRET)
    .update(String(otp))
    .digest('hex');
}

async function createOtpForEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new Error('Email is required to generate an OTP');
  }

  const existing = otpStore.get(normalizedEmail);
  const now = Date.now();
  if (existing && now - existing.lastSentAt < OTP_RESEND_INTERVAL_MS) {
    const error = new Error('Please wait 60 seconds before requesting a new OTP.');
    error.code = 'OTP_RESEND_WAIT';
    error.resetTime = existing.lastSentAt + OTP_RESEND_INTERVAL_MS;
    throw error;
  }

  const otp = createOtpCode();
  const hashedOtp = hashOtp(otp);
  otpStore.set(normalizedEmail, {
    hash: hashedOtp,
    expiresAt: now + OTP_TTL_MS,
    attempts: 0,
    lastSentAt: now,
  });

  Logger.debug('otpStore', `OTP created for ${normalizedEmail}`);
  return otp;
}

async function verifyOtpForEmail(email, otp) {
  const normalizedEmail = normalizeEmail(email);
  const record = otpStore.get(normalizedEmail);
  if (!record) {
    return { success: false, reason: 'OTP_NOT_FOUND' };
  }

  const now = Date.now();
  if (now > record.expiresAt) {
    otpStore.delete(normalizedEmail);
    return { success: false, reason: 'OTP_EXPIRED' };
  }

  if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
    otpStore.delete(normalizedEmail);
    return { success: false, reason: 'OTP_TOO_MANY_ATTEMPTS' };
  }

  const match = record.hash === hashOtp(String(otp));
  record.attempts += 1;

  if (!match) {
    otpStore.set(normalizedEmail, record);
    return { success: false, reason: 'OTP_INVALID' };
  }

  otpStore.delete(normalizedEmail);
  return { success: true };
}

function cleanupExpiredOtps() {
  const now = Date.now();
  for (const [email, record] of otpStore.entries()) {
    if (record.expiresAt <= now) {
      otpStore.delete(email);
      Logger.debug('otpStore', `Expired OTP removed for ${email}`);
    }
  }
}

function startOtpCleanup() {
  setInterval(cleanupExpiredOtps, 60 * 1000);
}

module.exports = {
  createOtpForEmail,
  verifyOtpForEmail,
  startOtpCleanup,
};
