/**
 * Email Service — OTP + transactional email via Nodemailer
 *
 * Nodemailer is lazy-loaded so a broken installation never
 * crashes the server at startup. If email is not configured
 * or nodemailer fails to load, all send functions throw a
 * descriptive error instead of killing the process.
 */

const { Logger } = require('./logger');

const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
const smtpPort = Number(process.env.SMTP_PORT || 465);
const smtpSecure =
  String(process.env.SMTP_SECURE || 'true').toLowerCase() !== 'false';
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const smtpFrom = process.env.SMTP_FROM || smtpUser;
const appName = process.env.APP_NAME || 'SLYXY';
const smtpFromName = process.env.SMTP_FROM_NAME || appName;

/** @returns {boolean} */
function isEmailConfigured() {
  return !!smtpUser && !!smtpPass;
}

// Lazy singleton — only created on first send attempt
let _transporter = null;

/**
 * Get (or create) the nodemailer transporter.
 * Throws a clear error if nodemailer cannot be loaded.
 * @returns {import('nodemailer').Transporter}
 */
function _getTransporter() {
  if (_transporter) return _transporter;

  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (err) {
    throw new Error(
      `nodemailer is not installed or is broken: ${err.message}. ` +
        'Run: npm install nodemailer@6 on the server.'
    );
  }

  _transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    auth:
      smtpUser && smtpPass ? { user: smtpUser, pass: smtpPass } : undefined,
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 5000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 5000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 10000),
  });

  Logger.info('email', 'Nodemailer transporter created', {
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    user: smtpUser || '(not set)',
  });

  return _transporter;
}

/**
 * Send an OTP verification email.
 * @param {string} to   - Recipient address
 * @param {string} otp  - One-time password string
 */
async function sendOtpEmail(to, otp) {
  if (!isEmailConfigured()) {
    throw new Error('SMTP credentials are not configured (SMTP_USER / SMTP_PASS missing)');
  }

  const transporter = _getTransporter();
  const expiresSeconds = Number(process.env.OTP_EXPIRE_SECONDS || 300);
  const fromAddress =
    smtpFromName && smtpFrom ? `${smtpFromName} <${smtpFrom}>` : smtpFrom;

  const mailOptions = {
    from: fromAddress,
    to,
    subject:
      process.env.OTP_EMAIL_SUBJECT || `Your ${appName} verification code`,
    text:
      `Your ${appName} verification code is ${otp}. ` +
      `It expires in ${expiresSeconds} seconds.\n\n` +
      `If you did not request this, please ignore this email.`,
    html:
      `<p>Your <strong>${appName}</strong> verification code is ` +
      `<strong>${otp}</strong>.</p>` +
      `<p>This code expires in ${expiresSeconds} seconds.</p>`,
  };

  const info = await transporter.sendMail(mailOptions);
  Logger.info('email', 'OTP email sent', { to, messageId: info.messageId });
  return info;
}

module.exports = {
  sendOtpEmail,
  isEmailConfigured,
};
