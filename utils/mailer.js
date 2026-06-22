import ejs from 'ejs';
import nodemailer from 'nodemailer';
import path from 'path';

export const buildTransporter = () => {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (host && user && pass) {
    return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  }
  return {
    sendMail: async (opts) => { console.log('[DEV] sendMail mocked:', opts.subject); }
  };
};

export const renderTemplate = async (templateName, data) => {
  const tplPath = path.resolve(process.cwd(), `utils/templates/${templateName}.ejs`);
  return ejs.renderFile(tplPath, data);
};

export const sendMail = async ({ to, subject, html }) => {
  const transporter = buildTransporter();
  const from = process.env.MAIL_FROM || 'no-reply@example.com';
  const toList = Array.isArray(to) ? to.filter(Boolean) : String(to || '').split(',').map(s => s.trim()).filter(Boolean);
  const mailTo = Array.isArray(to) ? toList : toList.join(', ');
  const maskedTo = toList.map((address) => {
    const [local, domain] = String(address).split('@');
    return domain ? `${local.slice(0, 1)}***@${domain}` : '***';
  });
  console.log(`[mail] attempt to=${maskedTo.join(',')} subject=${JSON.stringify(subject || '')}`);
  try {
    const info = await transporter.sendMail({ from, to: mailTo, subject, html });
    console.log(`[mail] sent to=${maskedTo.join(',')} messageId=${info?.messageId || '(mock)'}`);
    return info;
  } catch (err) {
    console.error(`[mail] failed to=${maskedTo.join(',')} code=${err?.code || ''} message=${err?.message || err}`);
    throw err;
  }
};
