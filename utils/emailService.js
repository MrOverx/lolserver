const nodemailer = require('nodemailer');
const { Logger } = require('./logger');

const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
const smtpPort = Number(process.env.SMTP_PORT || 465);
const smtpSecure = String(process.env.SMTP_SECURE || 'true').toLowerCase() !== 'false';
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const smtpFrom = process.env.SMTP_FROM || smtpUser;

function isEmailConfigured() {
  return !!smtpUser && !!smtpPass;
}

const transporter = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: smtpSecure,
  auth: smtpUser && smtpPass ? { user: smtpUser, pass: smtpPass } : undefined,
  connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 5000),
  greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 5000),
  socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 10000),
});

async function sendOtpEmail(to, otp) {
  if (!isEmailConfigured()) {
    throw new Error('SMTP credentials are not configured');
  }

  const expiresSeconds = Number(process.env.OTP_EXPIRE_SECONDS || 300);
  const mailOptions = {
    from: smtpFrom,
    to,
    subject: process.env.OTP_EMAIL_SUBJECT || 'Your OmegleLOL verification code',
    text: `Your OmegleLOL verification code is ${otp}. It expires in ${expiresSeconds} seconds.\n\nIf you did not request this, please ignore this email.`,
    html: `<p>Your OmegleLOL verification code is <strong>${otp}</strong>.</p><p>This code expires in ${expiresSeconds} seconds.</p>`,
  };

  const info = await transporter.sendMail(mailOptions);
  Logger.info('email', 'OTP email sent', { to, messageId: info.messageId });
  return info;
}

module.exports = {
  sendOtpEmail,
  isEmailConfigured,
};
